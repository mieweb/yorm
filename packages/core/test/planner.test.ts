import { describe, expect, it } from "vitest";

import {
  defineMapping,
  many,
  one,
  planProjection,
  type ProjectionPlan,
  type Row,
  type RowKey,
} from "../src/index.js";

/** Small Patient-like shape — intentionally NOT @yorm/fhir. */
interface FakePatient {
  id: string;
  active?: boolean;
  birthDate?: string;
  identifiers?: Array<{ elementId: string; system?: string; value?: string }>;
}

const patientMapping = defineMapping<FakePatient>({
  name: "fake.Patient",
  version: 1,
  documentType: "Patient",
  projections: [
    one("patient", {
      key: ({ object }) => ({ id: object.id }),
      values: ({ object }) => ({
        active: object.active ?? null,
        birth_date: object.birthDate ?? null,
      }),
    }),
    many("patient_identifier", {
      rows: ({ object }) =>
        (object.identifiers ?? []).map((identifier) => ({
          key: { patient_id: object.id, element_id: identifier.elementId },
          values: {
            system: identifier.system ?? null,
            value: identifier.value ?? null,
          },
        })),
      scope: ({ object }) => ({ patient_id: object.id }),
    }),
  ],
});

const patient: FakePatient = {
  id: "p1",
  active: true,
  birthDate: "1980-01-01",
  identifiers: [
    { elementId: "id-a", system: "mrn", value: "123" },
    { elementId: "id-b", system: "ssn", value: "456" },
  ],
};

const plan = (object: FakePatient, version = 1): ProjectionPlan =>
  planProjection(patientMapping, {
    object,
    documentId: "doc-1",
    documentVersion: version,
    origin: "yjs",
  });

describe("planProjection", () => {
  it("produces the full golden plan for a new document", () => {
    expect(plan(patient)).toEqual({
      mapping: "fake.Patient@1",
      documentId: "doc-1",
      documentType: "Patient",
      documentVersion: 1,
      origin: "yjs",
      operations: [
        {
          kind: "upsert",
          table: "patient",
          key: { id: "p1" },
          values: { active: true, birth_date: "1980-01-01" },
          ownedColumns: ["active", "birth_date"],
        },
        {
          kind: "upsert",
          table: "patient_identifier",
          key: { patient_id: "p1", element_id: "id-a" },
          values: { system: "mrn", value: "123" },
          ownedColumns: ["system", "value"],
        },
        {
          kind: "upsert",
          table: "patient_identifier",
          key: { patient_id: "p1", element_id: "id-b" },
          values: { system: "ssn", value: "456" },
          ownedColumns: ["system", "value"],
        },
        {
          kind: "reconcile",
          table: "patient_identifier",
          keyColumns: ["element_id", "patient_id"],
          keepKeys: [
            { patient_id: "p1", element_id: "id-a" },
            { patient_id: "p1", element_id: "id-b" },
          ],
          scope: { patient_id: "p1" },
        },
      ],
      checkpoint: {
        documentId: "doc-1",
        documentType: "Patient",
        mappingName: "fake.Patient",
        mappingVersion: 1,
        sourceDocumentVersion: 1,
      },
    });
  });

  it("projects optional/absent fields as nulls", () => {
    const first = plan({ id: "p2" }).operations[0];
    expect(first).toEqual({
      kind: "upsert",
      table: "patient",
      key: { id: "p2" },
      values: { active: null, birth_date: null },
      ownedColumns: ["active", "birth_date"],
    });
  });

  it("reflects element removal in keepKeys", () => {
    const removed = plan({ ...patient, identifiers: [patient.identifiers![0]!] });
    const reconcile = removed.operations.at(-1);
    expect(reconcile).toEqual({
      kind: "reconcile",
      table: "patient_identifier",
      keyColumns: ["element_id", "patient_id"],
      keepKeys: [{ patient_id: "p1", element_id: "id-a" }],
      scope: { patient_id: "p1" },
    });
  });

  it("is order-independent: reordering the array produces an identical plan", () => {
    const reordered = plan({
      ...patient,
      identifiers: [...patient.identifiers!].reverse(),
    });
    expect(reordered).toEqual(plan(patient));
  });

  it("is idempotent: a second run produces a deeply-equal plan", () => {
    expect(plan(patient)).toEqual(plan(patient));
  });

  it("emits a zero-rows reconcile using the explicit scope override", () => {
    const empty = plan({ id: "p1", identifiers: [] });
    expect(empty.operations).toEqual([
      expect.objectContaining({ kind: "upsert", table: "patient" }),
      {
        kind: "reconcile",
        table: "patient_identifier",
        keyColumns: ["patient_id"],
        keepKeys: [],
        scope: { patient_id: "p1" },
      },
    ]);
  });

  it("carries the origin through to the plan", () => {
    const replayed = planProjection(patientMapping, {
      object: patient,
      documentId: "doc-1",
      documentVersion: 7,
      origin: "replay",
    });
    expect(replayed.origin).toBe("replay");
    expect(replayed.checkpoint.sourceDocumentVersion).toBe(7);
  });
});

describe("planProjection scope derivation", () => {
  const rowsMapping = (rows: Array<{ key: RowKey; values: Row }>, scope?: () => RowKey) =>
    defineMapping<null>({
      name: "scope.Test",
      version: 1,
      documentType: "Test",
      projections: [many("t", scope ? { rows: () => rows, scope } : { rows: () => rows })],
    });

  const planRows = (rows: Array<{ key: RowKey; values: Row }>, scope?: () => RowKey) =>
    planProjection(rowsMapping(rows, scope), {
      object: null,
      documentId: "doc-1",
      documentVersion: 1,
      origin: "yjs",
    });

  it("derives scope from key columns identical across all rows", () => {
    const derived = planRows([
      { key: { doc: "d1", el: "a" }, values: { v: 1 } },
      { key: { doc: "d1", el: "b" }, values: { v: 2 } },
    ]);
    expect(derived.operations.at(-1)).toEqual({
      kind: "reconcile",
      table: "t",
      keyColumns: ["doc", "el"],
      keepKeys: [
        { doc: "d1", el: "a" },
        { doc: "d1", el: "b" },
      ],
      scope: { doc: "d1" },
    });
  });

  it("prefers an explicit scope override to derivation", () => {
    const overridden = planRows(
      [
        { key: { doc: "d1", el: "a" }, values: { v: 1 } },
        { key: { doc: "d1", el: "b" }, values: { v: 2 } },
      ],
      () => ({ doc: "d1", extra: "x" }),
    );
    expect((overridden.operations.at(-1) as { scope: RowKey }).scope).toEqual({
      doc: "d1",
      extra: "x",
    });
  });

  it("throws when derivation is ambiguous (no shared key column value)", () => {
    expect(() =>
      planRows([
        { key: { doc: "d1", el: "a" }, values: { v: 1 } },
        { key: { doc: "d2", el: "b" }, values: { v: 2 } },
      ]),
    ).toThrow(/cannot derive reconcile scope for table "t"/);
  });

  it("throws on zero rows without a scope override", () => {
    expect(() => planRows([])).toThrow(/produced no rows and declares no scope\(\)/);
  });
});

describe("planProjection validation", () => {
  const oneMapping = (values: () => Row, key: () => RowKey = () => ({ id: "p1" })) =>
    defineMapping<null>({
      name: "validation.Test",
      version: 1,
      documentType: "Test",
      projections: [one("t", { key, values })],
    });

  const planOne = (values: () => Row, key?: () => RowKey) =>
    planProjection(oneMapping(values, key), {
      object: null,
      documentId: "doc-1",
      documentVersion: 1,
      origin: "yjs",
    });

  it("throws a clear error on undefined values", () => {
    expect(() => planOne(() => ({ bad: undefined }) as unknown as Row)).toThrow(
      /column "bad" of table "t" is undefined; mappings must emit null explicitly/,
    );
  });

  it("throws on non-scalar values", () => {
    expect(() => planOne(() => ({ bad: { nested: true } }) as unknown as Row)).toThrow(
      /must be a scalar/,
    );
  });

  it("throws when a column appears in both key and values", () => {
    expect(() => planOne(() => ({ id: "p1", v: 1 }))).toThrow(
      /column "id" of table "t" appears in both key and values/,
    );
  });

  it("throws on an empty key", () => {
    expect(() =>
      planOne(
        () => ({ v: 1 }),
        () => ({}),
      ),
    ).toThrow(/key for table "t" must contain at least one column/);
  });

  it("throws when many() rows use inconsistent key columns", () => {
    const mapping = defineMapping<null>({
      name: "validation.Test",
      version: 1,
      documentType: "Test",
      projections: [
        many("t", {
          rows: () => [
            { key: { a: 1 }, values: { v: 1 } },
            { key: { b: 2 }, values: { v: 2 } },
          ],
          scope: () => ({ a: 1 }),
        }),
      ],
    });
    expect(() =>
      planProjection(mapping, { object: null, documentId: "d", documentVersion: 1, origin: "yjs" }),
    ).toThrow(/inconsistent key columns/);
  });
});
