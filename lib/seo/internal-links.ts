import { normalizeText, parseHtml, renderBody } from "@/lib/seo/html";

/**
 * Internal-link suggestions: finds phrases in an article that match another page's
 * target keyword or title and are not linked yet, ranked by topical similarity
 * (TF-IDF cosine between the two texts).
 */
export type LinkTarget = { id: string; url: string; title: string; keyword: string; text?: string };
export type LinkSuggestion = { targetId: string; url: string; targetTitle: string; anchor: string; context: string; score: number };

const WORD = /[\p{L}\p{N}]+/gu;
const STOP = new Set("a an and are as at be but by can do for from has have how i if in into is it its more most my not of on or our so than that the their them then there these they this to was we what when which who why will with you your".split(" "));

function terms(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

function tfidf(docs: string[][]): Map<string, number>[] {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v = new Map<string, number>();
    for (const [t, n] of tf) v.set(t, (n / d.length) * Math.log((docs.length + 1) / (df.get(t)! + 0.5)));
    return v;
  });
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, na = 0, nb = 0;
  for (const [t, x] of a) { na += x * x; const y = b.get(t); if (y) dot += x * y; }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function suggestInternalLinks(
  article: { title: string; body: string; bodyFormat: "markdown" | "html"; url?: string | null },
  targets: LinkTarget[],
  max = 10,
): LinkSuggestion[] {
  const html = renderBody(article.body, article.bodyFormat);
  const parsed = parseHtml(html);
  const linked = new Set(parsed.links.map((l) => l.href.replace(/\/$/, "")));
  const linkedText = parsed.links.map((l) => l.text.toLowerCase());
  const text = normalizeText(parsed.text);
  const lower = text.toLowerCase();
  const pool = targets.filter((t) => t.url && t.url.replace(/\/$/, "") !== article.url?.replace(/\/$/, "") && !linked.has(t.url.replace(/\/$/, "")));
  if (!pool.length || !text) return [];
  const vectors = tfidf([terms(`${article.title} ${text}`), ...pool.map((t) => terms(`${t.title} ${t.keyword} ${t.text ?? ""}`))]);

  const out: LinkSuggestion[] = [];
  pool.forEach((t, i) => {
    const sim = cosine(vectors[0], vectors[i + 1]);
    const phrases = [t.keyword, t.title.replace(/[:|–-].*$/, "").trim()].map((p) => p.toLowerCase().trim()).filter((p) => p.split(" ").length >= 2 && p.length <= 80);
    for (const phrase of phrases) {
      const m = new RegExp(`\\b${escapeRe(phrase)}\\b`, "i").exec(lower);
      if (!m || linkedText.some((lt) => lt.includes(phrase))) continue;
      const start = Math.max(0, lower.lastIndexOf(".", m.index) + 1);
      const end = lower.indexOf(".", m.index + phrase.length);
      out.push({
        targetId: t.id, url: t.url, targetTitle: t.title,
        anchor: text.slice(m.index, m.index + phrase.length),
        context: text.slice(start, end === -1 ? Math.min(text.length, m.index + 160) : end + 1).trim().slice(0, 240),
        score: Math.round((0.6 + sim) * 100) / 100,
      });
      return;
    }
    // Topically close pages without an exact phrase are still worth a manual link.
    if (sim >= 0.25) out.push({ targetId: t.id, url: t.url, targetTitle: t.title, anchor: "", context: "", score: Math.round(sim * 100) / 100 });
  });
  return out.sort((a, b) => Number(!!b.anchor) - Number(!!a.anchor) || b.score - a.score).slice(0, max);
}

/**
 * Inserts a link at the first unlinked occurrence of `anchor` in a Markdown or HTML body,
 * outside headings, code and existing links. Returns null when no safe spot exists.
 */
export function insertLink(body: string, format: "markdown" | "html", anchor: string, url: string): string | null {
  if (!anchor || !/^https?:\/\//.test(url)) return null;
  const re = new RegExp(`\\b${escapeRe(anchor)}\\b`, "i");
  if (format === "html") {
    // Split into tags and text; only replace in text outside <a>, headings, code and pre.
    const parts = body.split(/(<[^>]+>)/);
    let depth = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p.startsWith("<")) {
        if (/^<(a|h[1-6]|code|pre|script|style)\b/i.test(p)) depth++;
        else if (/^<\/(a|h[1-6]|code|pre|script|style)>/i.test(p)) depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth === 0 && re.test(p)) {
        parts[i] = p.replace(re, (m) => `<a href="${url.replace(/"/g, "%22")}">${m}</a>`);
        return parts.join("");
      }
    }
    return null;
  }
  const lines = body.split("\n");
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || /^\s*#/.test(line) || /^\s{4,}\S/.test(line)) continue;
    // Mask existing links, images, inline code and autolinks so we never nest a link.
    const masked = line.replace(/!?\[[^\]]*\]\([^)]*\)|`[^`]*`|<[^>]+>|https?:\/\/\S+/g, (m) => "\u0000".repeat(m.length));
    const m = re.exec(masked);
    if (m) {
      lines[i] = `${line.slice(0, m.index)}[${line.slice(m.index, m.index + m[0].length)}](${url.replace(/\)/g, "%29")})${line.slice(m.index + m[0].length)}`;
      return lines.join("\n");
    }
  }
  return null;
}
