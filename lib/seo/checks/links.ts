import { result, rule } from "@/lib/seo/checks/helpers";
import { isAppError } from "@/lib/errors";
import type { CheckResult, SeoCheck } from "@/lib/seo/types";

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

function classify(href: string, base: string): { kind: "anchor" | "relative" | "absolute" | "invalid" | "unsafe"; url?: URL } {
  const h = href.trim();
  if (!h) return { kind: "invalid" };
  if (h.startsWith("#")) return { kind: "anchor" };
  if (/\s/.test(h) && !/^mailto:/i.test(h)) return { kind: "invalid" };
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(h)) {
      const url = new URL(h);
      if (!SAFE_SCHEMES.has(url.protocol)) return { kind: "unsafe", url };
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname.includes(".") && url.hostname !== "localhost") {
        return { kind: "invalid", url };
      }
      return { kind: "absolute", url };
    }
    if (h.startsWith("//")) return { kind: "absolute", url: new URL(`https:${h}`) };
    return { kind: "relative", url: new URL(h, base + "/") };
  } catch {
    return { kind: "invalid" };
  }
}

export const urlSyntax: SeoCheck = {
  name: "url_syntax",
  label: "Malformed or unsafe URLs",
  kind: "technical",
  defaultSeverity: "error",
  run(ctx) {
    const refs = [
      ...ctx.parsed.links.map((l) => ({ href: l.href, where: "link" })),
      ...ctx.parsed.images.filter((i) => i.src !== undefined).map((i) => ({ href: i.src!, where: "image" })),
    ];
    if (!refs.length) return [result(this, ctx, "skipped", "No links or images in the content.", { field: "body", severity: "info" })];
    const out: CheckResult[] = [];
    for (const r of refs) {
      const c = classify(r.href, ctx.website.baseUrl);
      if (c.kind === "invalid") {
        out.push(result(this, ctx, "fail", `Malformed ${r.where} URL.`, { field: "body", url: r.href.slice(0, 500), remediation: "Fix the URL or remove the link." }));
      } else if (c.kind === "unsafe") {
        out.push(result(this, ctx, "fail", `Unsafe URL scheme (${c.url!.protocol}) in ${r.where}.`, { field: "body", url: r.href.slice(0, 200), remediation: "Use http(s) links only." }));
      }
    }
    return out.length ? out : [result(this, ctx, "pass", `${refs.length} URL(s) are well-formed.`, { field: "body" })];
  },
};

/**
 * Checks that links to the same website resolve. Bounded by maxLinks, run with
 * limited concurrency through the SSRF-safe HTTP client.
 */
export const internalLinks: SeoCheck = {
  name: "internal_links",
  label: "Internal link destinations",
  kind: "technical",
  defaultSeverity: "warning",
  async run(ctx) {
    const maxLinks = Number(rule(ctx, this.name).maxLinks ?? 20);
    let siteHost: string;
    try {
      siteHost = new URL(ctx.website.baseUrl).hostname.toLowerCase();
    } catch {
      return [result(this, ctx, "skipped", "Website URL is invalid.", { severity: "info" })];
    }
    const targets = new Map<string, string>();
    for (const l of ctx.parsed.links) {
      const c = classify(l.href, ctx.website.baseUrl);
      if ((c.kind === "relative" || c.kind === "absolute") && c.url && /^https?:$/.test(c.url.protocol)) {
        if (c.url.hostname.toLowerCase().replace(/^www\./, "") === siteHost.replace(/^www\./, "")) {
          const u = new URL(c.url);
          u.hash = "";
          targets.set(u.toString(), l.href);
        }
      }
    }
    if (!targets.size) return [result(this, ctx, "skipped", "No internal links to check.", { field: "body", severity: "info" })];
    if (!ctx.http) return [result(this, ctx, "skipped", "Link checking is not available in this context.", { severity: "info" })];

    const list = [...targets.keys()].slice(0, maxLinks);
    const out: CheckResult[] = [];
    const queue = [...list];
    const http = ctx.http;
    const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) {
        try {
          let res = await http(url, { method: "HEAD", timeoutMs: 8000, maxBytes: 1024 });
          if (res.status === 405 || res.status === 501) res = await http(url, { method: "GET", timeoutMs: 8000, maxBytes: 512 * 1024 });
          if (res.status >= 400) {
            out.push(result(this, ctx, "fail", `Internal link returns HTTP ${res.status}.`, { field: "body", url, details: { status: res.status }, remediation: "Update or remove the link." }));
          }
        } catch (err) {
          out.push(result(this, ctx, "fail", `Internal link could not be checked: ${isAppError(err) ? err.message : "request failed"}`, {
            field: "body", url, severity: "warning",
          }));
        }
      }
    });
    await Promise.all(workers);
    if (targets.size > list.length) {
      out.push(result(this, ctx, "skipped", `Only the first ${list.length} of ${targets.size} internal links were checked.`, { severity: "info" }));
    }
    return out.some((r) => r.status === "fail") ? out : [result(this, ctx, "pass", `${list.length} internal link(s) resolve.`, { field: "body" }), ...out];
  },
};
