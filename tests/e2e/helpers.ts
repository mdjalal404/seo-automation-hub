import { expect, type Page } from "@playwright/test";

export const MOCK_WP = `http://localhost:${process.env.MOCK_WP_PORT ?? 8787}`;
export const PASSWORD = `E2e-${Date.now()}-local`;

export const MOCK_WEBFLOW = `http://localhost:${process.env.MOCK_WEBFLOW_PORT ?? 8788}`;
export const MOCK_SHOPIFY = `http://localhost:${process.env.MOCK_SHOPIFY_PORT ?? 8789}`;
export const MOCK_CUSTOM = `http://localhost:${process.env.MOCK_CUSTOM_PORT ?? 8790}`;

export async function mock(path: string, body: unknown = {}, origin = MOCK_WP) {
  const res = await fetch(`${origin}/__mock/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`mock ${path} failed`);
}

export async function signUp(page: Page, email: string, workspace: string) {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill("E2E User");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  await page.getByLabel("Agency name").fill(workspace);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

export function articleBody(topic: string) {
  const para = (i: number) => `${topic} paragraph ${i} explains a concrete, practical step that agencies can apply for their clients this quarter.`;
  return [`${para(0)} ${Array.from({ length: 25 }, (_, i) => para(i + 1)).join(" ")}`, "", "## Getting started", "", Array.from({ length: 10 }, (_, i) => para(i + 30)).join(" ")].join("\n");
}

export async function createArticle(page: Page, opts: { title: string; slug: string; body: string; metaTitle?: string; metaDescription?: string; website?: string }) {
  await page.goto("/content/new");
  if (opts.website) await page.getByLabel("Website", { exact: true }).selectOption({ label: opts.website });
  await page.getByLabel("Title", { exact: true }).fill(opts.title);
  await page.getByLabel("Slug", { exact: true }).fill(opts.slug);
  await page.getByLabel("Body", { exact: true }).fill(opts.body);
  if (opts.metaTitle !== undefined) await page.getByLabel("Meta title").fill(opts.metaTitle);
  if (opts.metaDescription !== undefined) await page.getByLabel("Meta description").fill(opts.metaDescription);
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page).toHaveURL(/\/content\/[0-9a-f-]{36}$/);
  return page.url().split("/").pop()!;
}

export async function validateAndApprove(page: Page) {
  await page.getByRole("button", { name: "Run SEO validation" }).click();
  await expect(page.getByTestId("content-status")).toHaveText("Ready for review", { timeout: 30_000 });
  await page.getByRole("button", { name: "Approve for publishing" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByTestId("content-status")).toHaveText("Approved");
}

export async function publishNow(page: Page) {
  await page.getByRole("button", { name: "Publish…" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish now" }).click();
  await expect(page.getByTestId("content-status")).not.toHaveText("Approved");
}

/** Waits for the background worker (or triggers processing) until the status settles. */
export async function waitForStatus(page: Page, contentUrl: string, expected: RegExp) {
  for (let i = 0; i < 20; i++) {
    await page.goto(contentUrl);
    const text = await page.getByTestId("content-status").innerText();
    if (expected.test(text)) return text;
    await page.waitForTimeout(1500);
  }
  throw new Error(`Status did not reach ${expected}`);
}
