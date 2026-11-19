import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { setupDemoWebsite, waitForTask } from "./seo-helpers";

const MOCK_API = `http://localhost:${process.env.MOCK_ANALYTICS_PORT ?? 8791}`;
const scenario = (body: Record<string, unknown>) => fetch(`${MOCK_API}/__mock/scenario`, { method: "POST", body: JSON.stringify(body) });
const inbox = async () => (await (await fetch(`${MOCK_API}/__mock/inbox`)).json()) as { slack: { text: string }[]; webhooks: { headers: Record<string, string>; body: string }[]; indexnow: { urlList: string[] }[] };

async function connectOutbound(page: Page, provider: string, fields: Record<string, string>) {
  const row = page.getByTestId(`integration-${provider}`);
  await row.getByRole("button", { name: "Connect" }).click();
  const dialog = page.getByRole("dialog");
  for (const [label, value] of Object.entries(fields)) await dialog.getByLabel(label, { exact: true }).fill(value);
  await dialog.getByRole("button", { name: "Test & save" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(row).toContainText("Connected");
}

async function runAudit(page: Page, websiteId: string) {
  await page.goto(`/audits?website=${websiteId}`);
  await page.waitForLoadState("networkidle"); // a cold dev server can serve the button before it is interactive
  await page.getByRole("button", { name: "Run audit (100 pages)" }).click();
  await expect(page.getByText(/Site audit queued/)).toBeVisible();
  return waitForTask(page, `/audits?website=${websiteId}`, "Site audit");
}

function gateCli(websiteId: string, key: string) {
  return spawnSync(process.execPath, ["scripts/seo-gate.mjs", "--website", websiteId, "--max-urls", "10", "--timeout", "120"], {
    env: { ...process.env, SEO_HUB_URL: "http://localhost:3000", SEO_HUB_API_KEY: key }, encoding: "utf8", timeout: 150_000,
  });
}

test.afterAll(async () => { await scenario({ demo: "normal", trafficDrop: null }); });

test("regressions are detected, alerted, gated in CI and auto-resolved when fixed", async ({ page }) => {
  test.setTimeout(420_000);
  await scenario({ demo: "normal", trafficDrop: null });
  const websiteId = await setupDemoWebsite(page, "monitor");
  const before = await inbox();

  // --- Alert channels and IndexNow ---
  await page.goto(`/integrations?website=${websiteId}`);
  await expect(page.getByTestId("integration-slack")).toBeVisible();
  await connectOutbound(page, "slack", { "Incoming webhook URL": "https://hooks.slack.com/services/T000/B000/e2e0123456" });
  await connectOutbound(page, "webhook", { "Endpoint URL": `${MOCK_API}/__mock/webhook` }); // signing secret is pre-filled
  await connectOutbound(page, "indexnow", {}); // key is pre-filled; the demo site serves <key>.txt
  const afterConnect = await inbox();
  expect(afterConnect.slack.length).toBe(before.slack.length + 1); // test message on connect
  expect(afterConnect.slack.at(-1)!.text).toContain("SEO Automation Hub is connected");

  // --- Baseline audit, then a release that breaks SEO ---
  await runAudit(page, websiteId);
  await scenario({ demo: "regression" });
  const row = await runAudit(page, websiteId);
  await expect(row).toContainText(/\d+ regressions?, \d+ changes? vs previous audit/);

  await page.goto(`/monitoring?website=${websiteId}`);
  const alerts = page.getByTestId("alerts");
  await expect(alerts).toContainText("Page became noindex");
  await expect(alerts).toContainText("Page now returns 500");
  await expect(alerts).toContainText("Canonical now points to another URL");
  await expect(alerts).toContainText("Title changed");
  await expect(alerts.getByTestId("alert").filter({ hasText: "Page became noindex" })).toContainText('<meta name="robots" content="noindex">');
  await expect(alerts).toContainText("slack: sent");
  const delivered = await inbox();
  expect(delivered.slack.at(-1)!.text).toMatch(/SEO alerts? for Acme Dental \(\d+ critical/);
  const hook = delivered.webhooks.at(-1)!;
  expect(hook.headers["x-seohub-signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
  expect(JSON.parse(hook.body).alerts.some((a: { kind: string }) => a.kind === "noindex_added")).toBe(true);

  // Changed pages were submitted to IndexNow automatically.
  await waitForTask(page, `/monitoring?website=${websiteId}`, "IndexNow submission");
  expect((await inbox()).indexnow.at(-1)!.urlList.some((u) => u.endsWith("/blog/implant-recovery"))).toBe(true);

  // --- CI: API key + deploy gate CLI fails the pipeline ---
  await page.goto("/developer");
  await page.getByRole("button", { name: "Create API key" }).click();
  const key = (await page.getByTestId("new-api-key").locator("code").innerText()).trim();
  expect(key).toMatch(/^seoh_[a-z0-9]{10}_/);
  const failed = gateCli(websiteId, key);
  expect(failed.status, failed.stderr).toBe(1);
  expect(failed.stdout).toContain("FAILED");
  expect(failed.stdout).toMatch(/error\s+\/dental-implants\s+Page is noindex/);
  expect(gateCli(websiteId, "seoh_aaaaaaaaaa_" + "x".repeat(43)).status).toBe(2); // bad key → cannot run
  await page.goto("/developer");
  await expect(page.getByTestId("gate-runs")).toContainText("failed");
  await page.goto(`/monitoring?website=${websiteId}`);
  await expect(page.getByTestId("alerts")).toContainText("SEO deploy gate failed");

  // --- Fix the release: alerts close themselves, the gate passes ---
  await scenario({ demo: "normal" });
  await runAudit(page, websiteId);
  const passed = gateCli(websiteId, key);
  expect(passed.status, passed.stdout + passed.stderr).toBe(0);
  expect(passed.stdout).toContain("PASSED");
  await page.goto(`/monitoring?website=${websiteId}`);
  const resolved = page.getByTestId("resolved-alerts");
  await expect(resolved).toContainText("Page became noindex");
  await expect(resolved).toContainText("Page now returns 500");
  await expect(resolved).toContainText("SEO deploy gate failed");
  await expect(page.getByTestId("alerts")).not.toContainText("Page became noindex");
  // Change events (title changed) stay open until a person resolves them.
  const titleAlert = page.getByTestId("alerts").getByTestId("alert").filter({ hasText: "Title changed" }).first();
  await titleAlert.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByTestId("resolved-alerts")).toContainText("Resolved by a team member");
});
