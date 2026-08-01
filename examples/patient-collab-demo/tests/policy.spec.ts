/**
 * PLAN.md 6d — under deferred policies the browsers still converge live over
 * Yjs while the SQLite rows update only at the policy trigger:
 *
 * - `explicit`: rows change on Save only;
 * - `on-blur`: rows change when the edited field blurs.
 */
import { expect, test } from "@playwright/test";

import { t } from "../src/client/i18n";
import { fieldInput, openEditor, projectionPanel, runId, selectPolicy } from "./utils";

test("explicit policy defers projection until Save", async ({ browser }) => {
  const pageA = await openEditor(browser);
  const pageB = await openEditor(browser);
  const given = `Explicitus-${runId}`;

  await selectPolicy(pageA, t("policy.explicit"));

  await fieldInput(pageA, t("form.given")).fill(given);
  // Yjs convergence is live regardless of the projection policy…
  await expect(fieldInput(pageB, t("form.given"))).toHaveValue(given);
  // …but the projection is pending and the rows panel has not changed.
  await expect(pageA.getByText(t("policy.pending"))).toBeVisible();
  await expect(projectionPanel(pageA).getByRole("cell", { name: given })).toHaveCount(0);

  await pageA.getByRole("button", { name: t("policy.save") }).click();
  await expect(projectionPanel(pageA).getByRole("cell", { name: given })).toBeVisible();
  await expect(pageA.getByText(t("policy.saved"))).toBeVisible();
});

test("on-blur policy projects when the field blurs", async ({ browser }) => {
  const pageA = await openEditor(browser);
  const address = `blur-${runId}@example.org`;

  await selectPolicy(pageA, t("policy.on-blur"));

  const email = fieldInput(pageA, t("form.email"));
  await email.fill(address);
  await expect(pageA.getByText(t("policy.pending"))).toBeVisible();
  await expect(projectionPanel(pageA).getByRole("cell", { name: address })).toHaveCount(0);

  await email.blur();
  await expect(projectionPanel(pageA).getByRole("cell", { name: address })).toBeVisible();
  await expect(pageA.getByText(t("policy.saved"))).toBeVisible();

  // Restore the default policy for anyone running specs out of order.
  await selectPolicy(pageA, t("policy.on-blur"));
});
