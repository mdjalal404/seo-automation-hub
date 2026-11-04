import { expect, test, type Page } from "@playwright/test";
import { articleBody, createArticle, mock, MOCK_CUSTOM, MOCK_SHOPIFY, MOCK_WEBFLOW, publishNow, signUp, validateAndApprove, waitForStatus } from "./helpers";

const run = Date.now();
let page: Page;

type Platform = {
  label: string;
  site: string;
  origin: string;
  connect: (p: Page, valid: boolean) => Promise<void>;
  wrongTokenError: RegExp;
  livePath: (slug: string) => string;
};

const PLATFORMS: Platform[] = [
  {
    label: "Webflow", site: "E2E Webflow Site", origin: MOCK_WEBFLOW,
    connect: async (p, valid) => {
      await p.getByLabel("Webflow API token").fill(valid ? process.env.MOCK_WEBFLOW_TOKEN! : "f".repeat(64));
      await p.getByLabel("Collection ID").fill("65f0c0ffee0000000000b10b");
    },
    wrongTokenError: /Webflow rejected the API token/,
    livePath: (slug) => `/blog/${slug}`,
  },
  {
    label: "Shopify", site: "E2E Shopify Store", origin: MOCK_SHOPIFY,
    connect: async (p, valid) => {
      await p.getByLabel("Shop domain").fill("mock-store.myshopify.com");
      await p.getByLabel("Admin API access token").fill(valid ? process.env.MOCK_SHOPIFY_TOKEN! : "shpat_" + "0".repeat(32));
    },
    wrongTokenError: /Shopify rejected the API token/,
    livePath: (slug) => `/blogs/news/${slug}`,
  },
  {
    label: "Custom CMS", site: "E2E Custom Site", origin: MOCK_CUSTOM,
    connect: async (p, valid) => {
      await p.getByLabel("API base URL").fill(`${MOCK_CUSTOM}/api/v1`);
      await p.getByLabel("API token", { exact: true }).fill(valid ? process.env.MOCK_CUSTOM_TOKEN! : "not-the-right-token-123");
    },
    wrongTokenError: /Custom CMS rejected the API token/,
    livePath: (slug) => `/posts/${slug}`,
  },
];

test.describe.serial("publishing to Webflow, Shopify and a custom CMS (mocks)", () => {
  test.beforeAll(async ({ browser }) => {
    for (const p of PLATFORMS) await mock("reset", {}, p.origin);
    page = await browser.newPage();
    await signUp(page, `platforms-${run}@example.test`, `Platforms Agency ${run}`);
    await page.goto("/clients");
    await page.getByRole("button", { name: "Add client" }).first().click();
    await page.getByLabel("Client name").fill("Multi-platform Client");
    await page.getByRole("button", { name: "Save client" }).click();
    await expect(page.getByRole("link", { name: "Multi-platform Client" })).toBeVisible();
  });
  test.afterAll(() => page.close());

  for (const p of PLATFORMS) {
    test(`${p.label}: connect (bad token rejected), validate, approve, publish and verify`, async () => {
      await page.goto("/websites");
      await page.getByRole("button", { name: "Add website" }).first().click();
      await page.getByLabel("Platform").selectOption({ label: p.label });
      await page.getByLabel("Website name").fill(p.site);
      await page.getByLabel("Website address").fill(p.origin);
      await page.getByLabel("Website timezone").selectOption("UTC");
      await page.getByRole("button", { name: "Save website" }).click();
      await expect(page).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { name: `${p.label} connection` })).toBeVisible();

      await p.connect(page, false);
      await page.getByRole("button", { name: "Test and connect" }).click();
      await expect(page.getByRole("alert").filter({ hasText: p.wrongTokenError })).toBeVisible();
      await p.connect(page, true);
      await page.getByRole("button", { name: "Test and connect" }).click();
      await expect(page.getByText("Connected", { exact: true }).first()).toBeVisible();

      const slug = `${p.label.toLowerCase().replace(/\s+/g, "-")}-guide-${run}`;
      await createArticle(page, {
        website: `Multi-platform Client — ${p.site}`,
        title: `Internal linking guide for ${p.label} sites`,
        slug,
        body: articleBody("Internal linking"),
        metaTitle: `Internal linking guide for ${p.label} websites`,
        metaDescription: `A practical internal linking guide for ${p.label} websites: hub pages, anchor text and finding orphaned pages.`,
      });
      await validateAndApprove(page);
      await publishNow(page);
      await waitForStatus(page, page.url(), /^Published$/);

      await expect(page.getByTestId("qa-results").nth(1)).toContainText("Published page is publicly accessible");
      const desc = page.getByTestId("seo-sync").locator("tr", { hasText: "Meta description" });
      await expect(desc.locator("td").nth(3)).toHaveText("Yes"); // confirmed by the CMS API
      await expect(desc.locator("td").nth(4)).toHaveText("Yes"); // verified on the live page
      const href = await page.getByRole("link", { name: new RegExp(p.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).getAttribute("href");
      expect(href).toBe(`${p.origin}${p.livePath(slug)}`);
    });
  }

  test("the websites list shows each platform", async () => {
    await page.goto("/websites");
    for (const p of PLATFORMS) await expect(page.getByRole("row").filter({ hasText: p.site })).toContainText(p.label);
  });
});
