import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { applyJsonPatchLike, jsonCodec } from "../src/index.js";

const sample = {
  id: "p1",
  active: true,
  deceased: null,
  age: 42,
  name: { given: ["Ada", "Byron"], family: "Lovelace" },
  scores: [1, 2, [3, 4]],
  tags: [{ code: "a", nested: { deep: null } }, { code: "b" }],
};

describe("jsonCodec", () => {
  it("round-trips nested objects, arrays, and nulls", () => {
    const codec = jsonCodec();
    const doc = new Y.Doc();
    codec.write(doc, sample);
    expect(codec.read(doc)).toEqual(sample);
  });

  it("replaces prior content on write (merge-style replace)", () => {
    const codec = jsonCodec();
    const doc = new Y.Doc();
    codec.write(doc, { a: 1, b: { c: 2 } });
    codec.write(doc, { b: { d: 3 } });
    expect(codec.read(doc)).toEqual({ b: { d: 3 } });
  });

  it("drops undefined object entries and nullifies undefined array items", () => {
    const codec = jsonCodec();
    const doc = new Y.Doc();
    codec.write(doc, { a: 1, b: undefined, list: ["x", undefined] });
    expect(codec.read(doc)).toEqual({ a: 1, list: ["x", null] });
  });

  it("writes in exactly one transaction (one update event)", () => {
    const codec = jsonCodec();
    const doc = new Y.Doc();
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    codec.write(doc, sample);
    expect(updates).toBe(1);
  });

  it("uses the configured root key", () => {
    const codec = jsonCodec("patient");
    const doc = new Y.Doc();
    codec.write(doc, { id: "p1" });
    expect(doc.getMap("patient").toJSON()).toEqual({ id: "p1" });
    expect(doc.getMap("resource").size).toBe(0);
  });

  it("rejects non-object top-level values", () => {
    const codec = jsonCodec<unknown>();
    const doc = new Y.Doc();
    expect(() => codec.write(doc, [1, 2])).toThrow(/plain object/);
    expect(() => codec.write(doc, "nope")).toThrow(/plain object/);
  });
});

describe("applyJsonPatchLike", () => {
  const setup = () => {
    const codec = jsonCodec();
    const doc = new Y.Doc();
    codec.write(doc, {
      active: true,
      name: { family: "Lovelace" },
      phones: [{ value: "111" }, { value: "222" }],
    });
    return { doc, read: () => codec.read(doc) as Record<string, unknown> };
  };

  it("sets a top-level value", () => {
    const { doc, read } = setup();
    applyJsonPatchLike(doc, "resource", ["active"], false);
    expect(read().active).toBe(false);
  });

  it("sets a nested value, creating intermediate maps", () => {
    const { doc, read } = setup();
    applyJsonPatchLike(doc, "resource", ["meta", "profile", "url"], "http://x");
    expect(read().meta).toEqual({ profile: { url: "http://x" } });
  });

  it("creates intermediate arrays for numeric segments", () => {
    const { doc, read } = setup();
    applyJsonPatchLike(doc, "resource", ["identifiers", 0, "system"], "mrn");
    expect(read().identifiers).toEqual([{ system: "mrn" }]);
  });

  it("replaces an array element and appends at length", () => {
    const { doc, read } = setup();
    applyJsonPatchLike(doc, "resource", ["phones", 1, "value"], "999");
    applyJsonPatchLike(doc, "resource", ["phones", 2], { value: "333" });
    expect(read().phones).toEqual([{ value: "111" }, { value: "999" }, { value: "333" }]);
  });

  it("removes map keys and array elements when value is undefined", () => {
    const { doc, read } = setup();
    applyJsonPatchLike(doc, "resource", ["name", "family"], undefined);
    applyJsonPatchLike(doc, "resource", ["phones", 0], undefined);
    expect(read().name).toEqual({});
    expect(read().phones).toEqual([{ value: "222" }]);
  });

  it("applies each patch in one transaction", () => {
    const { doc } = setup();
    let updates = 0;
    doc.on("update", () => {
      updates += 1;
    });
    applyJsonPatchLike(doc, "resource", ["meta", "profile", "url"], "http://x");
    expect(updates).toBe(1);
  });

  it("rejects an empty path and out-of-bounds writes", () => {
    const { doc } = setup();
    expect(() => applyJsonPatchLike(doc, "resource", [], 1)).toThrow(/at least one segment/);
    expect(() => applyJsonPatchLike(doc, "resource", ["phones", 5], { value: "x" })).toThrow(
      /out of bounds/,
    );
  });
});
