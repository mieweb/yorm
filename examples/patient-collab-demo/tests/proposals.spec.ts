/**
 * PLAN.md 7c — suggestion mode end to end: browser A is an editor, browser B
 * a proposer (`/?mode=proposer`). B's edits become proposals (no canonical /
 * row change); A reviews them in the top proposals bar — accept applies the
 * change everywhere, reject changes nothing but the `yorm_proposal` status.
 */
import { expect, test } from "@playwright/test";

import { t } from "../src/client/i18n";
import {
  fieldInput,
  openEditor,
  projectionPanel,
  proposalRow,
  propose,
  reviewPanel,
  runId,
  selectPolicy,
} from "./utils";

test("proposer suggests, editor accepts: rows update only on accept", async ({ browser }) => {
  const editor = await openEditor(browser);
  const proposer = await openEditor(browser, "/?mode=proposer");
  const family = `Suggested-${runId}`;

  // Project on every change so the row assertions need no blur trigger.
  await selectPolicy(editor, t("policy.every-change"));

  const proposalId = await propose(proposer, t("form.family"), family);

  // Editor sees the suggestion in the review list and the tracking row…
  const item = (await reviewPanel(editor)).getByRole("listitem").filter({ hasText: family });
  await expect(item).toBeVisible();
  await expect(proposalRow(editor, proposalId)).toContainText("proposed");
  // …but neither the canonical document nor the contact rows changed.
  await expect(fieldInput(editor, t("form.family"))).not.toHaveValue(family);
  await expect(projectionPanel(editor).getByRole("cell", { name: family })).toHaveCount(0);

  await item
    .getByRole("button", { name: t("review.acceptLabel", { field: t("form.family") }) })
    .click();

  // Accept applies the intent: both UIs converge, the contact row updates,
  // and the tracking row flips to accepted.
  await expect(fieldInput(editor, t("form.family"))).toHaveValue(family);
  await expect(fieldInput(proposer, t("form.family"))).toHaveValue(family);
  await expect(projectionPanel(editor).getByRole("cell", { name: family })).toBeVisible();
  await expect(proposalRow(editor, proposalId)).toContainText("accepted");
});

test("proposer suggests, editor rejects: nothing changes but the status", async ({ browser }) => {
  const editor = await openEditor(browser);
  const proposer = await openEditor(browser, "/?mode=proposer");
  const phoneBefore = await fieldInput(editor, t("form.phone")).inputValue();
  const phone = `(07) 5550 ${runId}`;

  const proposalId = await propose(proposer, t("form.phone"), phone);
  const item = (await reviewPanel(editor)).getByRole("listitem").filter({ hasText: phone });
  await expect(item).toBeVisible();

  await item
    .getByRole("button", { name: t("review.rejectLabel", { field: t("form.phone") }) })
    .click();

  // The tracking row flips to rejected; canonical state and rows are untouched.
  await expect(proposalRow(editor, proposalId)).toContainText("rejected");
  await expect(projectionPanel(editor).getByRole("cell", { name: phone })).toHaveCount(0);
  await expect(fieldInput(editor, t("form.phone"))).toHaveValue(phoneBefore);
  // The proposer's field snaps back to the canonical value.
  await expect(fieldInput(proposer, t("form.phone"))).toHaveValue(phoneBefore);
});
