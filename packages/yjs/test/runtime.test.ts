import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { memoryRuntime } from "../src/index.js";
import { fakeDocumentStore } from "./fakes.js";

describe("memoryRuntime", () => {
  it("increments the version once per persisted update, local or remote", async () => {
    const runtime = memoryRuntime();
    const managed = await runtime.openDocument("Contact", "c1");
    expect(managed.version).toBe(0);

    managed.doc.transact(() => {
      managed.doc.getMap("resource").set("firstName", "Ada");
    });
    expect(managed.version).toBe(1);
    managed.doc.transact(() => {
      managed.doc.getMap("resource").set("lastName", "Lovelace");
    });
    expect(managed.version).toBe(2);

    const remote = new Y.Doc();
    Y.applyUpdate(remote, managed.encodeState());
    const before = Y.encodeStateVector(managed.doc);
    remote.getMap("resource").set("nickname", "Countess");
    managed.applyUpdate(Y.encodeStateAsUpdate(remote, before), "external-import");
    expect(managed.version).toBe(3);
  });

  it("persists every update and a snapshot with origin/actor metadata", async () => {
    const documents = fakeDocumentStore();
    const runtime = memoryRuntime({ documents });
    const managed = await runtime.openDocument("Contact", "c1");

    managed.doc.transact(() => {
      managed.doc.getMap("resource").set("firstName", "Ada");
    });
    const remote = new Y.Doc();
    Y.applyUpdate(remote, managed.encodeState());
    const before = Y.encodeStateVector(managed.doc);
    remote.getMap("resource").set("lastName", "Lovelace");
    managed.applyUpdate(Y.encodeStateAsUpdate(remote, before), "external-import", "importer");
    await managed.whenPersisted();

    expect(documents.updates.map((u) => [u.documentVersion, u.origin, u.actor])).toEqual([
      [1, "yjs", undefined],
      [2, "external-import", "importer"],
    ]);
    const snapshot = documents.snapshots.get("Contact/c1");
    expect(snapshot?.documentVersion).toBe(2);
    const replay = new Y.Doc();
    Y.applyUpdate(replay, snapshot!.encodedState);
    expect(replay.getMap("resource").toJSON()).toEqual({
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("loads existing state from the store without bumping the version", async () => {
    const documents = fakeDocumentStore();
    const first = memoryRuntime({ documents });
    const original = await first.openDocument("Contact", "c1");
    original.doc.transact(() => {
      original.doc.getMap("resource").set("firstName", "Ada");
    });
    await original.whenPersisted();

    const second = memoryRuntime({ documents });
    const reopened = await second.openDocument("Contact", "c1");
    expect(reopened.version).toBe(1);
    expect(reopened.doc.getMap("resource").toJSON()).toEqual({ firstName: "Ada" });
    expect(documents.updates).toHaveLength(1); // loading persisted nothing new
  });

  it("caches the managed document per type/id", async () => {
    const runtime = memoryRuntime();
    const a = await runtime.openDocument("Contact", "c1");
    const b = await runtime.openDocument("Contact", "c1");
    const other = await runtime.openDocument("Contact", "c2");
    expect(a).toBe(b);
    expect(a).not.toBe(other);
  });

  it("fans updates out to subscribers until unsubscribed", async () => {
    const runtime = memoryRuntime();
    const managed = await runtime.openDocument("Contact", "c1");
    const received: Uint8Array[] = [];
    const unsubscribe = managed.subscribe((update) => received.push(update));

    managed.doc.transact(() => {
      managed.doc.getMap("resource").set("firstName", "Ada");
    });
    expect(received).toHaveLength(1);

    const mirror = new Y.Doc();
    for (const update of received) {
      Y.applyUpdate(mirror, update);
    }
    expect(mirror.getMap("resource").toJSON()).toEqual({ firstName: "Ada" });

    unsubscribe();
    managed.doc.transact(() => {
      managed.doc.getMap("resource").set("lastName", "Lovelace");
    });
    expect(received).toHaveLength(1);
  });
});
