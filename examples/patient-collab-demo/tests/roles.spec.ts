/**
 * Policy-lens roles (role-security POC): `?role=receptionist|nurse` syncs a
 * server-derived, redacted Y.Doc with server-enforced write rules (see
 * src/rolePolicies.ts) — the physician (no policy) syncs the canonical doc.
 */
import { expect, test } from "@playwright/test";

import { t } from "../src/client/i18n";
import { fieldInput, openEditor, runId } from "./utils";

test("receptionist sees a redacted view; allowed edits reach the physician", async ({
  browser,
}) => {
  const physician = await openEditor(browser);
  const receptionist = await openEditor(browser, "/?role=receptionist");

  // The physician's canonical doc has an address; the receptionist's lens
  // doc never receives it — the section is empty and marked read-only.
  await expect(fieldInput(physician, t("editor.addressCity"))).toHaveValue("PleasantVille");
  await expect(fieldInput(receptionist, t("editor.addressCity"))).toHaveCount(0);
  await expect(
    receptionist.locator(".editor-section-readonly", { hasText: t("role.receptionist") }),
  ).toHaveCount(4); // identity, identifiers, addresses, extensions

  // An allowed write (family name) merges back into the canonical doc.
  const family = `Lens-${runId}`;
  await fieldInput(receptionist, t("form.family")).fill(family);
  await expect(fieldInput(physician, t("form.family"))).toHaveValue(family);
});

test("nurse sees everything but identity fields are read-only", async ({ browser }) => {
  const nurse = await openEditor(browser, "/?role=nurse");

  // Full visibility: the address is present and editable…
  await expect(fieldInput(nurse, t("editor.addressCity"))).toBeEnabled();
  // …but names and identity are view-only for this role.
  await expect(fieldInput(nurse, t("form.family"))).toBeDisabled();
  await expect(fieldInput(nurse, t("form.birthDate"))).toBeDisabled();
});
