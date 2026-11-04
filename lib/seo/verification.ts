import { findAll, textContent } from "domutils";
import { AppError } from "@/lib/errors";
import { extractCanonical, extractMeta, extractTitleTag, normalizeText, parseHtml } from "@/lib/seo/html";
import type { HttpClient } from "@/lib/security/safe-fetch";
import type { CheckResult } from "@/lib/seo/types";

export type VerificationExpectations = {
  title: string;
  /** HTML that was sent to the CMS as the post body. */
  bodyHtml: string;
  /** Only set for SEO fields the CMS confirmed it stored. */
  metaTitle?: string;
  metaDescription?: string;
  canonicalUrl?: string;
};

export type VerificationOutcome = {
  results: CheckResult[];
  passed: boolean;
  /** True when the failure may be transient (page not yet live, 5xx, cache warm-up). */
  transient: boolean;
  verifiedFields: Partial<Record<"meta_title" | "meta_description" | "canonical_url", boolean>>;
  httpStatus?: number;
};

const r = (checkName: string, status: CheckResult["status"], severity: CheckResult["severity"], message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  checkName, status, severity, kind: "technical", message, ...extra,
});

/** Fetches the rendered public page (no credentials) and checks what visitors actually get. */
export async function verifyLivePage(url: string, exp: VerificationExpectations, http: HttpClient): Promise<VerificationOutcome> {
  let res;
  try {
    res = await http(url, { method: "GET", timeoutMs: 15_000, maxBytes: 3 * 1024 * 1024, maxRedirects: 3 });
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError("NETWORK_ERROR", "Could not fetch the published page.", { retryable: true });
    return {
      results: [r("live_page_accessible", "fail", "error", `Published page could not be fetched: ${e.message}`, { url })],
      passed: false,
      transient: e.retryable,
      verifiedFields: {},
    };
  }

  const results: CheckResult[] = [];
  if (res.status !== 200) {
    results.push(r("live_page_accessible", "fail", "error", `Published page returned HTTP ${res.status}.`, {
      url, details: { status: res.status }, remediation: "Check that the post is public and not blocked by caching, maintenance mode or security plugins.",
    }));
    return { results, passed: false, transient: res.status === 404 || res.status === 429 || res.status >= 500, verifiedFields: {}, httpStatus: res.status };
  }
  results.push(r("live_page_accessible", "pass", "info", "Published page is publicly accessible (HTTP 200).", { url: res.url }));

  const page = parseHtml(res.text);
  const robots = extractMeta(page.doc, "robots") ?? "";
  if (/noindex/i.test(robots)) {
    results.push(r("live_page_indexable", "fail", "warning", "Published page has a robots noindex directive.", { url, remediation: "Check SEO plugin and WordPress reading settings." }));
  }

  const titleTag = extractTitleTag(page.doc) ?? "";
  const h1s = findAll((el) => el.name === "h1", page.doc.children).map((el) => normalizeText(textContent(el)));
  const wantTitle = normalizeText(exp.title).toLowerCase();
  const titleOk = titleTag.toLowerCase().includes(wantTitle) || h1s.some((h) => h.toLowerCase().includes(wantTitle));
  results.push(
    titleOk
      ? r("published_title", "pass", "info", "Post title appears on the live page.", { url })
      : r("published_title", "fail", "error", "Post title was not found in the page <title> or H1.", { url, details: { titleTag: titleTag.slice(0, 200), h1: h1s.slice(0, 3) } }),
  );

  const fragments = contentFragments(exp.bodyHtml);
  const pageText = page.text.toLowerCase();
  const found = fragments.filter((f) => pageText.includes(f.toLowerCase()));
  const contentOk = fragments.length === 0 ? page.wordCount > 0 : found.length >= Math.ceil(fragments.length * 0.66);
  results.push(
    contentOk
      ? r("published_content", "pass", "info", `Published content matches (${found.length}/${fragments.length} sampled passages found).`, { url })
      : r("published_content", "fail", "error", `Published content does not match what was sent (${found.length}/${fragments.length} sampled passages found).`, {
          url, remediation: "Check for theme/page-builder overrides, caching of an old version, or content filters.",
        }),
  );

  const verifiedFields: VerificationOutcome["verifiedFields"] = {};
  if (exp.metaTitle) {
    const ok = titleTag.toLowerCase().includes(normalizeText(exp.metaTitle).toLowerCase());
    verifiedFields.meta_title = ok;
    results.push(ok ? r("published_meta_title", "pass", "info", "SEO title is rendered in the page <title>.", { url })
      : r("published_meta_title", "fail", "warning", "SEO title was saved but is not rendered in the page <title>.", { url, details: { titleTag: titleTag.slice(0, 200) } }));
  }
  if (exp.metaDescription) {
    const actual = extractMeta(page.doc, "description");
    const ok = !!actual && actual === normalizeText(exp.metaDescription);
    verifiedFields.meta_description = ok;
    results.push(ok ? r("published_meta_description", "pass", "info", "Meta description is rendered on the page.", { url })
      : r("published_meta_description", "fail", "warning", "Meta description was saved but the page renders a different or no description.", { url, details: { actual: actual?.slice(0, 300) ?? null } }));
  }
  if (exp.canonicalUrl) {
    const actual = extractCanonical(page.doc);
    const ok = !!actual && stripSlash(actual) === stripSlash(exp.canonicalUrl);
    verifiedFields.canonical_url = ok;
    results.push(ok ? r("published_canonical", "pass", "info", "Canonical link is rendered on the page.", { url })
      : r("published_canonical", "fail", "warning", "Canonical URL was saved but the page renders a different canonical.", { url, details: { actual } }));
  }

  const passed = !results.some((x) => x.status === "fail" && x.severity === "error");
  return { results, passed, transient: false, verifiedFields, httpStatus: res.status };
}

/** Picks up to 5 distinctive passages (6–12 words) from the body to look for on the page. */
export function contentFragments(bodyHtml: string): string[] {
  const parsed = parseHtml(bodyHtml);
  const blocks = findAll((el) => ["p", "li", "h2", "h3"].includes(el.name), parsed.doc.children)
    .map((el) => normalizeText(textContent(el)))
    .filter((t) => t.split(" ").length >= 6);
  const picks = blocks.length ? blocks : parsed.text ? [parsed.text] : [];
  const step = Math.max(1, Math.floor(picks.length / 5));
  const out: string[] = [];
  for (let i = 0; i < picks.length && out.length < 5; i += step) out.push(picks[i].split(" ").slice(0, 10).join(" "));
  return out;
}

function stripSlash(u: string) {
  return u.trim().replace(/\/+$/, "");
}
