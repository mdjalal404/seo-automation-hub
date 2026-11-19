import { expect, test } from "@playwright/test";
import { AI_TEXT, HUMAN_TEXT } from "../support/ai-samples";
import { createArticle, signUp } from "./helpers";

test("AI-written content is shown with its estimated share alongside other warnings", async ({ page }) => {
  const run = Date.now();
  await signUp(page, `ai-${run}@example.test`, `AI Agency ${run}`);
  await page.goto("/clients");
  await page.getByRole("button", { name: "Add client" }).first().click();
  await page.getByLabel("Client name").fill("AI Client");
  await page.getByRole("button", { name: "Save client" }).click();
  await expect(page.getByRole("dialog")).toBeHidden(); // the save must finish before navigating away
  await page.goto("/websites");
  await page.getByRole("button", { name: "Add website" }).first().click();
  await page.getByLabel("Website name").fill("AI Site");
  await page.getByLabel("Website address").fill("https://ai-site.example.com");
  await page.getByRole("button", { name: "Save website" }).click();
  await expect(page).toHaveURL(/\/websites\/[0-9a-f-]{36}$/);

  // Mostly formulaic, LLM-style copy: flagged as a (non-blocking) warning with the percentage.
  await createArticle(page, { title: "Local SEO for small businesses", slug: `local-seo-ai-${run}`, body: `${AI_TEXT}\n\n## Next steps\n\n${AI_TEXT}` });
  await page.getByRole("button", { name: "Run SEO validation" }).click();
  await expect(page.getByTestId("content-status")).toHaveText("Ready for review", { timeout: 30_000 });
  const warning = page.getByTestId("qa-results").first().locator("li", { hasText: "AI-written content" });
  await expect(warning).toContainText("Warning");
  await expect(warning).toContainText(/about \d+% of the text reads as AI-generated/);
  await expect(warning.getByTestId("ai-share")).toContainText(/\d+% AI/);
  await expect(page.getByTestId("ai-badge")).toContainText(/AI-written · \d+%/);

  // Personal, varied writing: no warning; the header still shows the (low) estimate.
  await createArticle(page, { title: "What our site migration taught us", slug: `migration-story-${run}`, body: `${HUMAN_TEXT}\n\n${HUMAN_TEXT}` });
  await page.getByRole("button", { name: "Run SEO validation" }).click();
  await expect(page.getByTestId("validation-status")).not.toHaveText("Not validated", { timeout: 30_000 });
  await expect(page.getByTestId("ai-badge")).toContainText(/^AI \d+%$/);
  await expect(page.getByTestId("qa-results").first().locator("li", { hasText: "AI-written content" })).toHaveCount(0);
});
