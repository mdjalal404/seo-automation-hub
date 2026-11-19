import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { createArticle } from "./helpers";
import { connect, DEMO_SITE, setupDemoWebsite, waitForTask } from "./seo-helpers";

/**
 * Agentic workflow with human approval, crawl-budget log analysis, hreflang, content QA at scale,
 * Mixpanel/Databricks pipelines, multi-market tracking and impact reporting — against local mocks
 * (LLM_PROVIDER=mock runs a scripted agent: real tool calls, no model).
 */
test("agent proposals, log analysis, content QA and warehouse export", async ({ page }) => {
  test.setTimeout(360_000);
  const websiteId = await setupDemoWebsite(page, "agent");

  await page.goto(`/integrations?website=${websiteId}`);
  await connect(page, "google_search_console", { "Service account key (JSON)": readFileSync(process.env.MOCK_GOOGLE_SERVICE_ACCOUNT_FILE!, "utf8") });
  await connect(page, "dataforseo", { "API login": process.env.MOCK_DATAFORSEO_LOGIN!, "API password": process.env.MOCK_DATAFORSEO_PASSWORD!, "Extra markets (optional)": "UK:2826:en, DE:2276:de" });
  await connect(page, "mixpanel", {
    "Service account username": process.env.MOCK_MIXPANEL_USERNAME!, "Service account secret": process.env.MOCK_MIXPANEL_SECRET!, "Project ID": "1234567", "Conversion event": "Purchase",
  });
  await connect(page, "databricks", { "Workspace host": "dbc-mock.cloud.databricks.com", "Access token": process.env.MOCK_DATABRICKS_TOKEN!, "SQL warehouse ID": "abcdef1234567890" });

  // Data in: Search Console + Mixpanel sync, then a crawl (hreflang, crawl-budget hygiene).
  await page.goto(`/analytics?website=${websiteId}`);
  await page.getByRole("button", { name: "Sync now" }).click();
  const sync = await waitForTask(page, `/integrations?website=${websiteId}`, "Analytics sync");
  await expect(sync).toContainText("mixpanel");
  await page.goto(`/audits?website=${websiteId}`);
  await page.getByRole("button", { name: "Run audit (100 pages)" }).click();
  const auditRow = await waitForTask(page, `/audits?website=${websiteId}`, "Site audit");
  await auditRow.getByRole("link").click();
  await expect(page.getByTestId("audit-issues")).toContainText("hreflang target does not link back");

  // Multi-market rank tracking.
  await page.goto(`/keywords?website=${websiteId}`);
  await page.getByTestId("keyword-row").first().getByRole("checkbox").click();
  await page.getByRole("button", { name: "Track", exact: true }).click();
  await expect(page.getByText("tracked", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Check rankings now" }).click();
  await waitForTask(page, `/integrations?website=${websiteId}`, "Rank check");

  // Agent: investigates with tools and files proposals; nothing changes until approved.
  await page.goto(`/agent?website=${websiteId}`);
  await expect(page.getByTestId("agent-model")).toContainText("Development mock");
  await page.getByRole("button", { name: "Run agent" }).click();
  const agentTask = await waitForTask(page, `/agent?website=${websiteId}`, "SEO agent run");
  await agentTask.getByRole("link").click();
  await expect(page.getByTestId("agent-report")).toContainText("Mock agent report");
  await expect(page.getByTestId("agent-steps")).toContainText("find_opportunities");
  await expect(page.getByTestId("agent-steps")).toContainText("propose_action");
  const proposals = page.getByTestId("proposals");
  const fix = proposals.locator("li", { hasText: "Fix:" }).first();
  await expect(fix).toContainText("technical fix");
  await fix.getByRole("button", { name: "Approve" }).click();
  await expect(fix).toContainText("approved");
  await fix.getByRole("button", { name: "Mark done" }).click();
  await expect(fix).toContainText("done");
  const other = proposals.locator("li", { hasText: "proposed" }).first();
  await other.getByRole("button", { name: "Reject" }).click();
  await expect(proposals.locator("li", { hasText: "rejected" }).first()).toBeVisible();

  // Crawl budget: upload a server log.
  await page.goto(`/crawl-budget?website=${websiteId}`);
  const log = await (await fetch(`${DEMO_SITE}/__mock/access.log`)).text();
  await page.getByLabel(/Access log/).setInputFiles({ name: "access.log", mimeType: "text/plain", buffer: Buffer.from(log) });
  await page.getByRole("button", { name: "Analyze log" }).click();
  await expect(page.getByTestId("log-kpis")).toContainText("Googlebot requests");
  await expect(page.getByTestId("log-kpis")).toContainText("Crawl waste");
  await expect(page.getByTestId("log-bots")).toContainText("GPTBot");
  await expect(page.getByTestId("crawl-hygiene")).toContainText("hreflang on 1 pages (de, en)");

  // Content QA at scale.
  await createArticle(page, { title: "Dental implant aftercare", slug: `aftercare-${Date.now()}`, body: "Dental implants need daily care. ".repeat(80), website: "Acme Dental Group — Acme Dental" });
  await page.goto(`/content-qa?website=${websiteId}`);
  await page.getByRole("button", { name: "Review all content" }).click();
  await waitForTask(page, `/content-qa?website=${websiteId}`, "Content QA");
  await page.goto(`/content-qa?website=${websiteId}`);
  await expect(page.getByTestId("qa-items")).toContainText(/pass|need revision|fail|needs revision/);
  await expect(page.getByTestId("qa-kpis")).toContainText("1/1");

  // Warehouse export (Databricks).
  await page.goto(`/integrations?website=${websiteId}`);
  await page.getByTestId("schedules").locator("li", { hasText: "Databricks export" }).getByRole("button", { name: "Off" }).click();
  await expect(page.getByTestId("schedules").locator("li", { hasText: "Databricks export" }).getByRole("button", { name: "On" })).toBeVisible();
  const exp = await waitForTask(page, `/integrations?website=${websiteId}`, "Databricks export", 120_000);
  await expect(exp).toContainText(/Exported to main\.seo: \d+ search/);
  const stats = await (await fetch(`http://localhost:${process.env.MOCK_ANALYTICS_PORT ?? 8791}/databricks/__mock/statements`, { headers: { authorization: `Bearer ${process.env.MOCK_DATABRICKS_TOKEN}` } })).json();
  expect(stats.tables).toEqual(expect.arrayContaining(["seo_search_performance", "seo_keywords_snapshot", "seo_audit_pages"]));

  // Impact section renders.
  await page.goto(`/analytics?website=${websiteId}`);
  await expect(page.getByTestId("impact")).toBeVisible();
});
