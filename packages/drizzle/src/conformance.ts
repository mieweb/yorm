/**
 * Adapter conformance suite — the executable contract for `DocumentStore` +
 * `ProjectionStore` adapters (PLAN M4a). Ships in the package so Milestone 9
 * backends only add wire-up: implement an {@link AdapterFactory} and call
 * {@link adapterConformanceTests} from a test file, injecting the test API
 * (so this module has no dependency on any test framework).
 *
 * Every test creates a fresh adapter via `factory.create()`, runs the sample
 * projection-table DDL through `harness.setup(...)`, and closes the adapter
 * afterwards — adapters never share state across tests.
 */
import type {
  DocumentStore,
  DocumentUpdate,
  ProjectionPlan,
  ProjectionStore,
  StoredDocument,
} from "@yorm/core";
import { defineMapping, many, one, planProjection } from "@yorm/core";

/** One live adapter under test. */
export interface AdapterHarness {
  documents: DocumentStore;
  projections: ProjectionStore;
  /** Returns every row of `table` (for row-level assertions). */
  queryRows(table: string): Promise<Record<string, unknown>[]>;
  /** Runs arbitrary SQL statements (sample projection-table DDL, seeds). */
  setup(statements: string[]): Promise<void>;
  close(): Promise<void>;
}

/** Creates fresh, isolated adapters for the suite. */
export interface AdapterFactory {
  /** Human-readable backend name, used in test titles. */
  name: string;
  create(): Promise<AdapterHarness>;
}

/** The slice of an assertion object the suite uses (vitest-compatible). */
export interface ConformanceExpectation {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeNull(): void;
  toHaveLength(length: number): void;
  rejects: { toThrow(expected?: string | RegExp): Promise<unknown> };
}

/** The slice of a test API the suite needs — pass vitest's exports directly. */
export interface ConformanceTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
  expect(actual: unknown): ConformanceExpectation;
  beforeEach?(fn: () => void | Promise<void>): void;
}

/**
 * Sample projection tables used by the suite. Adapters receive these via
 * `setup(...)`; key columns are covered by primary keys, as the projection
 * store's upsert requires. `sample_root.note` is intentionally never owned by
 * the sample mapping (column-ownership test).
 */
export const CONFORMANCE_SAMPLE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sample_root (
    document_id TEXT PRIMARY KEY,
    full_name TEXT,
    nickname TEXT,
    note TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS sample_child (
    document_id TEXT NOT NULL,
    element_id TEXT NOT NULL,
    property TEXT,
    value TEXT,
    PRIMARY KEY (document_id, element_id)
  )`,
];

/** The contact-ish sample document the suite projects. */
interface SampleContact {
  name: string;
  nickname?: string | null;
  points: Array<{ id: string; property: string; value: string }>;
}

const sampleMapping = defineMapping<SampleContact>({
  name: "conformance.sample",
  version: 1,
  documentType: "SampleContact",
  projections: [
    one("sample_root", {
      key: ({ documentId }) => ({ document_id: documentId }),
      values: ({ object }) => ({
        full_name: object.name,
        nickname: object.nickname ?? null,
      }),
    }),
    many("sample_child", {
      rows: ({ object, documentId }) =>
        object.points.map((point) => ({
          key: { document_id: documentId, element_id: point.id },
          values: { property: point.property, value: point.value },
        })),
      scope: ({ documentId }) => ({ document_id: documentId }),
    }),
  ],
});

function samplePlan(
  object: SampleContact,
  documentId: string,
  documentVersion: number,
): ProjectionPlan {
  return planProjection(sampleMapping, { object, documentId, documentVersion, origin: "yjs" });
}

function storedDocument(
  id: string,
  type: string,
  version: number,
  state: number[],
): StoredDocument {
  return {
    documentId: id,
    documentType: type,
    encodedState: Uint8Array.from(state),
    documentVersion: version,
    createdAt: new Date(1700000000000),
    updatedAt: new Date(1700000000000 + version),
  };
}

function documentUpdate(id: string, version: number, payload: number[]): DocumentUpdate {
  return {
    documentId: id,
    documentVersion: version,
    encodedUpdate: Uint8Array.from(payload),
    origin: "yjs",
    createdAt: new Date(1700000000000 + version),
  };
}

function byteArray(bytes: Uint8Array): number[] {
  return Array.from(bytes);
}

function rowsFor(rows: Record<string, unknown>[], documentId: string): Record<string, unknown>[] {
  return rows
    .filter((row) => row.document_id === documentId)
    .sort((a, b) => String(a.element_id ?? "").localeCompare(String(b.element_id ?? "")));
}

/**
 * Registers the adapter conformance tests against `factory` using the
 * injected test API: `adapterConformanceTests(factory, { describe, it, expect })`.
 */
export function adapterConformanceTests(factory: AdapterFactory, api: ConformanceTestApi): void {
  const { describe, it, expect } = api;

  async function withHarness(fn: (harness: AdapterHarness) => Promise<void>): Promise<void> {
    const harness = await factory.create();
    try {
      await harness.setup([...CONFORMANCE_SAMPLE_DDL]);
      await fn(harness);
    } finally {
      await harness.close();
    }
  }

  describe(`adapter conformance: ${factory.name}`, () => {
    describe("DocumentStore", () => {
      it("persists and loads a document snapshot (bytes round-trip)", async () => {
        await withHarness(async ({ documents }) => {
          const doc = storedDocument("doc-1", "SampleContact", 1, [1, 2, 3, 255]);
          await documents.saveSnapshot(doc);
          const loaded = await documents.loadDocument("SampleContact", "doc-1");
          expect(loaded === null).toBe(false);
          expect(byteArray(loaded!.encodedState)).toEqual([1, 2, 3, 255]);
          expect(loaded!.documentId).toBe("doc-1");
          expect(loaded!.documentType).toBe("SampleContact");
          expect(loaded!.documentVersion).toBe(1);
          expect(loaded!.createdAt.getTime()).toBe(doc.createdAt.getTime());
          expect(loaded!.updatedAt.getTime()).toBe(doc.updatedAt.getTime());
        });
      });

      it("returns null for a missing document", async () => {
        await withHarness(async ({ documents }) => {
          expect(await documents.loadDocument("SampleContact", "nope")).toBeNull();
        });
      });

      it("saveSnapshot upserts: replaces state, keeps createdAt", async () => {
        await withHarness(async ({ documents }) => {
          const v1 = storedDocument("doc-1", "SampleContact", 1, [1]);
          await documents.saveSnapshot(v1);
          const v2 = storedDocument("doc-1", "SampleContact", 2, [9, 9]);
          v2.createdAt = new Date(1800000000000); // must be ignored on update
          await documents.saveSnapshot(v2);
          const loaded = await documents.loadDocument("SampleContact", "doc-1");
          expect(loaded!.documentVersion).toBe(2);
          expect(byteArray(loaded!.encodedState)).toEqual([9, 9]);
          expect(loaded!.createdAt.getTime()).toBe(v1.createdAt.getTime());
          expect(loaded!.updatedAt.getTime()).toBe(v2.updatedAt.getTime());
        });
      });

      it("lists updates ordered by version with sinceVersion filtering", async () => {
        await withHarness(async ({ documents }) => {
          await documents.appendUpdate({ ...documentUpdate("doc-1", 2, [2]), actor: "alice" });
          await documents.appendUpdate(documentUpdate("doc-1", 1, [1]));
          await documents.appendUpdate(documentUpdate("doc-1", 3, [3]));
          await documents.appendUpdate(documentUpdate("other-doc", 1, [42]));

          const all = await documents.listUpdates("SampleContact", "doc-1");
          expect(all.map((u) => u.documentVersion)).toEqual([1, 2, 3]);
          expect(all.map((u) => byteArray(u.encodedUpdate))).toEqual([[1], [2], [3]]);
          expect(all[1]!.actor).toBe("alice");
          expect(all[0]!.actor).toBe(undefined);
          expect(all[0]!.origin).toBe("yjs");
          expect(all[0]!.createdAt.getTime()).toBe(1700000000001);

          const since = await documents.listUpdates("SampleContact", "doc-1", 1);
          expect(since.map((u) => u.documentVersion)).toEqual([2, 3]);
        });
      });

      it("lists all documents of a type", async () => {
        await withHarness(async ({ documents }) => {
          await documents.saveSnapshot(storedDocument("doc-1", "SampleContact", 1, [1]));
          await documents.saveSnapshot(storedDocument("doc-2", "SampleContact", 1, [2]));
          await documents.saveSnapshot(storedDocument("doc-3", "OtherType", 1, [3]));
          const listed = await documents.listDocuments("SampleContact");
          expect(listed.map((d) => d.documentId).sort((a, b) => a.localeCompare(b))).toEqual([
            "doc-1",
            "doc-2",
          ]);
          expect(listed.every((d) => d.documentType === "SampleContact")).toBe(true);
        });
      });
    });

    describe("ProjectionStore", () => {
      const contact: SampleContact = {
        name: "Ada Lovelace",
        nickname: "Ada",
        points: [
          { id: "phone-1", property: "phone", value: "+1-555-0100" },
          { id: "email-1", property: "email", value: "ada@example.com" },
        ],
      };

      it("applyPlan inserts projection rows and replaying is idempotent", async () => {
        await withHarness(async ({ projections, queryRows }) => {
          const plan = samplePlan(contact, "doc-1", 1);
          await projections.applyPlan(plan);
          const firstRoot = rowsFor(await queryRows("sample_root"), "doc-1");
          const firstChildren = rowsFor(await queryRows("sample_child"), "doc-1");
          expect(firstRoot).toHaveLength(1);
          expect(firstRoot[0]!.full_name).toBe("Ada Lovelace");
          expect(firstRoot[0]!.nickname).toBe("Ada");
          expect(firstChildren).toHaveLength(2);
          expect(firstChildren.map((row) => row.element_id)).toEqual(["email-1", "phone-1"]);
          expect(firstChildren.map((row) => row.value)).toEqual(["ada@example.com", "+1-555-0100"]);

          await projections.applyPlan(plan);
          expect(rowsFor(await queryRows("sample_root"), "doc-1")).toEqual(firstRoot);
          expect(rowsFor(await queryRows("sample_child"), "doc-1")).toEqual(firstChildren);
        });
      });

      it("only writes owned columns: unowned values survive re-projection", async () => {
        await withHarness(async ({ projections, queryRows, setup }) => {
          await projections.applyPlan(samplePlan(contact, "doc-1", 1));
          await setup([`UPDATE sample_root SET note = 'hand-written' WHERE document_id = 'doc-1'`]);
          await projections.applyPlan(samplePlan({ ...contact, name: "Ada King" }, "doc-1", 2));
          const root = rowsFor(await queryRows("sample_root"), "doc-1");
          expect(root[0]!.full_name).toBe("Ada King");
          expect(root[0]!.note).toBe("hand-written");
        });
      });

      it("reconciliation deletes rows for removed elements, keeps the rest", async () => {
        await withHarness(async ({ projections, queryRows }) => {
          await projections.applyPlan(samplePlan(contact, "doc-1", 1));
          const withoutPhone: SampleContact = {
            ...contact,
            points: contact.points.filter((point) => point.id !== "phone-1"),
          };
          await projections.applyPlan(samplePlan(withoutPhone, "doc-1", 2));
          const children = rowsFor(await queryRows("sample_child"), "doc-1");
          expect(children).toHaveLength(1);
          expect(children[0]!.element_id).toBe("email-1");
        });
      });

      it("zero-keepKeys reconcile clears the scope without touching other documents", async () => {
        await withHarness(async ({ projections, queryRows }) => {
          await projections.applyPlan(samplePlan(contact, "doc-1", 1));
          await projections.applyPlan(samplePlan(contact, "doc-2", 1));
          await projections.applyPlan(samplePlan({ ...contact, points: [] }, "doc-1", 2));
          const children = await queryRows("sample_child");
          expect(rowsFor(children, "doc-1")).toHaveLength(0);
          expect(rowsFor(children, "doc-2")).toHaveLength(2);
        });
      });

      it("records the checkpoint advance with status ok", async () => {
        await withHarness(async ({ projections }) => {
          expect(await projections.getState("doc-1", "conformance.sample")).toBeNull();
          await projections.applyPlan(samplePlan(contact, "doc-1", 1));
          await projections.applyPlan(samplePlan(contact, "doc-1", 3));
          const state = await projections.getState("doc-1", "conformance.sample");
          expect(state!.status).toBe("ok");
          expect(state!.sourceDocumentVersion).toBe(3);
          expect(state!.mappingName).toBe("conformance.sample");
          expect(state!.mappingVersion).toBe(1);
          expect(state!.error ?? null).toBeNull();
          expect(state!.projectedAt instanceof Date).toBe(true);
        });
      });

      it("recordFailure records the error without touching projection tables", async () => {
        await withHarness(async ({ projections, queryRows }) => {
          await projections.applyPlan(samplePlan(contact, "doc-1", 1));
          const failed = samplePlan({ ...contact, name: "Broken" }, "doc-1", 2);
          await projections.recordFailure(failed.checkpoint, "codec exploded");

          const state = await projections.getState("doc-1", "conformance.sample");
          expect(state!.status).toBe("error");
          expect(state!.error).toBe("codec exploded");
          expect(state!.sourceDocumentVersion).toBe(2);
          const root = rowsFor(await queryRows("sample_root"), "doc-1");
          expect(root[0]!.full_name).toBe("Ada Lovelace"); // tables untouched

          // A later successful projection recovers the state cleanly.
          await projections.applyPlan(samplePlan(contact, "doc-1", 3));
          const recovered = await projections.getState("doc-1", "conformance.sample");
          expect(recovered!.status).toBe("ok");
          expect(recovered!.sourceDocumentVersion).toBe(3);
          expect(recovered!.error ?? null).toBeNull();
        });
      });

      it("applies plans transactionally: a failing operation leaves no partial rows", async () => {
        await withHarness(async ({ projections, queryRows }) => {
          const good = samplePlan(contact, "doc-tx", 1);
          const badPlan: ProjectionPlan = {
            ...good,
            operations: [
              good.operations[0]!, // valid sample_root upsert
              {
                kind: "upsert",
                table: "sample_child",
                key: { document_id: "doc-tx", element_id: "x" },
                values: { no_such_column: "boom" },
                ownedColumns: ["no_such_column"],
              },
            ],
          };
          await expect(projections.applyPlan(badPlan)).rejects.toThrow();
          expect(rowsFor(await queryRows("sample_root"), "doc-tx")).toHaveLength(0);
          expect(rowsFor(await queryRows("sample_child"), "doc-tx")).toHaveLength(0);
          expect(await projections.getState("doc-tx", "conformance.sample")).toBeNull();
        });
      });
    });
  });
}
