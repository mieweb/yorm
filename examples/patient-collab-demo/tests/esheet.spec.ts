/**
 * The source-built eSheet renderer (vendor/eSheet, `yorm-collab-decorations`
 * branch) end to end:
 *
 * - the renderer's native proposal adornment appears next to the field and
 *   its inline Accept applies the suggestion (rows + tracking row update);
 * - a peer's focused field renders a presence dot in the eSheet view
 *   (awareness `focusedField` flows into the renderer's `collab` prop);
 * - the Form config panel's YAML tab re-labels a field, the re-rendered
 *   form stays two-way bound to the document, and invalid YAML surfaces an
 *   inline error without breaking the live form.
 *
 * All edited values are run-unique (`runId`): the e2e server may be reused
 * with persisted state, so constant values would be no-op fills.
 */
import { expect, test } from "@playwright/test";

import { t } from "../src/client/i18n";
import {
  fieldInput,
  openEditor,
  openEsheetEditor,
  projectionPanel,
  proposalRow,
  propose,
  runId,
  selectPolicy,
} from "./utils";

test("eSheet adornment: inline accept applies the suggestion", async ({ browser }) => {
  const editor = await openEsheetEditor(browser);
  const proposer = await openEditor(browser, "/?mode=proposer");
  const family = `Esheet-${runId}`;

  // Project on every change so the row assertions need no blur trigger.
  await selectPolicy(editor, t("policy.every-change"));

  const proposalId = await propose(proposer, t("form.family"), family);

  // The renderer's own adornment shows the proposal next to the field,
  // linked to the input via aria-describedby.
  const form = editor.locator(".patient-form");
  const adornment = form.locator(".collab-proposal").filter({ hasText: family });
  await expect(adornment).toBeVisible();
  const input = fieldInput(editor, t("form.family"));
  await expect(input).toHaveAttribute("aria-describedby", /-proposal-family$/);

  await adornment.getByRole("button", { name: `Accept proposal for ${t("form.family")}` }).click();

  await expect(input).toHaveValue(family);
  await expect(projectionPanel(editor).getByRole("cell", { name: family })).toBeVisible();
  await expect(proposalRow(editor, proposalId)).toContainText("accepted");
});

test("presence: a peer's focused field shows a presence dot in the eSheet view", async ({
  browser,
}) => {
  const editor = await openEsheetEditor(browser);
  const proposer = await openEditor(browser, "/?mode=proposer");

  // The proposer's own presence name (the reused e2e server can hold stale
  // awareness from earlier runs, so assertions must target this peer's dot).
  const selfItem = proposer
    .getByRole("list", { name: t("presence.label") })
    .getByRole("listitem", { name: /\(you\)/ })
    .first();
  const selfLabel = await selfItem.getAttribute("title");
  const name = /^(.*?) \(you\)/.exec(selfLabel ?? "")?.[1] ?? "";
  expect(name).not.toBe("");
  const dot = (field: string) =>
    editor.locator(`.patient-form [data-field-id="${field}"] .collab-presence [title="${name}"]`);

  // The proposer (dense view) focuses the email field — shared field ids
  // make awareness view-independent.
  await fieldInput(proposer, t("form.email")).click();
  await expect(dot("email")).toBeVisible();

  // Moving focus moves the presence dot to the newly focused field.
  await fieldInput(proposer, t("form.phone")).click();
  await expect(dot("phone")).toBeVisible();
  await expect(dot("email")).toHaveCount(0);
});

test("YAML config: label edit re-renders bound; invalid YAML shows an error", async ({
  browser,
}) => {
  const editor = await openEsheetEditor(browser);
  const other = await openEditor(browser); // dense view

  await selectPolicy(editor, t("policy.every-change"));

  // Rename the family field's label through the YAML tab.
  await editor.getByText(t("config.title")).click();
  const textarea = editor.getByLabel(t("config.yamlLabel"));
  const yaml = await textarea.inputValue();
  const newLabel = `Family name ${runId}`;
  expect(yaml).toContain(`question: ${t("form.family")}`);
  await textarea.fill(yaml.replace(`question: ${t("form.family")}`, `question: ${newLabel}`));
  await editor.getByRole("button", { name: t("config.applyLabel") }).click();

  // The form re-renders with the new label and is still bound to the doc.
  const renamed = fieldInput(editor, newLabel);
  await expect(renamed).toBeVisible();
  await expect(editor.locator(".patient-form")).toHaveAttribute("data-ready", "true");
  const family = `Yaml-${runId}`;
  await renamed.fill(family);
  await expect(fieldInput(other, t("form.family"))).toHaveValue(family);
  await expect(projectionPanel(editor).getByRole("cell", { name: family })).toBeVisible();

  // Invalid YAML surfaces an inline error and leaves the live form alone.
  await textarea.fill("fields: [unclosed");
  await editor.getByRole("button", { name: t("config.applyLabel") }).click();
  await expect(editor.getByRole("alert")).toBeVisible();
  await expect(renamed).toBeVisible();
  await expect(renamed).toHaveValue(family);
});
