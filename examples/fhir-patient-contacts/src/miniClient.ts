/**
 * Minimal y-protocols WebSocket client on Node's global `WebSocket` — the
 * same pattern `packages/hono/test/websocket.test.ts` uses (copied locally:
 * tests must not import across package test directories). Sends SyncStep1 on
 * open, answers sync messages, forwards local doc updates to the server.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

export class MiniClient {
  readonly doc = new Y.Doc();
  readonly ws: WebSocket;
  closed: { code: number } | null = null;
  synced = false;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("open", () => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeSyncStep1(encoder, this.doc);
      this.ws.send(encoding.toUint8Array(encoder));
    });
    this.ws.addEventListener("message", (evt: MessageEvent) => {
      const data = new Uint8Array(evt.data as ArrayBuffer);
      const decoder = decoding.createDecoder(data);
      if (decoding.readVarUint(decoder) !== 0) {
        return; // awareness — not exercised by the POC
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      const messageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);
      if (messageType === syncProtocol.messageYjsSyncStep2) {
        this.synced = true;
      }
      if (encoding.length(encoder) > 1) {
        this.ws.send(encoding.toUint8Array(encoder));
      }
    });
    this.ws.addEventListener("close", (evt) => {
      // CloseEvent is not in @types/node's globals; the shape is stable.
      this.closed = { code: (evt as unknown as { code: number }).code };
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === this) {
        return; // came from the server; don't echo back
      }
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, 0);
      syncProtocol.writeUpdate(encoder, update);
      this.ws.send(encoding.toUint8Array(encoder));
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Polls `cond` until it holds or `timeoutMs` elapses (then throws `label`). */
export async function until(cond: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for: ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Finds the element of a Y.Array of maps with the given FHIR element `id`. */
export function findYElement(array: Y.Array<unknown>, id: string): Y.Map<unknown> | undefined {
  for (let i = 0; i < array.length; i += 1) {
    const item = array.get(i);
    if (item instanceof Y.Map && item.get("id") === id) {
      return item;
    }
  }
  return undefined;
}
