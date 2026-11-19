import { findAll, textContent } from "domutils";
import type { Element } from "domhandler";
import { normalizeText, type ParsedHtml } from "@/lib/seo/html";

/**
 * AI-search readiness ("GEO"): how easy an article is for AI answer engines (Google AI
 * Overviews, ChatGPT search, Perplexity, Claude) to understand, quote and cite.
 * These are on-page signals that make content more citable — not a ranking guarantee.
 * Actual citations are measured separately (lib/ai/visibility-check.ts).
 */
export type ReadinessSignal = { key: string; label: string; passed: boolean; weight: number; tip: string; detail?: string };
export type ReadinessReport = { score: number; signals: ReadinessSignal[] };

const QUESTION_HEADING = /\?$|^(how|what|why|when|where|which|who|can|does|do|is|are|should|will)\b/i;
const NUMBER = /\b\d+(?:[.,]\d+)?\s?(%|percent|years?|months?|days?|hours?|minutes?|km|kg|mi|lbs?|\$|usd|eur)?/gi;

export function aiReadiness(parsed: ParsedHtml, opts: { keyword?: string; siteHost?: string; hasSchema?: boolean }): ReadinessReport {
  const paragraphs = findAll((el: Element) => el.name === "p", parsed.doc.children).map((el) => normalizeText(textContent(el))).filter(Boolean);
  const first = paragraphs[0] ?? "";
  const firstWords = first.split(" ").filter(Boolean).length;
  const kw = opts.keyword?.toLowerCase().trim();
  const questionHeadings = parsed.headings.filter((h) => h.level >= 2 && QUESTION_HEADING.test(h.text)).length;
  const hasFaq = parsed.headings.some((h) => /\bfaq|frequently asked/i.test(h.text)) || parsed.jsonLd.some((j) => /FAQPage/.test(j));
  const lists = findAll((el: Element) => el.name === "ul" || el.name === "ol" || el.name === "table", parsed.doc.children).length;
  const numbers = (parsed.text.match(NUMBER) ?? []).length;
  const external = parsed.links.filter((l) => {
    try {
      const u = new URL(l.href);
      return /^https?:$/.test(u.protocol) && (!opts.siteHost || u.hostname.replace(/^www\./, "") !== opts.siteHost.replace(/^www\./, ""));
    } catch {
      return false;
    }
  }).length;
  const avgParagraph = paragraphs.length ? Math.round(paragraphs.reduce((n, p) => n + p.split(" ").length, 0) / paragraphs.length) : 0;
  const definition = /\b(is|are|means|refers to)\b/i.test(first);
  const schema = opts.hasSchema || parsed.jsonLd.length > 0;

  const signals: ReadinessSignal[] = [
    {
      key: "direct_answer", label: "Direct answer up front", weight: 20,
      passed: firstWords >= 15 && firstWords <= 90 && (definition || (!!kw && first.toLowerCase().includes(kw))),
      tip: "Open with a 2–3 sentence answer (40–80 words) that defines or answers the main query, so AI engines can quote it.",
      detail: first ? `First paragraph: ${firstWords} words` : "No opening paragraph",
    },
    { key: "question_headings", label: "Question-style headings", weight: 12, passed: questionHeadings >= 2, tip: "Phrase 2+ H2/H3 headings as the questions people ask (How…, What…, Why…).", detail: `${questionHeadings} found` },
    { key: "faq", label: "FAQ section or FAQPage schema", weight: 12, passed: hasFaq, tip: "Add an FAQ section with concise answers; add FAQPage JSON-LD (Schema generator)." },
    { key: "structure", label: "Lists or tables", weight: 10, passed: lists >= 1, tip: "Use bulleted steps, comparisons or a table — answer engines extract structured passages.", detail: `${lists} found` },
    { key: "specifics", label: "Specific facts and numbers", weight: 12, passed: numbers >= 3, tip: "Include concrete figures, dates, measurements or prices (with sources).", detail: `${numbers} found` },
    { key: "citations", label: "Cites external sources", weight: 12, passed: external >= 2, tip: "Link to 2+ authoritative sources (studies, official docs) that back your claims.", detail: `${external} external links` },
    { key: "scannable", label: "Short paragraphs", weight: 8, passed: paragraphs.length > 0 && avgParagraph <= 80, tip: "Keep paragraphs under ~80 words so each passage stands on its own.", detail: `Average ${avgParagraph} words` },
    { key: "structured_data", label: "Structured data", weight: 8, passed: schema, tip: "Add Article/FAQPage/HowTo JSON-LD so engines understand the page type and entities." },
    { key: "depth", label: "Enough depth", weight: 6, passed: parsed.wordCount >= 600, tip: "Cover the topic thoroughly (600+ words for most informational queries).", detail: `${parsed.wordCount} words` },
  ];
  const total = signals.reduce((n, s) => n + s.weight, 0);
  const score = Math.round((signals.filter((s) => s.passed).reduce((n, s) => n + s.weight, 0) / total) * 100);
  return { score, signals };
}

/** Known AI crawlers and what blocking them affects. */
export const AI_CRAWLERS = [
  { agent: "GPTBot", owner: "OpenAI", purpose: "Model training" },
  { agent: "OAI-SearchBot", owner: "OpenAI", purpose: "ChatGPT search results" },
  { agent: "ChatGPT-User", owner: "OpenAI", purpose: "Pages fetched for ChatGPT users" },
  { agent: "ClaudeBot", owner: "Anthropic", purpose: "Model training" },
  { agent: "Claude-SearchBot", owner: "Anthropic", purpose: "Claude search results" },
  { agent: "Claude-User", owner: "Anthropic", purpose: "Pages fetched for Claude users" },
  { agent: "PerplexityBot", owner: "Perplexity", purpose: "Perplexity search results" },
  { agent: "Google-Extended", owner: "Google", purpose: "Gemini training/grounding (not Search or AI Overviews)" },
  { agent: "Applebot-Extended", owner: "Apple", purpose: "Apple Intelligence training" },
  { agent: "CCBot", owner: "Common Crawl", purpose: "Open dataset used by many models" },
] as const;
