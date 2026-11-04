import { expect, test, type Page } from "@playwright/test";
import { articleBody, createArticle, mock, MOCK_WP, publishNow, signIn, signUp, validateAndApprove, waitForStatus } from "./helpers";

const run = Date.now();
const owner = `owner-${run}@example.test`;
const outsider = `outsider-${run}@example.test`;
const viewer = `viewer-${run}@example.test`;
let page: Page;
let publishedUrl = "";

test.describe.serial("agency publishing journey (mock WordPress)", () => {
  test.beforeAll(async ({ browser }) => {
    await mock("reset");
    page = await browser.newPage();
  });
  test.afterAll(() => page.close());

  test("1. user signs up and creates a workspace", async () => {
    await signUp(page, owner, `E2E Agency ${run}`);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  });

  test("2. user creates a client", async () => {
    await page.goto("/clients");
    await page.getByRole("button", { name: "Add client" }).first().click();
    await page.getByLabel("Client name").fill("E2E Client");
    await page.getByRole("button", { name: "Save client" }).click();
    await expect(page.getByRole("link", { name: "E2E Client" })).toBeVisible();
  });

  test("3. user connects a test WordPress site (invalid credentials are rejected first)", async () => {
    await page.goto("/websites");
    await page.getByRole("button", { name: "Add website" }).first().click();
    await page.getByLabel("Website name").fill("E2E Mock Site");
    await page.getByLabel("Website address").fill(MOCK_WP);
    await page.getByLabel("Website timezone").selectOption("Europe/London");
    await page.getByRole("button", { name: "Save website" }).click();
    await expect(page).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);
    await expect(page.getByText("Development target").first()).toBeVisible();

    await page.getByLabel("WordPress username").fill(process.env.MOCK_WP_USER ?? "demo-editor");
    await page.getByLabel("Application password").fill("wrongwrongwrongwrongwron");
    await page.getByRole("button", { name: "Test and connect" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "rejected the credentials" })).toBeVisible();

    await page.getByLabel("Application password").fill(process.env.MOCK_WP_APP_PASSWORD!);
    await page.getByRole("button", { name: "Test and connect" }).click();
    await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("SEO plugins detected")).toBeVisible();
    await expect(page.getByText("yoast")).toBeVisible();
  });

  test("4-9. create, validate, review, approve and publish an article", async () => {
    await createArticle(page, {
      title: "Technical SEO audit checklist for agencies",
      slug: `technical-seo-audit-${run}`,
      body: articleBody("Technical SEO"),
      metaTitle: "Technical SEO audit checklist for busy agencies",
      metaDescription: "A practical technical SEO audit checklist covering crawling, indexing, internal links and structured data for agency teams.",
    });
    await page.getByRole("button", { name: "Run SEO validation" }).click();
    await expect(page.getByTestId("validation-status")).toHaveText(/Passed/, { timeout: 30_000 });
    await expect(page.getByTestId("qa-results").first()).toContainText("passed");

    await page.getByRole("button", { name: "Approve for publishing" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Approve" }).click();
    await expect(page.getByTestId("content-status")).toHaveText("Approved");

    await publishNow(page);
    const url = page.url();
    await waitForStatus(page, url, /^Published$/);

    // 10. verified: live page checks and SEO metadata confirmed + verified
    const verification = page.getByTestId("qa-results").nth(1);
    await expect(verification).toContainText("Published page is publicly accessible");
    await expect(page.getByTestId("seo-sync")).toContainText("Meta description");
    const syncRow = page.getByTestId("seo-sync").locator("tr", { hasText: "Meta description" });
    await expect(syncRow.locator("td").nth(4)).toHaveText("Yes");
    publishedUrl = (await page.getByRole("link", { name: /localhost:8787/ }).getAttribute("href")) ?? "";
    expect(publishedUrl).toContain(`technical-seo-audit-${run}`);
  });

  test("11-12. the job is completed in history and reflected on the dashboard", async () => {
    await page.goto("/job-history?type=PUBLISH");
    await expect(page.getByTestId("jobs-table")).toContainText("Completed");
    await page.goto("/dashboard");
    await expect(page.getByTestId("metric-success-rate")).toHaveText("100%");
    expect(Number(await page.getByTestId("metric-completed").innerText())).toBeGreaterThanOrEqual(2);
    expect(Number(await page.getByTestId("metric-connected").innerText())).toBe(1);
  });

  test("failed validation blocks approval", async () => {
    await createArticle(page, {
      title: "Bad",
      slug: `bad-article-${run}`,
      body: `# Title in body\n\n#### Skipped level\n\n[click](javascript:alert(1))\n\n<img src="https://example.com/x.png">`,
    });
    await page.getByRole("button", { name: "Run SEO validation" }).click();
    await expect(page.getByTestId("content-status")).toHaveText("Validation failed", { timeout: 30_000 });
    await expect(page.getByTestId("qa-results").first()).toContainText("Unsafe URL scheme");
    await expect(page.getByRole("button", { name: "Approve for publishing" })).toHaveCount(0);
  });

  test("missing SEO plugin support is reported, not claimed as saved", async () => {
    await mock("mode", { exposeSeoMeta: false });
    await createArticle(page, {
      title: "Content pruning guide for large blogs",
      slug: `content-pruning-${run}`,
      body: articleBody("Content pruning"),
      metaTitle: "Content pruning guide for large blogs and publishers",
      metaDescription: "How to decide which old blog posts to update, merge or remove, with a repeatable content pruning process for agencies.",
    });
    await validateAndApprove(page);
    await publishNow(page);
    await waitForStatus(page, page.url(), /^Published$/);
    const row = page.getByTestId("seo-sync").locator("tr", { hasText: "Meta description" });
    await expect(row).toContainText(/exposed (in|via) the REST API/);
    await expect(row.locator("td").nth(2)).toHaveText("No"); // not sent
    await mock("mode", { exposeSeoMeta: true });
  });

  test("failed post-publication verification needs investigation and can be retried", async () => {
    await mock("mode", { breakRendering: true });
    await createArticle(page, {
      title: "Schema markup basics for local businesses",
      slug: `schema-basics-${run}`,
      body: articleBody("Schema markup"),
      metaTitle: "Schema markup basics for local business websites",
      metaDescription: "An introduction to schema markup for local businesses: which types matter, how to add them and how to test them.",
    });
    await validateAndApprove(page);
    await publishNow(page);
    const url = page.url();
    await waitForStatus(page, url, /^Verification failed$/);
    await expect(page.getByTestId("qa-results").nth(1)).toContainText("does not match");

    await mock("mode", { breakRendering: false });
    await page.goto("/job-history?status=FAILED");
    await page.getByRole("row").filter({ hasText: "Schema markup basics" }).getByRole("button", { name: "Retry" }).click();
    await waitForStatus(page, url, /^Published$/);
  });

  test("transient WordPress errors are retried with backoff", async () => {
    await mock("faults", { method: "GET", path: "^/wp/v2/posts$", status: 503 });
    await createArticle(page, {
      title: "Core Web Vitals for WordPress sites",
      slug: `core-web-vitals-${run}`,
      body: articleBody("Core Web Vitals"),
      metaTitle: "Core Web Vitals for WordPress sites: a field guide",
      metaDescription: "What Core Web Vitals measure, why WordPress sites struggle with them, and the fixes that move the numbers the most.",
    });
    await validateAndApprove(page);
    await publishNow(page);
    // Server-rendered page: reload until the worker has processed the job.
    await expect(async () => {
      await page.goto("/content-queue");
      await expect(page.getByTestId("jobs-table")).toContainText("Retry scheduled", { timeout: 1000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByTestId("jobs-table")).toContainText("WP_SERVER_ERROR");
  });

  test("viewers cannot change data; outsiders cannot reach another workspace's records", async ({ browser }) => {
    await page.goto("/content");
    const firstArticle = await page.getByRole("link", { name: "Technical SEO audit checklist for agencies" }).getAttribute("href");

    // Outsider: separate workspace, guesses the URL.
    const other = await browser.newPage();
    await signUp(other, outsider, `Outsider ${run}`);
    await other.goto(firstArticle!);
    await expect(other.getByText("This record does not exist in your current workspace.")).toBeVisible();
    await other.close();

    // Viewer added to the owner's workspace.
    const v = await browser.newPage();
    await signUp(v, viewer, `Viewer Own ${run}`);
    await page.goto("/settings");
    await page.getByLabel("Add an existing user by email").fill(viewer);
    await page.getByLabel("Role", { exact: true }).selectOption("viewer");
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText(viewer)).toBeVisible();

    await v.goto("/dashboard");
    await v.getByLabel("Workspace").selectOption({ label: `E2E Agency ${run} (viewer)` });
    await v.waitForTimeout(1000);
    await v.goto(firstArticle!);
    await expect(v.getByText("You can view but not edit this article.")).toBeVisible();
    await expect(v.getByRole("button", { name: "Run SEO validation" })).toHaveCount(0);
    await expect(v.getByRole("button", { name: "Publish…" })).toHaveCount(0);
    await v.goto("/content/new");
    await expect(v.getByText("Viewers cannot create content")).toBeVisible();
    await v.goto("/clients");
    await expect(v.getByRole("button", { name: "Add client" })).toHaveCount(0);
    await v.close();
  });

  test("expired sessions are sent back to sign in", async ({ browser }) => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await signIn(p, owner);
    await ctx.clearCookies();
    await p.goto("/content");
    await expect(p).toHaveURL(/\/login\?next=%2Fcontent/);
    await ctx.close();
  });

  test("login attempts are rate limited", async ({ browser }) => {
    const p = await browser.newPage();
    const target = `ratelimit-${run}@example.test`;
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++) {
      await p.goto("/login");
      await p.getByLabel("Email").fill(target);
      await p.getByLabel("Password").fill("not-the-password");
      await p.getByRole("button", { name: "Sign in" }).click();
      const alert = p.getByRole("alert").filter({ hasText: /Incorrect email or password|Too many attempts/ });
      await expect(alert).toBeVisible();
      limited = /Too many attempts/.test(await alert.innerText());
    }
    expect(limited).toBe(true);
    await p.close();
  });
});
