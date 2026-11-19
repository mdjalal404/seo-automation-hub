import PDFDocument from "pdfkit";
import { ISSUE_INFO, type SiteChecks } from "@/lib/audit/crawler";
import type { UrlInspection, WebVitals } from "@/lib/analytics/providers";
import { evidenceFor } from "@/lib/audit/export";

/**
 * Client-ready PDF of a stored site audit: summary, site checks, AI crawler access,
 * Core Web Vitals, indexation, issues with fixes, and the page list.
 * Uses the built-in Helvetica fonts (Latin text); other scripts are replaced with "?".
 */
type Audit = { id: string; created_at: string; score: number | null; pages_crawled: number; summary: Record<string, number>; site_checks: Record<string, unknown> };
type Page = { url: string; status_code: number | null; word_count: number | null; load_ms: number | null; inlinks: number; issues: string[]; title: string | null; details?: Record<string, unknown> };

const C = { text: "#111827", muted: "#6b7280", line: "#e5e7eb", error: "#b91c1c", warning: "#b45309", notice: "#4b5563", ok: "#047857", brand: "#1e3a8a" };
const SEV_ORDER = { error: 0, warning: 1, notice: 2 } as const;
const M = 48; // page margin

/** Standard PDF fonts only cover WinAnsi; keep common typography and replace the rest. */
function t(s: string | null | undefined): string {
  return (s ?? "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, "?");
}

export function auditPdf(audit: Audit, website: { name: string; base_url: string }, pages: Page[]): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margins: { top: M, bottom: M + 16, left: M, right: M }, bufferPages: true, info: { Title: t(`SEO audit - ${website.name}`), Creator: "SEO Automation Hub" } });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => { doc.on("end", () => resolve(Buffer.concat(chunks))); doc.on("error", reject); });

  const width = doc.page.width - 2 * M;
  const site = audit.site_checks as unknown as SiteChecks & { webVitals?: WebVitals[] | { error: string }; indexation?: (UrlInspection | { url: string; error: string })[]; partial?: boolean };
  const ensure = (h: number) => { if (doc.y + h > doc.page.height - M - 16) doc.addPage(); };
  const heading = (s: string) => {
    ensure(60);
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(13).fillColor(C.brand).text(t(s), M, doc.y, { width });
    doc.moveTo(M, doc.y + 3).lineTo(M + width, doc.y + 3).strokeColor(C.line).lineWidth(1).stroke();
    doc.moveDown(0.6).fillColor(C.text);
  };
  /** Simple table: column widths as fractions; rows wrap and break across pages. */
  const table = (cols: { label: string; w: number; color?: (row: string[]) => string }[], rows: string[][]) => {
    const xs = cols.reduce<number[]>((a, c, i) => [...a, i ? a[i - 1] + cols[i - 1].w * width : M], []);
    const header = () => {
      doc.font("Helvetica-Bold").fontSize(8).fillColor(C.muted);
      const y = doc.y;
      cols.forEach((c, i) => doc.text(c.label.toUpperCase(), xs[i], y, { width: c.w * width - 6 }));
      doc.y = y + 14;
      doc.fillColor(C.text);
    };
    ensure(40);
    header();
    for (const row of rows) {
      doc.font("Helvetica").fontSize(8.5);
      const h = Math.max(...row.map((cell, i) => doc.heightOfString(t(cell), { width: cols[i].w * width - 6 })));
      if (doc.y + h + 6 > doc.page.height - M - 16) { doc.addPage(); header(); doc.font("Helvetica").fontSize(8.5); }
      const y = doc.y;
      row.forEach((cell, i) => doc.fillColor(cols[i].color?.(row) ?? C.text).text(t(cell), xs[i], y, { width: cols[i].w * width - 6 }));
      doc.y = y + h + 4;
      doc.moveTo(M, doc.y - 2).lineTo(M + width, doc.y - 2).strokeColor(C.line).lineWidth(0.5).stroke();
    }
    doc.x = M;
  };

  // --- Cover / summary ---
  doc.font("Helvetica").fontSize(9).fillColor(C.muted).text("TECHNICAL SEO AUDIT", M, M, { characterSpacing: 1 });
  doc.moveDown(0.3).font("Helvetica-Bold").fontSize(22).fillColor(C.text).text(t(website.name), { width });
  doc.font("Helvetica").fontSize(10).fillColor(C.muted).text(t(`${website.base_url}  ·  ${new Date(audit.created_at).toUTCString().replace(/:\d\d GMT$/, " UTC")}`));
  if (site.partial) doc.fillColor(C.warning).text("Partial crawl: the time budget ran out before all pages were crawled.");

  const count = (sev: string) => Object.entries(audit.summary).filter(([k]) => ISSUE_INFO[k]?.severity === sev).reduce((n, [, v]) => n + v, 0);
  const stats: [string, string, string][] = [
    ["Health score", audit.score == null ? "-" : `${audit.score}/100`, audit.score == null ? C.muted : audit.score >= 85 ? C.ok : audit.score >= 60 ? C.warning : C.error],
    ["Pages crawled", String(audit.pages_crawled), C.text],
    ["Errors", String(count("error")), count("error") ? C.error : C.ok],
    ["Warnings", String(count("warning")), count("warning") ? C.warning : C.ok],
  ];
  const boxY = doc.y + 16, boxW = (width - 24) / 4;
  stats.forEach(([label, value, color], i) => {
    const x = M + i * (boxW + 8);
    doc.roundedRect(x, boxY, boxW, 58, 6).strokeColor(C.line).lineWidth(1).stroke();
    doc.font("Helvetica").fontSize(8).fillColor(C.muted).text(label.toUpperCase(), x + 10, boxY + 10, { width: boxW - 20 });
    doc.font("Helvetica-Bold").fontSize(20).fillColor(color).text(value, x + 10, boxY + 25, { width: boxW - 20 });
  });
  doc.x = M;
  doc.y = boxY + 70;
  doc.font("Helvetica").fontSize(8).fillColor(C.muted).text("Errors and warnings count pages affected per issue. 100 = no issues found.", M, doc.y, { width });

  // --- Site checks ---
  heading("Site checks");
  const blocked = (site.aiCrawlers ?? []).filter((c) => !c.allowed);
  const checks: [string, boolean | null, string][] = [
    ["HTTPS", !!site.https, site.https ? "Served over HTTPS" : "Not served over HTTPS"],
    ["robots.txt", !!site.robots?.found && !site.robots.blocksAll, !site.robots?.found ? "Not found" : site.robots.blocksAll ? "Blocks crawlers from the whole site" : `${site.robots.sitemaps.length} sitemap(s) declared`],
    ["XML sitemap", !!site.sitemap?.found, site.sitemap?.found ? `${site.sitemap.urls} URLs in ${site.sitemap.sources.length} file(s)` : "No sitemap found"],
    ["llms.txt", site.llmsTxt?.found ? true : null, site.llmsTxt?.found ? "Present" : "Not found (optional, emerging convention)"],
    ["AI crawler access", blocked.length === 0, blocked.length ? `Blocked: ${blocked.map((c) => c.agent).join(", ")}` : "No AI crawlers blocked"],
  ];
  table([
    { label: "Check", w: 0.25 },
    { label: "Status", w: 0.15, color: (r) => (r[1] === "OK" ? C.ok : r[1] === "Optional" ? C.notice : C.error) },
    { label: "Detail", w: 0.6 },
  ], checks.map(([name, ok, detail]) => [name, ok === null ? "Optional" : ok ? "OK" : "Issue", detail]));

  if (site.aiCrawlers?.length) {
    heading("AI crawlers (robots.txt)");
    table([
      { label: "Agent", w: 0.25 },
      { label: "Access", w: 0.15, color: (r) => (r[1] === "Allowed" ? C.ok : C.warning) },
      { label: "Owner - purpose", w: 0.6 },
    ], site.aiCrawlers.map((c) => [c.agent, c.allowed ? "Allowed" : "Blocked", `${c.owner} - ${c.purpose}`]));
  }

  if (site.webVitals) {
    heading("Core Web Vitals (homepage, PageSpeed Insights)");
    if ("error" in site.webVitals) doc.font("Helvetica").fontSize(9).fillColor(C.error).text(t(site.webVitals.error));
    else {
      const s = (ms: number | null) => (ms == null ? "-" : `${(ms / 1000).toFixed(1)} s`);
      table([{ label: "Device", w: 0.16 }, { label: "Performance", w: 0.16 }, { label: "Field data (real users)", w: 0.4 }, { label: "Lab data", w: 0.28 }],
        site.webVitals.map((v) => [v.strategy, v.performanceScore == null ? "-" : `${v.performanceScore}/100`,
          `LCP ${s(v.field.lcpMs)} · INP ${v.field.inpMs ?? "-"} ms · CLS ${v.field.cls ?? "-"}${v.field.category ? ` (${v.field.category.toLowerCase()})` : ""}`,
          `LCP ${s(v.lab.lcpMs)} · TBT ${v.lab.tbtMs == null ? "-" : Math.round(v.lab.tbtMs)} ms`]));
    }
  }

  if (site.indexation?.length) {
    heading("Indexation (Search Console URL Inspection)");
    table([{ label: "URL", w: 0.6 }, { label: "Status", w: 0.4, color: (r) => (/indexed$/i.test(r[1]) && !/not/i.test(r[1]) ? C.ok : C.warning) }],
      site.indexation.map((i) => [i.url, "error" in i ? `Error: ${i.error}` : i.coverageState]));
  }

  // --- Issues ---
  heading("Issues and how to fix them");
  const issues = Object.entries(audit.summary).filter(([k]) => ISSUE_INFO[k])
    .sort((a, b) => SEV_ORDER[ISSUE_INFO[a[0]].severity] - SEV_ORDER[ISSUE_INFO[b[0]].severity] || b[1] - a[1]);
  if (!issues.length) doc.font("Helvetica").fontSize(9).fillColor(C.ok).text("No issues found.");
  else table([
    { label: "Severity", w: 0.12, color: (r) => C[r[0] as "error" | "warning" | "notice"] ?? C.text },
    { label: "Issue", w: 0.33 },
    { label: "Pages", w: 0.09 },
    { label: "How to fix", w: 0.46 },
  ], issues.map(([code, n]) => [ISSUE_INFO[code].severity, ISSUE_INFO[code].label, String(n), ISSUE_INFO[code].fix]));

  // --- Evidence ---
  if (issues.length) {
    heading("Evidence by issue");
    doc.font("Helvetica").fontSize(8).fillColor(C.muted).text("What the crawler found on each affected page (up to 25 pages per issue; the issues CSV has all of them).", M, doc.y, { width });
    doc.moveDown(0.4);
    for (const [code, n] of issues) {
      const affected = pages.filter((p) => p.issues.includes(code));
      ensure(50);
      doc.font("Helvetica-Bold").fontSize(10).fillColor(C[ISSUE_INFO[code].severity]).text(t(`${ISSUE_INFO[code].label} (${n})`), M, doc.y, { width });
      doc.moveDown(0.2);
      table([{ label: "URL", w: 0.4 }, { label: "Evidence", w: 0.6 }],
        affected.slice(0, 25).map((p) => [p.url, evidenceFor(p, code).join("\n") || "-"]));
      if (affected.length > 25) doc.font("Helvetica").fontSize(8).fillColor(C.muted).text(t(`…and ${affected.length - 25} more`), M, doc.y, { width });
      doc.moveDown(0.5);
    }
  }

  // --- Pages ---
  heading(`Pages (${pages.length})`);
  const sorted = [...pages].sort((a, b) => {
    const worst = (p: Page) => Math.min(3, ...p.issues.map((i) => SEV_ORDER[ISSUE_INFO[i]?.severity ?? "notice"]));
    return worst(a) - worst(b) || b.issues.length - a.issues.length;
  });
  table([
    { label: "URL / title", w: 0.42 },
    { label: "Status", w: 0.08, color: (r) => (Number(r[1]) >= 400 || r[1] === "-" ? C.error : C.text) },
    { label: "Words", w: 0.08 },
    { label: "Inlinks", w: 0.08 },
    { label: "Issues", w: 0.34 },
  ], sorted.map((p) => [`${p.url}${p.title ? `\n${p.title}` : ""}`, p.status_code == null ? "-" : String(p.status_code), p.word_count == null ? "-" : String(p.word_count), String(p.inlinks),
    [...new Set(p.issues)].map((i) => ISSUE_INFO[i]?.label ?? i).join(", ") || "-"]));

  // --- Footer on every page ---
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not trigger a new page
    doc.font("Helvetica").fontSize(7.5).fillColor(C.muted)
      .text(t(`${website.name} - SEO audit ${audit.created_at.slice(0, 10)}`), M, doc.page.height - M + 4, { width: width / 2, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, M + width / 2, doc.page.height - M + 4, { width: width / 2, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
  return done;
}
