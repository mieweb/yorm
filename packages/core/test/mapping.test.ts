import { describe, expect, it } from "vitest";

import {
  defineMapping,
  many,
  mappingId,
  one,
  tableName,
  type Mapping,
  type MappingContext,
} from "../src/index.js";

interface FakePatient {
  id: string;
  active?: boolean;
  identifiers?: Array<{ elementId: string; value?: string }>;
}

const onePatient = () =>
  one<FakePatient>("patient", {
    key: ({ object }) => ({ id: object.id }),
    values: ({ object }) => ({ active: object.active ?? null }),
  });

const manyIdentifiers = () =>
  many<FakePatient>("patient_identifier", {
    rows: ({ object }) =>
      (object.identifiers ?? []).map((identifier) => ({
        key: { patient_id: object.id, element_id: identifier.elementId },
        values: { value: identifier.value ?? null },
      })),
    scope: ({ object }) => ({ patient_id: object.id }),
  });

describe("tableName", () => {
  it("accepts plain strings and objects with a name", () => {
    expect(tableName("patient")).toBe("patient");
    expect(tableName({ name: "patient" })).toBe("patient");
  });
});

describe("defineMapping", () => {
  const valid = () =>
    defineMapping<FakePatient>({
      name: "fake.Patient",
      version: 1,
      documentType: "Patient",
      projections: [onePatient(), manyIdentifiers()],
    });

  it("defaults direction to forward", () => {
    expect(valid().direction).toBe("forward");
  });

  it("freezes the mapping, its projections array, and each projection", () => {
    const mapping = valid();
    expect(Object.isFrozen(mapping)).toBe(true);
    expect(Object.isFrozen(mapping.projections)).toBe(true);
    for (const projection of mapping.projections) {
      expect(Object.isFrozen(projection)).toBe(true);
    }
    expect(() => {
      (mapping as { version: number }).version = 2;
    }).toThrow(TypeError);
  });

  it("rejects an empty name", () => {
    expect(() =>
      defineMapping<FakePatient>({
        name: "",
        version: 1,
        documentType: "Patient",
        projections: [onePatient()],
      }),
    ).toThrow(/name must be a non-empty string/);
  });

  it("rejects non-integer or < 1 versions", () => {
    for (const version of [0, -1, 1.5, NaN]) {
      expect(() =>
        defineMapping<FakePatient>({
          name: "fake.Patient",
          version,
          documentType: "Patient",
          projections: [onePatient()],
        }),
      ).toThrow(/version must be an integer >= 1/);
    }
  });

  it("rejects an empty projections array", () => {
    expect(() =>
      defineMapping<FakePatient>({
        name: "fake.Patient",
        version: 1,
        documentType: "Patient",
        projections: [],
      }),
    ).toThrow(/at least one projection is required/);
  });

  it("rejects two one() projections targeting the same table", () => {
    expect(() =>
      defineMapping<FakePatient>({
        name: "fake.Patient",
        version: 1,
        documentType: "Patient",
        projections: [onePatient(), onePatient()],
      }),
    ).toThrow(/multiple one\(\) projections target table "patient"/);
  });

  it("allows a one() and a many() projection on the same table", () => {
    const mapping = defineMapping<FakePatient>({
      name: "fake.Patient",
      version: 1,
      documentType: "Patient",
      projections: [
        onePatient(),
        many<FakePatient>("patient", {
          rows: () => [],
          scope: ({ object }) => ({ id: object.id }),
        }),
      ],
    });
    expect(mapping.projections).toHaveLength(2);
  });
});

describe("mappingId", () => {
  it("formats as name@version", () => {
    const mapping: Mapping<FakePatient> = defineMapping<FakePatient>({
      name: "fhir.Patient",
      version: 3,
      documentType: "Patient",
      projections: [onePatient()],
    });
    expect(mappingId(mapping)).toBe("fhir.Patient@3");
  });
});

describe("one/many builders", () => {
  it("capture kind, table, and callbacks", () => {
    const ctx: MappingContext<FakePatient> = {
      object: { id: "p1", active: true },
      documentId: "doc-1",
    };
    const projection = onePatient();
    expect(projection.kind).toBe("one");
    expect(projection.key(ctx)).toEqual({ id: "p1" });
    expect(projection.values(ctx)).toEqual({ active: true });

    const collection = manyIdentifiers();
    expect(collection.kind).toBe("many");
    expect(collection.rows(ctx)).toEqual([]);
    expect(collection.scope?.(ctx)).toEqual({ patient_id: "p1" });
  });
});
