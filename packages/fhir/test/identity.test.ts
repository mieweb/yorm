import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ensureElementIds, fhirElementId, type Patient } from "../src/index.js";

const fixtureUrl = new URL(
  "../../../fixtures/fhir-r4/patient/patient-example.json",
  import.meta.url,
);

function loadFixture(): Patient {
  return JSON.parse(readFileSync(fixtureUrl, "utf8")) as Patient;
}

describe("fhirElementId", () => {
  it("prefers the explicit element id", () => {
    const id = fhirElementId({ id: "t1", system: "phone" }, { businessKey: () => "ignored" });
    expect(id).toBe("t1");
  });

  it("falls back to the business key when no explicit id exists", () => {
    const element = { system: "phone", value: "555-1234" };
    const id = fhirElementId(element, {
      businessKey: (el) => `${String(el["system"])}|${String(el["value"])}`,
    });
    expect(id).toBe("phone|555-1234");
  });

  it("throws when neither explicit id nor business key resolves", () => {
    expect(() => fhirElementId({ system: "phone" })).toThrow(/ensureElementIds/);
    expect(() => fhirElementId({ system: "phone" }, { businessKey: () => undefined })).toThrow(
      /ensureElementIds/,
    );
  });
});

describe("ensureElementIds", () => {
  const paths = [["name"], ["telecom"], ["address"]];

  it("leaves the fixture unchanged (all listed arrays already carry ids)", () => {
    const patient = loadFixture();
    const result = ensureElementIds(patient, paths);
    // Structural sharing: nothing changed, so the very same references come back.
    expect(result).toBe(patient);
  });

  it("assigns ids only where missing, via the injected deterministic assign", () => {
    const patient = loadFixture();
    patient.telecom = [...(patient.telecom ?? []), { system: "sms", value: "555-0000" }];

    let n = 0;
    const result = ensureElementIds(patient, paths, { assign: () => `gen-${++n}` });

    expect(result.telecom?.map((t) => t.id)).toEqual(["t1", "t2", "gen-1"]);
    expect(n).toBe(1); // assign called only for the element missing an id
    // Untouched arrays keep their original references (structural sharing).
    expect(result.name).toBe(patient.name);
    expect(result.address).toBe(patient.address);
  });

  it("prefers the business key over assign for missing ids", () => {
    const patient = loadFixture();
    patient.telecom = [...(patient.telecom ?? []), { system: "sms", value: "555-0000" }];

    const result = ensureElementIds(patient, [["telecom"]], {
      businessKey: (el) => `${String(el["system"])}|${String(el["value"])}`,
      assign: () => "never",
    });

    expect(result.telecom?.map((t) => t.id)).toEqual(["t1", "t2", "sms|555-0000"]);
  });

  it("does not mutate the original resource", () => {
    const patient = loadFixture();
    patient.telecom = [...(patient.telecom ?? []), { system: "sms", value: "555-0000" }];
    const snapshot = structuredClone(patient);

    ensureElementIds(patient, paths, { assign: () => "gen-1" });

    expect(patient).toEqual(snapshot);
  });

  it("assigns short random ids by default", () => {
    const patient = loadFixture();
    patient.telecom = [...(patient.telecom ?? []), { system: "sms", value: "555-0000" }];

    const result = ensureElementIds(patient, [["telecom"]]);
    const assigned = result.telecom?.[2]?.id;
    expect(typeof assigned).toBe("string");
    expect(assigned).toHaveLength(8);
  });

  it("fans out over intermediate arrays in a path", () => {
    const patient = loadFixture();
    const withContacts = {
      ...patient,
      contact: [{ telecom: [{ system: "phone", value: "555-9999" }] }],
    };

    const result = ensureElementIds(withContacts, [["contact", "telecom"]], {
      assign: () => "gen-1",
    });

    const contact = (result as Record<string, unknown>)["contact"] as Array<{
      telecom: Array<{ id?: string }>;
    }>;
    expect(contact[0]?.telecom[0]?.id).toBe("gen-1");
  });
});
