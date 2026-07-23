/**
 * Minimal y-protocols client on Node 22's global WebSocket (no extra client
 * dependency needed): sends SyncStep1 on open, answers sync messages, and
 * forwards local doc updates to the server. Shared by the WebSocket tests.
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
        return; // awareness — not exercised by these tests
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
    this.ws.addEventListener("close", (evt: CloseEvent) => {
      this.closed = { code: evt.code };
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
