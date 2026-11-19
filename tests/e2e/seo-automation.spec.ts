import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { signUp } from "./helpers";
import { connect, DEMO_SITE, waitForTask } from "./seo-helpers";

/**
 * Full SEO automation flow against the local mocks (npm run dev:all):
 * integrations → analytics sync → dashboard & insights → site audit → keywords, clustering,
 * rank/AI-visibility checks → AI-generated draft with SEO tools → programmatic templates.
 * All external data is synthetic (dev/mock-analytics); AI output comes from LLM_PROVIDER=mock.
 */
test("SEO automation: integrations, analytics, audit, keywords, AI drafts and templates", async ({ page }) => {
  test.setTimeout(420_000);
  const run = Date.now();
  await signUp(page, `seo-${run}@example.test`, `SEO Agency ${run}`);
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
  const websiteId = page.url().split("/").pop()!;

  // --- Integrations (credentials are verified against the provider before saving) ---
  await page.goto(`/integrations?website=${websiteId}`);
  const sa = readFileSync(process.env.MOCK_GOOGLE_SERVICE_ACCOUNT_FILE!, "utf8");
  await connect(page, "google_search_console", { "Service account key (JSON)": sa });
  await expect(page.getByTestId("integration-google_search_console")).toContainText(`${DEMO_SITE}/`);
  await connect(page, "google_analytics_4", { "Service account key (JSON)": sa, "GA4 property ID": "123456789" });
  await connect(page, "microsoft_clarity", { "Data export API token": process.env.MOCK_CLARITY_TOKEN! });
  await connect(page, "dataforseo", { "API login": process.env.MOCK_DATAFORSEO_LOGIN!, "API password": process.env.MOCK_DATAFORSEO_PASSWORD! });
  await connect(page, "similarweb", { "API key": process.env.MOCK_SIMILARWEB_KEY! });
  await connect(page, "pagespeed", {});

  // Wrong credentials are rejected and nothing is stored.
  await page.getByTestId("integration-microsoft_clarity").getByRole("button", { name: "Replace credentials" }).click();
  await page.getByRole("dialog").getByLabel("Data export API token").fill("not-the-right-token-0000000");
  await page.getByRole("dialog").getByRole("button", { name: "Test & save" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Microsoft Clarity rejected the credentials");
  await page.keyboard.press("Escape");

  // Autopilot schedule.
  await page.getByTestId("schedules").locator("li", { hasText: "Analytics sync" }).getByRole("button", { name: "Off" }).click();
  await expect(page.getByTestId("schedules").locator("li", { hasText: "Analytics sync" }).getByRole("button", { name: "On" })).toBeVisible();

  // --- Analytics sync & dashboard ---
  await page.goto(`/analytics?website=${websiteId}`);
  await page.waitForLoadState("networkidle"); // a cold dev server can serve the button before it is interactive
  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText(/Analytics sync queued/)).toBeVisible();
  await waitForTask(page, `/integrations?website=${websiteId}`, "Analytics sync");
  await page.goto(`/analytics?website=${websiteId}`);
  await expect(page.getByTestId("analytics-kpis")).toContainText("Clicks");
  await expect(page.getByTestId("analytics-kpis").getByText("Connect GA4")).toHaveCount(0);
  const insights = page.getByTestId("insights");
  await expect(insights).toContainText("Striking distance");
  await expect(insights).toContainText("Cannibalization");
  await expect(insights).toContainText("Content decay");
  await expect(insights).toContainText("Low CTR");
  await expect(page.getByText("Traffic estimate (Similarweb)").locator("..")).toContainText("visits");
  const csv = await page.request.get(`/api/analytics/export?website=${websiteId}&days=90`);
  expect(csv.status()).toBe(200);
  expect((await csv.text()).split("\n")[0]).toBe("date,query,page,clicks,impressions,position");

  // --- Technical audit ---
  await page.goto(`/audits?website=${websiteId}`);
  await page.waitForLoadState("networkidle"); // a cold dev server can serve the button before it is interactive
  await page.getByRole("button", { name: "Run audit (100 pages)" }).click();
  await expect(page.getByText(/Site audit queued/)).toBeVisible();
  const auditRow = await waitForTask(page, `/audits?website=${websiteId}`, "Site audit");
  await auditRow.getByRole("link").click();
  await expect(page.getByTestId("audit-score")).toHaveText(/^\d+$/);
  const issues = page.getByTestId("audit-issues");
  await expect(issues).toContainText("Page returns 4xx");
  await expect(issues).toContainText("Duplicate title");
  await expect(issues).toContainText("Orphan page");
  await expect(issues).toContainText("Not indexed by Google");
  await expect(page.getByText("Blocked: GPTBot")).toBeVisible();
  // Each finding shows its proof: duplicate titles name the other URL.
  await issues.getByRole("link", { name: "Duplicate title" }).click();
  await expect(page.getByTestId("evidence").first()).toContainText(/Same as http:\/\/localhost:8792\/(dental-implants|blog\/implant-recovery)/);
  await expect(page.getByText(/mobile · performance 71/)).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("audit-export").getByText("Export issues (CSV)").click()]);
  expect(download.suggestedFilename()).toMatch(/^Acme-Dental-audit-\d{4}-\d{2}-\d{2}-issues\.csv$/);
  const issuesCsv = readFileSync(await download.path(), "utf8");
  expect(issuesCsv.split("\n")[0]).toBe("\uFEFFseverity,issue,issue_code,url,status_code,evidence,how_to_fix");
  expect(issuesCsv).toContain("Same as http://localhost:8792/blog/implant-recovery");
  expect(issuesCsv).toContain("http_4xx");
  const auditId = page.url().split("/").pop()!.split("?")[0];
  const pagesCsv = await page.request.get(`/api/audits/${auditId}/export?format=pages`);
  expect((await pagesCsv.text()).split("\n")).toHaveLength(11); // header + 10 pages
  const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("audit-export").getByText("Download PDF report").click()]);
  expect(pdf.suggestedFilename()).toMatch(/^Acme-Dental-audit-\d{4}-\d{2}-\d{2}\.pdf$/);
  expect(readFileSync(await pdf.path()).subarray(0, 5).toString()).toBe("%PDF-");
  const report = await (await page.request.get(`/api/audits/${auditId}/export?format=json`)).json();
  expect(report.website.name).toBe("Acme Dental");
  expect(report.issues[0].severity).toBe("error");

  // --- Keywords: imported from Search Console, clustered, tracked, rank-checked ---
  await page.goto(`/keywords?website=${websiteId}`);
  await expect(page.getByTestId("keyword-row").first()).toBeVisible();
  await page.getByLabel("Add keywords").fill("dental implant prices,500\ncheap dental implants");
  await page.getByRole("button", { name: "Add keywords" }).click();
  await expect(page.getByTestId("keyword-row").filter({ hasText: "cheap dental implants" })).toBeVisible();
  await page.getByRole("button", { name: "Cluster keywords" }).click();
  await expect(page.getByTestId("cluster-list")).toContainText("Dental Implant");
  await page.getByLabel("Select all").click();
  await page.getByRole("button", { name: "Track", exact: true }).click();
  await expect(page.getByText("tracked", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Check rankings now" }).click();
  await waitForTask(page, `/integrations?website=${websiteId}`, "Rank check");
  await page.goto(`/integrations?website=${websiteId}`);
  await expect(page.getByTestId("task-list").locator("li", { hasText: "Rank check" }).first()).toContainText(/\d+\/\d+ ranking/);

  // --- AI visibility check (mock AI engine, labelled) ---
  await page.goto(`/keywords?website=${websiteId}`);
  await page.getByLabel("Select all").click();
  await page.getByLabel("Select all").click(); // clear
  await page.getByTestId("keyword-row").first().getByRole("checkbox").click();
  await page.getByRole("button", { name: "Check AI visibility" }).click();
  const vis = await waitForTask(page, `/integrations?website=${websiteId}`, "AI visibility check");
  await expect(vis).toContainText("(mock)");
  await page.goto(`/analytics?website=${websiteId}`);
  await expect(page.getByTestId("ai-visibility-summary")).toContainText("queries where an AI answer cites this site");

  // --- AI studio: draft from a keyword cluster ---
  await page.goto(`/keywords?website=${websiteId}`);
  await page.getByTestId("cluster-list").getByRole("link", { name: "Write article with AI" }).first().click();
  await expect(page.getByTestId("llm-status")).toContainText("Development mock");
  await expect(page.getByLabel("Primary keyword")).not.toHaveValue("");
  await page.getByRole("button", { name: "Generate draft" }).click();
  const gen = await waitForTask(page, "/ai-studio", "AI article");
  await gen.getByRole("link", { name: /Open draft/ }).click();
  await expect(page.getByText("AI draft", { exact: true })).toBeVisible();
  await expect(page.getByTestId("ai-brief")).toContainText("mock output");
  await expect(page.getByTestId("content-status")).toHaveText("Draft");
  await expect(page.getByTestId("ai-readiness")).toContainText(/\d+\/100/);
  await expect(page.getByTestId("internal-links")).toBeVisible();
  await page.getByTestId("schema-generator").getByRole("button", { name: "Generate & save" }).click();
  await expect(page.getByTestId("schema-output")).toContainText('"FAQPage"');
  await page.getByRole("button", { name: "Run SEO validation" }).click();
  await expect(page.getByTestId("validation-status")).not.toHaveText("Not validated", { timeout: 30_000 });
  await expect(page.getByTestId("qa-results").first()).toContainText("AI search readiness");

  // --- Programmatic templates ---
  await page.goto("/templates");
  await page.getByLabel("Website", { exact: true }).selectOption({ label: "Acme Dental" });
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.getByText("Template saved")).toBeVisible();
  await page.getByRole("button", { name: "Preview pages" }).click();
  const preview = page.getByTestId("template-preview");
  await expect(preview).toContainText("2 of 2 rows valid");
  await expect(preview).toContainText("Boiler Repair in Leeds");
  await page.getByRole("button", { name: "Create 2 drafts" }).click();
  await expect(page).toHaveURL(/\/content$/);
  await expect(page.getByText("Boiler Repair in York — Acme Heating")).toBeVisible();
});
