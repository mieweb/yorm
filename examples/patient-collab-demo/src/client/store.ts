/**
 * The Yjs ⇄ Zustand bridge (PLAN.md 6a + 7c).
 *
 * The Y.Doc is the single source of truth: the store's `patient` slice is
 * just `doc.getMap("resource").toJSON()`, refreshed on every doc update, and
 * `setField` mutates Y types inside `doc.transact` (no duplicated state
 * shape). Awareness feeds the presence slice; the connection status comes
 * from the y-websocket provider; the projection rows / pending flag and the
 * proposals list are polled from the demo server.
 *
 * Modes (M7c): in `proposer` mode `setField` never writes Y — it debounces
 * the value into `POST /proposals` (a semantic change intent on the
 * `yorm:proposals` subtree). Switching modes reconnects the WebSocket
 * provider with `?mode=`, which the server's proposer guard enforces.
 */
import { WebsocketProvider } from "y-websocket";
import * as Y from "yjs";
import { create } from "zustand";
import type { Patient } from "@yorm/fhir";
import type { ChangeIntent } from "@yorm/yjs";

import {
  DOC_ID,
  DOC_TYPE,
  acceptProposal,
  acceptProposalAnyway,
  fetchProjectionPending,
  fetchProposals,
  fetchRows,
  postBlurSignal,
  postFlush,
  postPolicy,
  postProposal,
  rejectProposal,
  setApiMode,
} from "./api";
import type { AcceptResult, DemoMode, PolicyKind, RowsSnapshot } from "./api";
import { t } from "./i18n";
import { getFieldSpec } from "./patientFields";
import type { FieldWriteSpec, PatientFieldId } from "./patientFields";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/** Which Patient editor the left pane renders. */
export type ViewKind = "dense" | "esheet";

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
  /** Demo mode (M7c): editors write Y directly, proposers only suggest. */
  mode: DemoMode;
  /** Which Patient editor is shown (header toggle, `?view=` param). */
  view: ViewKind;
  /** The local presence name — used as the proposal actor / resolver. */
  selfName: string;
  /** All change intents of the document, polled with the rows. */
  proposals: ChangeIntent[];
  /** Latest aria-live announcement (presence / row / proposal updates). */
  announcement: string;
  setField(fieldId: PatientFieldId, value: string): void;
  /** Generalized write: editor → Y transact, proposer → debounced proposal. */
  setFieldBySpec(spec: FieldWriteSpec, value: string): void;
  setFocusedField(fieldId: string | null): void;
  selectPolicy(kind: PolicyKind): void;
  save(): void;
  signalBlur(): void;
  setMode(mode: DemoMode): void;
  setView(view: ViewKind): void;
  /** Editor review action; a stale accept resolves to `{ conflict: true }`. */
  resolveProposal(id: string, action: "accept" | "accept-anyway" | "reject"): Promise<AcceptResult>;
}

const PRESENCE_COLORS = ["#2563eb", "#db2777", "#16a34a", "#d97706", "#7c3aed", "#0891b2"];
const POLL_MS = 750;
/** Proposer keystrokes are coalesced into one POST per field. */
const PROPOSE_DEBOUNCE_MS = 400;

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
  mode: "editor",
  view: "dense",
  selfName: "",
  proposals: [],
  announcement: "",

  setField(fieldId, value) {
    const spec = getFieldSpec(fieldId);
    if (spec) {
      get().setFieldBySpec(spec, value);
    }
  },

  setFieldBySpec(spec, value) {
    if (get().mode === "proposer") {
      queueProposal(spec, value);
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

  setMode(mode) {
    if (get().mode === mode) {
      return;
    }
    set({ mode });
    setApiMode(mode);
    // Reconnect so the server sees the new `?mode=` (the proposer guard is
    // enforced per WebSocket connection).
    connectProvider(mode);
  },

  setView(view) {
    set({ view });
  },

  async resolveProposal(id, action) {
    const resolvedBy = get().selfName;
    let result: AcceptResult = { conflict: false };
    if (action === "accept") {
      result = await acceptProposal(id, resolvedBy);
    } else if (action === "accept-anyway") {
      await acceptProposalAnyway(id, resolvedBy);
    } else {
      await rejectProposal(id, resolvedBy);
    }
    await Promise.all([refreshProposals(), refreshProjection()]);
    return result;
  },
}));

/** Debounced proposer edits, one pending POST per field. */
const proposeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function queueProposal(spec: FieldWriteSpec, value: string): void {
  const existing = proposeTimers.get(spec.id);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  proposeTimers.set(
    spec.id,
    setTimeout(() => {
      proposeTimers.delete(spec.id);
      void submitProposal(spec, value);
    }, PROPOSE_DEBOUNCE_MS),
  );
}

async function submitProposal(spec: FieldWriteSpec, value: string): Promise<void> {
  const { patient, selfName } = useCollabStore.getState();
  if (!patient) {
    return;
  }
  const path = spec.proposalPath(patient);
  if (!path) {
    return; // the demo only proposes over existing elements
  }
  try {
    await postProposal({
      path,
      op: "set",
      proposedValue: spec.toProposedValue(value),
      actor: selfName,
    });
    await refreshProposals();
  } catch {
    // transient — the poll loop keeps the proposals slice fresh
  }
}

let proposalsLoaded = false;

/** Updates the proposals slice, announcing open-count transitions. */
function applyProposals(proposals: ChangeIntent[]): void {
  const state = useCollabStore.getState();
  if (JSON.stringify(proposals) === JSON.stringify(state.proposals)) {
    proposalsLoaded = true;
    return;
  }
  const openCount = (list: ChangeIntent[]): number =>
    list.filter((intent) => intent.status === "proposed").length;
  const before = openCount(state.proposals);
  const now = openCount(proposals);
  useCollabStore.setState({
    proposals,
    ...(proposalsLoaded && now > before
      ? { announcement: t("announce.proposalCreated") }
      : proposalsLoaded && now < before
        ? { announcement: t("announce.proposalResolved") }
        : {}),
  });
  proposalsLoaded = true;
}

async function refreshProposals(): Promise<void> {
  try {
    applyProposals(await fetchProposals());
  } catch {
    // transient — the poll loop retries
  }
}

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

/**
 * (Re)connects the WebSocket provider with the given mode. The Y.Doc and its
 * listeners survive reconnects; awareness state and provider listeners are
 * re-established because each provider owns its awareness instance.
 */
function connectProvider(mode: DemoMode): void {
  provider?.destroy();

  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  provider = new WebsocketProvider(
    `${wsProtocol}//${location.host}/yorm/ws`,
    `${DOC_TYPE}/${DOC_ID}`,
    doc,
    { params: { mode } },
  );

  provider.awareness.setLocalState({
    user: {
      name: useCollabStore.getState().selfName,
      color: PRESENCE_COLORS[doc.clientID % PRESENCE_COLORS.length],
    },
    focusedField: null,
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
}

/** Connects the Y.Doc, awareness, and poll loop. Idempotent (HMR-safe). */
export function startCollab(): void {
  if (started) {
    return;
  }
  started = true;

  // The initial mode can come from the URL (`/?mode=proposer`), so a second
  // window can be opened straight into proposer mode; the initial view from
  // `?view=esheet` (the dense editor is the default).
  const params = new URLSearchParams(location.search);
  const initialMode: DemoMode = params.get("mode") === "proposer" ? "proposer" : "editor";
  setApiMode(initialMode);
  useCollabStore.setState({
    mode: initialMode,
    view: params.get("view") === "esheet" ? "esheet" : "dense",
    selfName: t("presence.userName", { n: doc.clientID % 1000 }),
  });

  doc.on("update", () => {
    useCollabStore.setState({ patient: root.toJSON() as Patient });
  });

  connectProvider(initialMode);

  const poll = async (): Promise<void> => {
    try {
      const [rows, pending, proposals] = await Promise.all([
        fetchRows(),
        fetchProjectionPending(),
        fetchProposals(),
      ]);
      applyProjection(rows, pending);
      applyProposals(proposals);
    } catch {
      // server briefly unavailable — retry on the next tick
    }
  };
  void poll();
  setInterval(() => void poll(), POLL_MS);
}
