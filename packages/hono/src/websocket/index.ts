/**
 * WebSocket routes of the YORM Hono plugin — `GET /ws/:type/:id` speaking
 * the standard Yjs wire protocol (y-protocols sync + awareness), so any
 * y-websocket-compatible client can connect.
 *
 * Hono's `upgradeWebSocket` is runtime-specific (Node/Bun/Deno/CF), so it is
 * injected by the caller; this module has no runtime lock-in.
 */
import { Hono } from "hono";
import type { UpgradeWebSocket, WSContext, WSEvents, WSMessageReceive } from "hono/ws";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { DEFAULT_ROOT_KEY, createPolicyLens, policyFor } from "@yorm/yjs";
import type { DocumentSession, PolicyLens } from "@yorm/yjs";

import type { HonoYormOptions, WriteScope } from "../index.js";
import type { SessionCache } from "../shared.js";
import { authorize, authorizeWrite, policyFromQuery } from "../shared.js";

/** y-websocket wire message types. */
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

type AnySocket = WSContext<unknown>;

/** What `WSContext.send` accepts for binary frames. */
type BinaryFrame = Uint8Array<ArrayBuffer>;

/** lib0 encoders are backed by plain `ArrayBuffer`s; narrow the type for `send`. */
function toFrame(encoder: encoding.Encoder): BinaryFrame {
  return encoding.toUint8Array(encoder) as BinaryFrame;
}

/**
 * What a room syncs against: the canonical session, or a policy lens's
 * derived doc (role-security POC). Both expose the same structural surface.
 */
interface SyncSource {
  doc: Y.Doc;
  subscribe(listener: (update: Uint8Array) => void): () => void;
}

/** Per-document (or per document+role) room: sockets plus shared awareness. */
interface Room {
  /** The doc this room's sockets sync (canonical session or policy lens). */
  source: SyncSource;
  /** The underlying canonical session (policy target for `?policy=`). */
  session: DocumentSession;
  /** Non-null when this room serves a role with a policy lens. */
  lens: PolicyLens | null;
  awareness: awarenessProtocol.Awareness;
  sockets: Set<AnySocket>;
  /** Awareness client ids introduced by each socket (removed on close). */
  controlledIds: Map<AnySocket, Set<number>>;
  /**
   * The socket whose incoming message is currently being applied. Update
   * fan-out is synchronous, so this lets the room broadcast to every socket
   * EXCEPT the origin (y-protocols tolerates echo, but we avoid it).
   */
  currentOrigin: AnySocket | null;
  /** Tears down the session subscription. */
  unsubscribe: () => void;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

function encodeSyncStep1(doc: DocumentSession["doc"]): BinaryFrame {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return toFrame(encoder);
}

function encodeDocUpdate(update: Uint8Array): BinaryFrame {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return toFrame(encoder);
}

function encodeAwareness(awareness: awarenessProtocol.Awareness, clients: number[]): BinaryFrame {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return toFrame(encoder);
}

/** Binary frames only; strings/Blobs are ignored (the Yjs protocol is binary). */
function toUint8Array(data: WSMessageReceive): Uint8Array | null {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  return null;
}

/**
 * Proposer-role canonical-write guard (PLAN.md M7, decision #11).
 *
 * Returns `true` when applying `update` would change the canonical subtree
 * (`doc.getMap(rootKey)`): the live doc's state is replayed onto a scratch
 * `Y.Doc`, the update is applied there, and the canonical subtree's JSON is
 * compared before/after. The live doc is never touched.
 *
 * v1 tradeoff (documented): CRDT-level per-subtree write refusal is complex,
 * so proposer connections pay an encode + double-apply on a scratch doc per
 * incoming sync update (editor connections are unaffected). A violating
 * update is refused **as a whole** — it is not applied and the socket is
 * closed with 1008 — even if it also carried proposals-subtree changes.
 * Refusing without applying keeps the server doc clean, but a proposer that
 * made offline canonical edits will be disconnected on re-sync; partial
 * revert of mixed updates is a future extension.
 */
export function guardCanonicalWrites(
  doc: Y.Doc,
  update: Uint8Array,
  rootKey: string = DEFAULT_ROOT_KEY,
): boolean {
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
    const before = JSON.stringify(scratch.getMap(rootKey).toJSON());
    Y.applyUpdate(scratch, update);
    return JSON.stringify(scratch.getMap(rootKey).toJSON()) !== before;
  } finally {
    scratch.destroy();
  }
}

/**
 * Extracts the doc update payload from a sync message when it carries one
 * (SyncStep2 / Update); `null` for SyncStep1 (which never mutates the doc).
 */
function updatePayloadOf(data: Uint8Array): Uint8Array | null {
  const decoder = decoding.createDecoder(data);
  decoding.readVarUint(decoder); // MESSAGE_SYNC, checked by the caller
  const subType = decoding.readVarUint(decoder);
  if (subType === syncProtocol.messageYjsSyncStep2 || subType === syncProtocol.messageYjsUpdate) {
    return decoding.readVarUint8Array(decoder);
  }
  return null;
}

function createRoom(
  source: SyncSource,
  session: DocumentSession,
  lens: PolicyLens | null,
  onEmpty: () => void,
): Room {
  const awareness = new awarenessProtocol.Awareness(source.doc);
  awareness.setLocalState(null); // the server has no presence of its own
  const room: Room = {
    source,
    session,
    lens,
    awareness,
    sockets: new Set(),
    controlledIds: new Map(),
    currentOrigin: null,
    unsubscribe: () => {},
  };

  // Broadcast every source update (from sockets, HTTP writes, or any other
  // session/lens refresh) to all sockets except the message's origin socket.
  const unsubscribeDoc = source.subscribe((update) => {
    const payload = encodeDocUpdate(update);
    for (const socket of room.sockets) {
      if (socket !== room.currentOrigin) {
        socket.send(payload);
      }
    }
  });

  // Track which awareness client ids each socket introduced, and broadcast
  // awareness changes to every socket except the origin.
  const onAwarenessUpdate = (change: AwarenessChange, origin: unknown): void => {
    const socketOrigin =
      origin !== null && room.controlledIds.has(origin as AnySocket) ? (origin as AnySocket) : null;
    if (socketOrigin !== null) {
      const owned = room.controlledIds.get(socketOrigin)!;
      for (const clientId of [...change.added, ...change.updated]) {
        owned.add(clientId);
      }
      for (const clientId of change.removed) {
        owned.delete(clientId);
      }
    }
    const changed = [...change.added, ...change.updated, ...change.removed];
    if (changed.length === 0) {
      return;
    }
    const payload = encodeAwareness(awareness, changed);
    for (const socket of room.sockets) {
      if (socket !== socketOrigin) {
        socket.send(payload);
      }
    }
  };
  awareness.on("update", onAwarenessUpdate);

  room.unsubscribe = () => {
    unsubscribeDoc();
    awareness.off("update", onAwarenessUpdate);
    awareness.destroy();
    lens?.close();
    onEmpty();
  };
  return room;
}

function leaveRoom(room: Room, socket: AnySocket): void {
  if (!room.sockets.delete(socket)) {
    return;
  }
  const owned = room.controlledIds.get(socket);
  room.controlledIds.delete(socket);
  if (owned && owned.size > 0) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], null);
  }
  if (room.sockets.size === 0) {
    // Drop the room (subscription + awareness); the cached session stays
    // open so the document keeps projecting and reopening is cheap.
    room.unsubscribe();
  }
}

/**
 * Builds the `/ws/:type/:id` sub-app around an injected `upgradeWebSocket`.
 */
export function createWebSocketRoutes(
  upgradeWebSocket: UpgradeWebSocket,
  sessions: SessionCache,
  options: HonoYormOptions,
): Hono {
  const app = new Hono();
  const rooms = new Map<string, Room>();

  const getRoom = async (type: string, id: string, role: string | undefined): Promise<Room> => {
    const policy = policyFor(options.rolePolicies, type, role);
    // Lens rooms are per (document, role) so every socket in a room sees the
    // same derived doc; canonical rooms stay per document.
    const key = policy ? `${type}/${id}#role=${role}` : `${type}/${id}`;
    let room = rooms.get(key);
    if (!room) {
      const session = await sessions.get(type, id);
      // Re-check: a concurrent open may have created the room while awaiting.
      room = rooms.get(key);
      if (!room) {
        const lens = policy
          ? createPolicyLens(session, policy, { role: role!, documentType: type, documentId: id })
          : null;
        room = createRoom(lens ?? session, session, lens, () => rooms.delete(key));
        rooms.set(key, room);
      }
    }
    return room;
  };

  app.get(
    "/ws/:type/:id",
    upgradeWebSocket(async (c): Promise<WSEvents<unknown>> => {
      const type = c.req.param("type") ?? "";
      const id = c.req.param("id") ?? "";
      const role = c.req.query("role");
      // Role precedence: a role with a policy syncs through its lens (the
      // policy governs reads and writes); `?role=proposer` connections may
      // only write the proposals subtree; everything else is a canonical
      // writer (v1: no read-only sockets).
      const hasLens = policyFor(options.rolePolicies, type, role) !== null;
      const scope: WriteScope = !hasLens && role === "proposer" ? "proposals" : "canonical";
      if (
        !(await authorize(c, options, type, id)) ||
        !(await authorizeWrite(c, options, type, id, scope))
      ) {
        return {
          onOpen(_evt, ws) {
            ws.close(1008, "forbidden");
          },
        };
      }
      const guardCanonical = scope === "proposals";
      const room = await getRoom(type, id, hasLens ? role : undefined);
      const policy = policyFromQuery(c.req.query("policy"), c.req.query("idleMs"));
      return {
        onOpen(_evt, ws) {
          room.sockets.add(ws);
          room.controlledIds.set(ws, new Set());
          if (policy !== null) {
            room.session.setPolicy(policy);
          }
          ws.send(encodeSyncStep1(room.source.doc));
          const states = room.awareness.getStates();
          if (states.size > 0) {
            ws.send(encodeAwareness(room.awareness, [...states.keys()]));
          }
        },
        onMessage(evt, ws) {
          const data = toUint8Array(evt.data);
          if (data === null) {
            return;
          }
          const decoder = decoding.createDecoder(data);
          switch (decoding.readVarUint(decoder)) {
            case MESSAGE_SYNC: {
              if (room.lens) {
                const payload = updatePayloadOf(data);
                if (payload !== null) {
                  // Doc-mutating message: route it through the lens (policy
                  // validation + canonical write-back). Fan-out is
                  // synchronous, so mark this socket as the origin.
                  room.currentOrigin = ws;
                  try {
                    const result = room.lens.applyClientUpdate(payload);
                    if (!result.allowed) {
                      ws.close(1008, result.reason);
                    }
                  } finally {
                    room.currentOrigin = null;
                  }
                  return;
                }
                // SyncStep1 never mutates the doc — fall through and reply
                // with the lens doc's state.
              }
              if (guardCanonical) {
                const payload = updatePayloadOf(data);
                if (payload !== null && guardCanonicalWrites(room.session.doc, payload)) {
                  // Refuse the update entirely (never applied server-side).
                  ws.close(1008, "proposer role: canonical writes are forbidden");
                  return;
                }
              }
              const encoder = encoding.createEncoder();
              encoding.writeVarUint(encoder, MESSAGE_SYNC);
              // Applying the message mutates the doc; fan-out is synchronous,
              // so mark this socket as the origin for the duration.
              room.currentOrigin = ws;
              try {
                syncProtocol.readSyncMessage(decoder, encoder, room.source.doc, ws);
              } finally {
                room.currentOrigin = null;
              }
              if (encoding.length(encoder) > 1) {
                ws.send(toFrame(encoder));
              }
              break;
            }
            case MESSAGE_AWARENESS:
              awarenessProtocol.applyAwarenessUpdate(
                room.awareness,
                decoding.readVarUint8Array(decoder),
                ws,
              );
              break;
          }
        },
        onClose(_evt, ws) {
          leaveRoom(room, ws);
        },
        onError(_evt, ws) {
          leaveRoom(room, ws);
        },
      };
    }),
  );

  return app;
}
