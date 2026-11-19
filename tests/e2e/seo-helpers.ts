import { expect, type Page } from "@playwright/test";
import { signUp } from "./helpers";

export const DEMO_SITE = `http://localhost:${process.env.MOCK_SITE_PORT ?? 8792}`;

export async function waitForTask(page: Page, url: string, label: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await page.goto(url);
    const row = page.getByTestId("task-list").locator("li", { hasText: label }).first();
    const text = (await row.count()) ? await row.innerText() : "";
    if (/^completed/i.test(text)) return row;
    if (/^failed/i.test(text)) throw new Error(`${label} failed: ${text}`);
    if (Date.now() > deadline) throw new Error(`${label} did not finish: ${text}`);
    await page.waitForTimeout(2000);
  }
}

export async function connect(page: Page, provider: string, fields: Record<string, string>) {
  const row = page.getByTestId(`integration-${provider}`);
  await row.getByRole("button", { name: "Connect" }).click();
  const dialog = page.getByRole("dialog");
  for (const [label, value] of Object.entries(fields)) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole("button", { name: "Test & save" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(row).toContainText("Connected");
}


/** Signs up, creates a client and the demo website; returns the website ID. */
export async function setupDemoWebsite(page: Page, prefix: string) {
  const run = Date.now();
  await signUp(page, `${prefix}-${run}@example.test`, `${prefix} Agency ${run}`);
  await page.goto("/clients");
  await page.getByRole("button", { name: "Add client" }).first().click();
  await page.getByLabel("Client name").fill("Acme Dental Group");
  await page.getByRole("button", { name: "Save client" }).click();
  await expect(page.getByRole("dialog")).toBeHidden(); // the save must finish before navigating away
  await page.goto("/websites");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website name").fill("Acme Dental");
  await page.getByLabel("Website address").fill(DEMO_SITE);
  await page.getByRole("button", { name: "Save website" }).click();
  await expect(page).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}
