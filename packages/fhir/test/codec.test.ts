import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DEFAULT_ROOT_KEY } from "@yorm/yjs";

import { fhirResource, type Patient } from "../src/index.js";

const fixtureUrl = new URL(
  "../../../fixtures/fhir-r4/patient/patient-example.json",
  import.meta.url,
);
const patientFixture = JSON.parse(readFileSync(fixtureUrl, "utf8")) as Patient;

describe("fhirResource codec", () => {
  it("round-trips the R4 Patient fixture through a Y.Doc", () => {
    const codec = fhirResource<Patient>("Patient");
    const doc = new Y.Doc();
    codec.write(doc, patientFixture);
    expect(codec.read(doc)).toEqual(patientFixture);
  });

  it("exposes its resourceType", () => {
    expect(fhirResource("Patient").resourceType).toBe("Patient");
  });

  it("throws a descriptive error when writing a mismatched resourceType", () => {
    const codec = fhirResource("Observation");
    const doc = new Y.Doc();
    expect(() => codec.write(doc, patientFixture)).toThrow(
      /fhirResource\("Observation"\)\.write: value has resourceType "Patient"/,
    );
  });

  it("throws on read when the document holds a different resourceType", () => {
    const codec = fhirResource("Observation");
    const doc = new Y.Doc();
    fhirResource<Patient>("Patient").write(doc, patientFixture);
    expect(() => codec.read(doc)).toThrow(/contains resourceType "Patient"/);
  });

  it("guarantees resourceType on read even when absent from the document", () => {
    const codec = fhirResource("Patient");
    const doc = new Y.Doc();
    doc.getMap(DEFAULT_ROOT_KEY).set("active", true);
    expect(codec.read(doc)).toEqual({ resourceType: "Patient", active: true });
  });

  it("reflects direct Y type mutations on read (Yjs interop)", () => {
    const codec = fhirResource<Patient>("Patient");
    const doc = new Y.Doc();
    codec.write(doc, patientFixture);

    const root = doc.getMap(DEFAULT_ROOT_KEY);
    const names = root.get("name") as Y.Array<Y.Map<unknown>>;
    names.get(0).set("family", "Windsor");

    const read = codec.read(doc);
    expect(read.name?.[0]?.family).toBe("Windsor");
    expect(read.name?.[1]).toEqual(patientFixture.name?.[1]);
  });

  it("uses the default @yorm/yjs root key so it composes with sessions", () => {
    const codec = fhirResource<Patient>("Patient");
    const doc = new Y.Doc();
    codec.write(doc, patientFixture);
    expect(doc.getMap(DEFAULT_ROOT_KEY).get("resourceType")).toBe("Patient");
  });
});
