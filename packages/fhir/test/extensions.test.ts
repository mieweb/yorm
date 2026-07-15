import { describe, expect, it } from "vitest";

import {
  YORM_EXTENSION_BASE,
  extensionUrl,
  getExtension,
  getExtensionValue,
  listYormExtensions,
  removeExtension,
  setExtension,
  type ContactPoint,
} from "../src/index.js";

const ringtoneUrl = extensionUrl("contact-ringtone");
const nicknameUrl = extensionUrl("contact-nickname");
const externalUrl = "http://hl7.org/fhir/StructureDefinition/patient-birthPlace";

describe("extensionUrl", () => {
  it("builds urls under the documented namespace", () => {
    expect(ringtoneUrl).toBe(`${YORM_EXTENSION_BASE}/contact-ringtone`);
  });
});

describe("setExtension / getExtension / getExtensionValue", () => {
  it("appends a new extension and reads it back", () => {
    const element: ContactPoint = { system: "phone", value: "555-1234" };
    const next = setExtension(element, ringtoneUrl, { valueString: "Marimba" });

    expect(getExtension(next, ringtoneUrl)).toEqual({
      url: ringtoneUrl,
      valueString: "Marimba",
    });
    expect(getExtensionValue(next, ringtoneUrl)).toBe("Marimba");
  });

  it("replaces by url, preserving position and other extensions", () => {
    let element: ContactPoint = { system: "phone" };
    element = setExtension(element, ringtoneUrl, { valueString: "Marimba" });
    element = setExtension(element, nicknameUrl, { valueString: "Pete" });
    element = setExtension(element, ringtoneUrl, { valueString: "Chimes" });

    expect(element.extension).toEqual([
      { url: ringtoneUrl, valueString: "Chimes" },
      { url: nicknameUrl, valueString: "Pete" },
    ]);
  });

  it("supports valueCode and valueUrl variants", () => {
    const element = setExtension({}, nicknameUrl, { valueCode: "nick" });
    expect(getExtension(element, nicknameUrl)).toEqual({ url: nicknameUrl, valueCode: "nick" });
    expect(getExtensionValue(element, nicknameUrl)).toBeUndefined();
  });

  it("does not mutate the input element", () => {
    const element: ContactPoint = {
      system: "phone",
      extension: [{ url: ringtoneUrl, valueString: "Marimba" }],
    };
    const snapshot = structuredClone(element);

    setExtension(element, ringtoneUrl, { valueString: "Chimes" });
    setExtension(element, nicknameUrl, { valueString: "Pete" });

    expect(element).toEqual(snapshot);
  });

  it("returns undefined for absent extensions", () => {
    expect(getExtension({}, ringtoneUrl)).toBeUndefined();
    expect(getExtensionValue({}, ringtoneUrl)).toBeUndefined();
  });
});

describe("removeExtension", () => {
  it("removes only the extension with the given url", () => {
    let element: ContactPoint = { system: "phone" };
    element = setExtension(element, ringtoneUrl, { valueString: "Marimba" });
    element = setExtension(element, nicknameUrl, { valueString: "Pete" });

    const next = removeExtension(element, ringtoneUrl);
    expect(next.extension).toEqual([{ url: nicknameUrl, valueString: "Pete" }]);
  });

  it("drops the extension property when the last extension is removed", () => {
    const element = setExtension({} as ContactPoint, ringtoneUrl, { valueString: "Marimba" });
    const next = removeExtension(element, ringtoneUrl);
    expect("extension" in next).toBe(false);
  });

  it("returns the same reference when nothing matches, and never mutates", () => {
    const element = setExtension({} as ContactPoint, nicknameUrl, { valueString: "Pete" });
    const snapshot = structuredClone(element);

    expect(removeExtension(element, ringtoneUrl)).toBe(element);
    removeExtension(element, nicknameUrl);
    expect(element).toEqual(snapshot);
  });
});

describe("listYormExtensions", () => {
  it("lists only extensions under the yorm namespace", () => {
    let element: ContactPoint = {
      system: "phone",
      extension: [{ url: externalUrl, valueString: "elsewhere" }],
    };
    element = setExtension(element, ringtoneUrl, { valueString: "Marimba" });
    element = setExtension(element, nicknameUrl, { valueString: "Pete" });

    expect(listYormExtensions(element).map((ext) => ext.url)).toEqual([ringtoneUrl, nicknameUrl]);
  });

  it("returns an empty array when there are no extensions", () => {
    expect(listYormExtensions({})).toEqual([]);
  });
});
