/**
 * The Yjs ⇄ Zustand bridge (PLAN.md 6a).
 *
 * The Y.Doc is the single source of truth: the store's `patient` slice is
 * just `doc.getMap("resource").toJSON()`, refreshed on every doc update, and
 * `setField` mutates Y types inside `doc.transact` (no duplicated state
 * shape). Awareness feeds the presence slice; the connection status comes
 * from the y-websocket provider; the projection rows / pending flag are
 * polled from the demo server.
 */
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { create } from "zustand";
import type { Patient } from "@yorm/fhir";

import {
  DOC_ID,
  DOC_TYPE,
  fetchProjectionPending,
  fetchRows,
  postBlurSignal,
  postFlush,
  postPolicy,
} from "./api";
import type { PolicyKind, RowsSnapshot } from "./api";
import { t } from "./i18n";
import { getFieldSpec } from "./patientFields";
import type { PatientFieldId } from "./patientFields";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface Peer {
  clientId: number;
  name: string;
  color: string;
  focusedField: string | null;
  isLocal: boolean;
}

export interface CollabState {
  status: ConnectionStatus;
  /** Materialized Patient (null until the first sync). */
  patient: Patient | null;
  peers: Peer[];
  policy: PolicyKind;
  pendingProjection: boolean;
  rows: RowsSnapshot | null;
  /** Latest aria-live announcement (presence / row updates). */
  announcement: string;
  setField(fieldId: PatientFieldId, value: string): void;
  setFocusedField(fieldId: string | null): void;
  selectPolicy(kind: PolicyKind): void;
  save(): void;
  signalBlur(): void;
}

const PRESENCE_COLORS = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
const POLL_MS = 750;

const doc = new Y.Doc();
const root = doc.getMap("resource");
let provider: WebsocketProvider | null = null;

export const useCollabStore = create<CollabState>((set, get) => ({
  status: "connecting",
  patient: null,
  peers: [],
  policy: "every-change",
  pendingProjection: false,
  rows: null,
  announcement: "",

  setField(fieldId, value) {
    const spec = getFieldSpec(fieldId);
    if (!spec) {
      return;
    }
    doc.transact(() => {
      spec.write(root, value);
    });
  },

  setFocusedField(fieldId) {
    provider?.awareness.setLocalStateField("focusedField", fieldId);
  },

  selectPolicy(kind) {
    set({ policy: kind });
    void postPolicy(kind).then(refreshProjection);
  },

  save() {
    void postFlush().then(refreshProjection);
  },

  signalBlur() {
    if (get().policy === "on-blur") {
      void postBlurSignal().then(refreshProjection);
    }
  },
}));

/** Re-polls rows + pending flag right after a policy/flush/blur action. */
async function refreshProjection(): Promise<void> {
  try {
    const [rows, pending] = await Promise.all([fetchRows(), fetchProjectionPending()]);
    applyProjection(rows, pending);
  } catch {
    // transient — the poll loop retries
  }
}

function applyProjection(rows: RowsSnapshot, pending: boolean): void {
  const state = useCollabStore.getState();
  const changed = JSON.stringify(rows) !== JSON.stringify(state.rows);
  useCollabStore.setState({
    pendingProjection: pending,
    ...(changed
      ? { rows, announcement: state.rows === null ? "" : t("announce.rowsUpdated") }
      : {}),
  });
}

function readPeers(awareness: WebsocketProvider["awareness"]): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, state] of awareness.getStates()) {
    const user = (state as { user?: { name: string; color: string } }).user;
    if (!user) {
      continue;
    }
    peers.push({
      clientId,
      name: user.name,
      color: user.color,
      focusedField: (state as { focusedField?: string | null }).focusedField ?? null,
      isLocal: clientId === doc.clientID,
    });
  }
  return peers.sort((a, b) => a.clientId - b.clientId);
}

let started = false;

/** Connects the Y.Doc, awareness, and poll loop. Idempotent (HMR-safe). */
export function startCollab(): void {
  if (started) {
    return;
  }
  started = true;

  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  provider = new WebsocketProvider(
    `${wsProtocol}//${location.host}/yorm/ws`,
    `${DOC_TYPE}/${DOC_ID}`,
    doc,
  );

  provider.awareness.setLocalState({
    user: {
      name: t("presence.userName", { n: doc.clientID % 1000 }),
      color: PRESENCE_COLORS[doc.clientID % PRESENCE_COLORS.length],
    },
    focusedField: null,
  });

  doc.on("update", () => {
    useCollabStore.setState({ patient: root.toJSON() as Patient });
  });

  provider.on("status", (event: { status: string }) => {
    useCollabStore.setState({
      status: event.status === "connected" ? "connected" : "disconnected",
    });
  });

  provider.awareness.on("change", () => {
    const previous = useCollabStore.getState().peers.length;
    const peers = readPeers(provider!.awareness);
    useCollabStore.setState({
      peers,
      ...(peers.length > previous && previous > 0
        ? { announcement: t("announce.peerJoined") }
        : peers.length < previous
          ? { announcement: t("announce.peerLeft") }
          : {}),
    });
  });
  // The local state was set before the listener attached — seed the slice.
  useCollabStore.setState({ peers: readPeers(provider.awareness) });

  const poll = async (): Promise<void> => {
    try {
      const [rows, pending] = await Promise.all([fetchRows(), fetchProjectionPending()]);
      applyProjection(rows, pending);
    } catch {
      // server briefly unavailable — retry on the next tick
    }
  };
  void poll();
  setInterval(() => void poll(), POLL_MS);
}
