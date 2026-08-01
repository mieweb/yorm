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
import type { CollabLogEntry } from "@mieweb/ui";
import type { Patient } from "@yorm/fhir";
import type { ChangeIntent } from "@yorm/yjs";

import {
  DOC_ID,
  DOC_TYPE,
  acceptProposal,
  acceptProposalAnyway,
  fetchProjectionState,
  fetchProposals,
  fetchRows,
  fetchSql,
  postBlurSignal,
  postFlush,
  postPolicy,
  postProposal,
  rejectProposal,
  setApiMode,
} from "./api";
import type {
  AcceptResult,
  DemoMode,
  PolicyKind,
  ProjectionCommit,
  ProjectionState,
  RowsSnapshot,
  SqlLog,
} from "./api";
import { t } from "./i18n";
import type { StringKey } from "./i18n";
import { getFieldSpec } from "./patientFields";
import type { FieldWriteSpec, PatientFieldId } from "./patientFields";
import { parseDemoRole } from "../rolePolicies";
import type { DemoRole } from "../rolePolicies";

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
  /** Materialized Patient (null until the first sync). */
  patient: Patient | null;
  peers: Peer[];
  /**
   * The live WebSocket provider, re-created on every mode switch. Exposed so
   * the room-status chip can bind `useYjsCollabStatus` to the current room.
   */
  provider: WebsocketProvider | null;
  policy: PolicyKind;
  pendingProjection: boolean;
  rows: RowsSnapshot | null;
  /** The projection commits behind the most recent row change (empty until one happens). */
  sqlCommits: ProjectionCommit[];
  /** Demo mode (M7c): editors write Y directly, proposers only suggest. */
  mode: DemoMode;
  /**
   * Policy-lens role (role-security POC): WHO is connecting. Fixed per page
   * load (`?role=` param) — switching roles reloads with a fresh Y.Doc,
   * because a lens role syncs a different (redacted) server document.
   */
  role: DemoRole;
  /** Which Patient editor is shown (header toggle, `?view=` param). */
  view: ViewKind;
  /** The local presence name — used as the proposal actor / resolver. */
  selfName: string;
  /** The local presence color, shared by the avatars and the room panel. */
  selfColor: string;
  /**
   * Demo-side room events (policy switches, projection commits, suggestions,
   * local field edits) merged into the room-status log next to the Yjs
   * transport events `useYjsCollabStatus` records.
   */
  events: CollabLogEntry[];
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

/** The shared Y.Doc — exported so the room-status chip can observe it. */
export { doc as collabDoc };

export const useCollabStore = create<CollabState>((set, get) => ({
  patient: null,
  peers: [],
  provider: null,
  policy: "on-blur",
  pendingProjection: false,
  rows: null,
  sqlCommits: [],
  mode: "editor",
  role: "physician",
  view: "dense",
  selfName: "",
  selfColor: PRESENCE_COLORS[0]!,
  events: [],
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
    logEvent("patch", t("event.edited", { field: spec.id }), "local");
  },

  setFocusedField(fieldId) {
    provider?.awareness.setLocalStateField("focusedField", fieldId);
  },

  selectPolicy(kind) {
    set({ policy: kind });
    logEvent("sync", t("event.policy", { policy: t(`policy.${kind}` as StringKey) }));
    policyPosts += 1;
    void postPolicy(kind)
      .finally(() => {
        policyPosts -= 1;
      })
      .then(refreshProjection);
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

/** Newest-first cap of the demo event log (the chip shows the whole slice). */
const EVENT_LIMIT = 50;
let eventId = 0;

/** Appends a demo-side entry to the room-status log. */
function logEvent(
  kind: CollabLogEntry["kind"],
  detail: string,
  origin?: CollabLogEntry["origin"],
): void {
  const entry: CollabLogEntry = { id: `demo-${++eventId}`, at: Date.now(), kind, detail, origin };
  useCollabStore.setState((state) => ({
    events: [entry, ...state.events].slice(0, EVENT_LIMIT),
  }));
}

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
  if (proposalsLoaded) {
    logProposalChanges(state.proposals, proposals);
  }
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

/** Logs each suggestion that appeared or was resolved since the last poll. */
function logProposalChanges(before: ChangeIntent[], after: ChangeIntent[]): void {
  const previous = new Map(before.map((intent) => [intent.id, intent.status]));
  for (const intent of after) {
    const was = previous.get(intent.id);
    const path = intent.path.join(".");
    if (was === undefined) {
      logEvent("patch", t("event.proposed", { actor: intent.actor, path }));
    } else if (was !== intent.status) {
      logEvent(
        "patch",
        t("event.proposalResolved", {
          status: t(`review.status.${intent.status}` as StringKey),
          path,
        }),
      );
    }
  }
}

async function refreshProposals(): Promise<void> {
  try {
    applyProposals(await fetchProposals());
  } catch {
    // transient — the poll loop retries
  }
}

/** Re-polls rows + projection state right after a policy/flush/blur action. */
async function refreshProjection(): Promise<void> {
  try {
    const [rows, projection, sql] = await Promise.all([
      fetchRows(),
      fetchProjectionState(),
      fetchSql(lastSqlSeq),
    ]);
    applyProjection(rows, projection, sql);
  } catch {
    // transient — the poll loop retries
  }
}

/** High-water mark of the commits already pulled from `/api/sql`. */
let lastSqlSeq = 0;
/** In-flight `POST /policy` count — polls must not revert an unacked pick. */
let policyPosts = 0;
/**
 * Rows and SQL are separate requests, so a commit can land between the two —
 * commits are held here until the poll that actually sees the new rows.
 */
let bufferedCommits: ProjectionCommit[] = [];
const COMMIT_BUFFER_LIMIT = 20;

function applyProjection(rows: RowsSnapshot, projection: ProjectionState, sql: SqlLog): void {
  const state = useCollabStore.getState();
  const firstSnapshot = state.rows === null;
  const changed = JSON.stringify(rows) !== JSON.stringify(state.rows);
  lastSqlSeq = sql.seq;
  bufferedCommits = [...bufferedCommits, ...sql.commits].slice(-COMMIT_BUFFER_LIMIT);
  // The policy is document-wide server state: another window's pick — or a
  // server restart — must move this window's picker too.
  const policy = policyPosts === 0 ? projection.policy : state.policy;
  if (!changed) {
    useCollabStore.setState({ pendingProjection: projection.pending, policy });
    return;
  }
  // The seed runs before the first poll, so its SQL is history, not news.
  const commits = firstSnapshot ? [] : bufferedCommits;
  bufferedCommits = [];
  for (const commit of commits) {
    logEvent(
      "sync",
      t("event.commit", {
        statements: String(commit.statements.length),
        version: String(commit.documentVersion),
      }),
    );
  }
  useCollabStore.setState({
    pendingProjection: projection.pending,
    policy,
    rows,
    sqlCommits: commits,
    announcement: firstSnapshot ? "" : t("announce.rowsUpdated"),
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

  const role = useCollabStore.getState().role;
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  provider = new WebsocketProvider(
    `${wsProtocol}//${location.host}/yorm/ws`,
    `${DOC_TYPE}/${DOC_ID}`,
    doc,
    // BroadcastChannel would sync same-origin tabs directly, bypassing the
    // server — a physician tab would pour the full canonical doc into a
    // receptionist tab, which the policy lens then rightly refuses (an
    // endless 1008 loop). Roles differ per tab, so tabs must not shortcut.
    { params: { mode, role }, disableBc: true },
  );

  provider.awareness.setLocalState({
    user: {
      name: useCollabStore.getState().selfName,
      color: useCollabStore.getState().selfColor,
    },
    focusedField: null,
  });

  // Policy deny (1008): the policy lens refused one of this doc's updates
  // and closed the socket. The refused change is baked into the local CRDT
  // state, so y-websocket's auto-reconnect would re-send it and be refused
  // again, forever. Discard the local doc and resync the server's view.
  provider.on("connection-close", (event: { code?: number } | null) => {
    if (event?.code === 1008) {
      provider?.destroy();
      location.reload();
    }
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
  useCollabStore.setState({ peers: readPeers(provider.awareness), provider });
}

/** Connects the Y.Doc, awareness, and poll loop. Idempotent (HMR-safe). */
export function startCollab(): void {
  if (started) {
    return;
  }
  started = true;

  // The initial mode can come from the URL (`/?mode=proposer`), so a second
  // window can be opened straight into proposer mode; the initial view from
  // `?view=esheet` (the dense editor is the default). The policy-lens role
  // comes from `?role=` and is fixed for the page's lifetime.
  const params = new URLSearchParams(location.search);
  const initialMode: DemoMode = params.get("mode") === "proposer" ? "proposer" : "editor";
  setApiMode(initialMode);
  useCollabStore.setState({
    mode: initialMode,
    role: parseDemoRole(params.get("role")),
    view: params.get("view") === "esheet" ? "esheet" : "dense",
    selfName: t("presence.userName", { n: doc.clientID % 1000 }),
    selfColor: PRESENCE_COLORS[doc.clientID % PRESENCE_COLORS.length]!,
  });

  doc.on("update", () => {
    useCollabStore.setState({ patient: root.toJSON() as Patient });
  });

  connectProvider(initialMode);

  const poll = async (): Promise<void> => {
    try {
      const [rows, projection, proposals, sql] = await Promise.all([
        fetchRows(),
        fetchProjectionState(),
        fetchProposals(),
        fetchSql(lastSqlSeq),
      ]);
      applyProjection(rows, projection, sql);
      applyProposals(proposals);
    } catch {
      // server briefly unavailable — retry on the next tick
    }
  };
  void poll();
  setInterval(() => void poll(), POLL_MS);
}
