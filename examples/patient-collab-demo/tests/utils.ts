/**
 * Shared Playwright helpers: opening an editor page (own browser context),
 * locating field inputs by accessible label (works for both the dense
 * editor and the eSheet view — the shared fields carry the same labels),
 * the projection rows / proposals panels, proposing as a proposer, and
 * switching the autosave policy through the UI (waiting for the server ack).
 */
import { expect } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";

import { t } from "../src/client/i18n";

/**
 * Run-unique suffix for edited values. The Playwright web server may be
 * reused across runs (`reuseExistingServer`), and the canonical document
 * persists edits — constant test values would make `fill()` a no-op on the
 * second run (no document change → no pending projection to observe).
 */
export const runId = Date.now().toString(36);

/** Opens the app in a fresh browser context and waits until it is usable. */
export async function openEditor(browser: Browser, path = "/"): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(path);
  await expect(fieldInput(page, t("form.family"))).toBeVisible();
  await expect(projectionPanel(page).getByRole("cell", { name: "p-demo" }).first()).toBeVisible();
  return page;
}

/**
 * Opens the app in the eSheet view and waits for the renderer's form store
 * to be wired to the Y.Doc (edits before `data-ready` would be lost).
 */
export async function openEsheetEditor(browser: Browser, path = "/?view=esheet"): Promise<Page> {
  const page = await openEditor(browser, path);
  await expect(page.locator(".patient-form")).toHaveAttribute("data-ready", "true");
  return page;
}

/** A field input (dense or eSheet), located by its accessible label. */
export function fieldInput(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

/** The live SQLite rows panel. */
export function projectionPanel(page: Page): Locator {
  return page.getByRole("region", { name: t("rows.title") });
}

/** The top accumulating proposals bar. */
export function reviewPanel(page: Page): Locator {
  return page.getByRole("region", { name: t("review.title") });
}

/** The `yorm_proposal` tracking row for one proposal id in the rows panel. */
export function proposalRow(page: Page, proposalId: string): Locator {
  return projectionPanel(page).getByRole("row").filter({ hasText: proposalId });
}

/**
 * Fills a field as the proposer and returns the created proposal's id
 * (captured from the debounced `POST /proposals` response).
 */
export async function propose(page: Page, fieldLabel: string, value: string): Promise<string> {
  const created = page.waitForResponse(
    (response) =>
      response.url().includes("/proposals") &&
      response.request().method() === "POST" &&
      response.status() === 201,
  );
  await fieldInput(page, fieldLabel).fill(value);
  const body = (await (await created).json()) as { proposal: { id: string } };
  return body.proposal.id;
}

/** Picks an autosave policy in the UI and waits for the POST /policy ack. */
export async function selectPolicy(page: Page, optionLabel: string): Promise<void> {
  await page.getByRole("combobox", { name: t("policy.label") }).click();
  const acknowledged = page.waitForResponse(
    (response) => response.url().includes("/policy") && response.ok(),
  );
  await page.getByRole("option", { name: optionLabel }).click();
  await acknowledged;
}
