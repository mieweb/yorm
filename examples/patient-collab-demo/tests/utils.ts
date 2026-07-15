/**
 * Shared Playwright helpers: opening an editor page (own browser context),
 * locating eSheet field inputs / the projection rows panel, and switching
 * the autosave policy through the UI (waiting for the server ack).
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
export async function openEditor(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await expect(fieldInput(page, t("form.family"))).toBeVisible();
  await expect(projectionPanel(page).getByRole("cell", { name: "p-demo" }).first()).toBeVisible();
  return page;
}

/** An eSheet field input, located by its accessible label (the question). */
export function fieldInput(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

/** The live SQLite rows panel. */
export function projectionPanel(page: Page): Locator {
  return page.getByRole("region", { name: t("rows.title") });
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
