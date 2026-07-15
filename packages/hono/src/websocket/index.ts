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
import type { DocumentSession } from "@yorm/yjs";

import type { HonoYormOptions } from "../index.js";
import type { SessionCache } from "../shared.js";
import { authorize, policyFromQuery } from "../shared.js";

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

/** Per-document room: connected sockets plus the shared awareness instance. */
interface Room {
  session: DocumentSession;
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

function createRoom(session: DocumentSession, onEmpty: () => void): Room {
  const awareness = new awarenessProtocol.Awareness(session.doc);
  awareness.setLocalState(null); // the server has no presence of its own
  const room: Room = {
    session,
    awareness,
    sockets: new Set(),
    controlledIds: new Map(),
    currentOrigin: null,
    unsubscribe: () => {},
  };

  // Broadcast every persisted doc update (from sockets, HTTP writes, or any
  // other session) to all sockets except the message's origin socket.
  const unsubscribeDoc = session.subscribe((update) => {
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

  const getRoom = async (type: string, id: string): Promise<Room> => {
    const key = `${type}/${id}`;
    let room = rooms.get(key);
    if (!room) {
      const session = await sessions.get(type, id);
      // Re-check: a concurrent open may have created the room while awaiting.
      room = rooms.get(key);
      if (!room) {
        room = createRoom(session, () => rooms.delete(key));
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
      if (!(await authorize(c, options, type, id))) {
        return {
          onOpen(_evt, ws) {
            ws.close(1008, "forbidden");
          },
        };
      }
      const room = await getRoom(type, id);
      const policy = policyFromQuery(c.req.query("policy"), c.req.query("idleMs"));
      return {
        onOpen(_evt, ws) {
          room.sockets.add(ws);
          room.controlledIds.set(ws, new Set());
          if (policy !== null) {
            room.session.setPolicy(policy);
          }
          ws.send(encodeSyncStep1(room.session.doc));
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
              const encoder = encoding.createEncoder();
              encoding.writeVarUint(encoder, MESSAGE_SYNC);
              // Applying the message mutates the doc; fan-out is synchronous,
              // so mark this socket as the origin for the duration.
              room.currentOrigin = ws;
              try {
                syncProtocol.readSyncMessage(decoder, encoder, room.session.doc, ws);
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
