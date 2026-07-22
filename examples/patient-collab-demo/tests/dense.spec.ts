/**
 * The dense custom Patient editor end to end:
 *
 * - an unmapped field (gender) converges over Yjs but never reaches the SQL
 *   rows ("keep the object" — no contact column exists for it);
 * - the inline suggestion adornment next to a field accepts a proposal in
 *   place (value applied everywhere + tracking row flips);
 * - "Accept all" mass-resolves every open suggestion and the top bar keeps
 *   them listed as resolved;
 * - the header view toggle swaps to the eSheet form over the same document
 *   (same values; an eSheet edit converges back into a dense-view browser).
 *
 * All edited values are run-unique (`runId`): the e2e server may be reused
 * with persisted state, so constant values would be no-op fills.
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
} from "./utils";

test("unmapped field (gender) converges but is never projected", async ({ browser }) => {
  const pageA = await openEditor(browser);
  const pageB = await openEditor(browser);

  // Toggle away from the persisted value so the edit is never a no-op.
  const gender = fieldInput(pageA, t("editor.gender"));
  const next = (await gender.inputValue()) === "other" ? "unknown" : "other";
  await gender.selectOption(next);
  await expect(fieldInput(pageB, t("editor.gender"))).toHaveValue(next);

  // A mapped edit forces a projection commit after the gender change…
  const family = `Unmapped-${runId}`;
  await fieldInput(pageA, t("form.family")).fill(family);
  await expect(projectionPanel(pageA).getByRole("cell", { name: family })).toBeVisible();
  // …and the gender value still appears nowhere in the SQL rows.
  await expect(projectionPanel(pageA).getByRole("cell", { name: next, exact: true })).toHaveCount(
    0,
  );
});

test("inline accept next to the field applies the suggestion", async ({ browser }) => {
  const editor = await openEditor(browser);
  const proposer = await openEditor(browser, "/?mode=proposer");
  const family = `Inline-${runId}`;

  const proposalId = await propose(proposer, t("form.family"), family);

  // The adornment renders next to the input, linked via aria-describedby.
  const input = fieldInput(editor, t("form.family"));
  const adornment = editor.locator(".dense-suggestion").filter({ hasText: family });
  await expect(adornment).toBeVisible();
  await expect(input).toHaveAttribute("aria-describedby", "dense-suggestion-family");
  // The proposer sees their pending suggestion without action buttons.
  await expect(
    proposer.locator(".dense-suggestion-pending").filter({ hasText: family }),
  ).toBeVisible();
  await expect(proposer.locator(".dense-suggestion-pending").getByRole("button")).toHaveCount(0);

  await adornment
    .getByRole("button", { name: t("review.acceptLabel", { field: t("form.family") }) })
    .click();

  await expect(input).toHaveValue(family);
  await expect(fieldInput(proposer, t("form.family"))).toHaveValue(family);
  await expect(projectionPanel(editor).getByRole("cell", { name: family })).toBeVisible();
  await expect(proposalRow(editor, proposalId)).toContainText("accepted");
});

test("Accept all mass-applies every open suggestion", async ({ browser }) => {
  const editor = await openEditor(browser);
  const proposer = await openEditor(browser, "/?mode=proposer");
  const phone = `(02) 5551 ${runId}`;
  const email = `mass-${runId}@example.org`;

  const phoneId = await propose(proposer, t("form.phone"), phone);
  const emailId = await propose(proposer, t("form.email"), email);

  const panel = reviewPanel(editor);
  await expect(panel.getByRole("listitem").filter({ hasText: phone })).toBeVisible();
  await expect(panel.getByRole("listitem").filter({ hasText: email })).toBeVisible();

  await panel.getByRole("button", { name: t("review.acceptAllLabel") }).click();

  // Both intents applied: fields, contact rows, and tracking rows.
  await expect(fieldInput(editor, t("form.phone"))).toHaveValue(phone);
  await expect(fieldInput(editor, t("form.email"))).toHaveValue(email);
  await expect(projectionPanel(editor).getByRole("cell", { name: phone })).toBeVisible();
  await expect(projectionPanel(editor).getByRole("cell", { name: email })).toBeVisible();
  await expect(proposalRow(editor, phoneId)).toContainText("accepted");
  await expect(proposalRow(editor, emailId)).toContainText("accepted");
  // Resolved history is hidden by default; the toggle reveals both, greyed.
  await panel.getByRole("button", { name: t("review.showResolvedLabel") }).click();
  await expect(panel.getByRole("listitem").filter({ hasText: phone })).toContainText(
    t("review.status.accepted"),
  );
  await expect(panel.getByRole("listitem").filter({ hasText: email })).toContainText(
    t("review.status.accepted"),
  );

  // Clearing resolved history deletes it from the document: the list and
  // the yorm_proposal tracking rows empty out (a semantic CRDT delete).
  await panel.getByRole("button", { name: t("review.clearResolvedLabel") }).click();
  await expect(panel.getByRole("listitem")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: t("review.showResolvedLabel") })).toHaveCount(0);
  await expect(proposalRow(editor, phoneId)).toHaveCount(0);
  await expect(proposalRow(editor, emailId)).toHaveCount(0);
});

test("eSheet view toggle renders the same document", async ({ browser }) => {
  const pageA = await openEditor(browser);
  const pageB = await openEditor(browser);
  const family = await fieldInput(pageB, t("form.family")).inputValue();

  // Switch A to the eSheet view — same values, same store. Wait until the
  // eSheet form store is wired to the doc before editing (edits made in the
  // brief render-to-onReady window would not reach Yjs).
  await pageA.getByRole("tab", { name: t("view.esheet") }).click();
  await expect(pageA.locator(".patient-form")).toHaveAttribute("data-ready", "true");
  await expect(fieldInput(pageA, t("form.family"))).toHaveValue(family);

  // An eSheet edit converges back into the dense view in the other browser.
  const given = `Sheet-${runId}`;
  await fieldInput(pageA, t("form.given")).fill(given);
  await expect(fieldInput(pageB, t("form.given"))).toHaveValue(given);
});
