/**
 * PLAN.md 6d — two browser contexts edit the same Patient: both UIs converge
 * over Yjs and the SQLite projection rows panel shows both values (under the
 * `every-change` policy, which this spec selects — the demo defaults to
 * `on-blur`).
 */
import { expect, test } from "@playwright/test";

import { t } from "../src/client/i18n";
import { fieldInput, openEditor, projectionPanel, runId, selectPolicy } from "./utils";

test("two browsers converge and projection rows update live", async ({ browser }) => {
  const pageA = await openEditor(browser);
  const pageB = await openEditor(browser);
  const family = `Chalmers-${runId}`;
  const phone = `(03) 5555 ${runId}`;

  await selectPolicy(pageA, t("policy.every-change"));

  // A edits the family name; B converges.
  await fieldInput(pageA, t("form.family")).fill(family);
  await expect(fieldInput(pageB, t("form.family"))).toHaveValue(family);

  // B edits the phone; A converges.
  await fieldInput(pageB, t("form.phone")).fill(phone);
  await expect(fieldInput(pageA, t("form.phone"))).toHaveValue(phone);

  // Under every-change both values land in the SQLite rows panel.
  const panel = projectionPanel(pageA);
  await expect(panel.getByRole("cell", { name: family })).toBeVisible();
  await expect(panel.getByRole("cell", { name: phone })).toBeVisible();
});
