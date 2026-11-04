import { decodeHTML } from "entities";
import { getAttributeValue, findAll, textContent } from "domutils";
import type { Document, Element } from "domhandler";
import { parseDocument } from "htmlparser2";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

/** Renders the stored body to the HTML that will be sent to WordPress. */
export function renderBody(body: string, format: "markdown" | "html"): string {
  if (format === "html") return body;
  return marked.parse(body, { async: false, gfm: true }) as string;
}

/** Sanitized HTML for in-app preview (no scripts, styles, iframes or event handlers). */
export function sanitizeForPreview(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2", "figure", "figcaption"]),
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "title", "width", "height"],
      "*": ["id"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: { a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }) },
  });
}

export type ParsedHtml = {
  doc: Document;
  headings: { level: number; text: string }[];
  images: { src: string | undefined; alt: string | undefined }[];
  links: { href: string; text: string }[];
  jsonLd: string[];
  text: string;
  wordCount: number;
};

const isEl = (name: string) => (el: Element) => el.name === name;

export function parseHtml(html: string): ParsedHtml {
  const doc = parseDocument(html, { decodeEntities: true });
  const all = findAll(() => true, doc.children);
  const headings = all
    .filter((el) => /^h[1-6]$/.test(el.name))
    .map((el) => ({ level: Number(el.name[1]), text: normalizeText(textContent(el)) }));
  const images = findAll(isEl("img"), doc.children).map((el) => ({
    src: getAttributeValue(el, "src"),
    alt: el.attribs && "alt" in el.attribs ? el.attribs.alt : undefined,
  }));
  const links = findAll(isEl("a"), doc.children)
    .filter((el) => el.attribs && "href" in el.attribs)
    .map((el) => ({ href: el.attribs.href, text: normalizeText(textContent(el)) }));
  const jsonLd = findAll(
    (el) => el.name === "script" && (getAttributeValue(el, "type") ?? "").toLowerCase() === "application/ld+json",
    doc.children,
  ).map((el) => textContent(el));
  const text = normalizeText(visibleText(doc));
  return { doc, headings, images, links, jsonLd, text, wordCount: text ? text.split(" ").length : 0 };
}

const BLOCK = /^(p|li|h[1-6]|blockquote|td|th|dd|dt|figcaption|pre)$/;

/** Visible text with one line per block element (paragraphs, list items, headings…). */
export function blockText(doc: Document): string {
  const isBlock = (el: Element) => BLOCK.test(el.name);
  const blocks = findAll((el) => {
    if (!isBlock(el)) return false;
    for (let p = el.parent as Element | null; p && "name" in p; p = p.parent as Element | null) if (isBlock(p)) return false;
    return true;
  }, doc.children);
  const lines = blocks.map((el) => normalizeText(textContent(el))).filter(Boolean);
  return lines.length ? lines.join("\n") : normalizeText(visibleText(doc));
}

function visibleText(node: Document | Element): string {
  let out = "";
  for (const child of node.children) {
    if (child.type === "text") out += (child as unknown as { data: string }).data + " ";
    else if ("children" in child && "name" in child && !["script", "style", "noscript", "template", "head"].includes((child as Element).name)) {
      out += visibleText(child as Element) + " ";
    }
  }
  return out;
}

/**
 * Normalizes text for comparisons across WordPress output filters (wptexturize turns
 * quotes and dashes into typographic forms; entities and whitespace vary).
 */
export function normalizeText(input: string): string {
  return decodeHTML(input)
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/[ \s]+/g, " ")
    .trim();
}

export function extractTitleTag(doc: Document): string | null {
  const t = findAll(isEl("title"), doc.children)[0];
  return t ? normalizeText(textContent(t)) : null;
}

export function extractMeta(doc: Document, name: string): string | null {
  const el = findAll(
    (e) => e.name === "meta" && ((getAttributeValue(e, "name") ?? getAttributeValue(e, "property") ?? "").toLowerCase() === name),
    doc.children,
  )[0];
  return el ? normalizeText(getAttributeValue(el, "content") ?? "") : null;
}

export function extractCanonical(doc: Document): string | null {
  const el = findAll(
    (e) => e.name === "link" && (getAttributeValue(e, "rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"),
    doc.children,
  )[0];
  return el ? (getAttributeValue(el, "href") ?? null) : null;
}
