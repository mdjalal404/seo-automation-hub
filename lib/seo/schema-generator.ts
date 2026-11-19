import { findAll, textContent } from "domutils";
import type { Element } from "domhandler";
import { z } from "zod";
import { normalizeText, parseHtml, renderBody } from "@/lib/seo/html";

/**
 * JSON-LD generation from article content. FAQ and HowTo items are extracted from the
 * article itself (Google requires marked-up content to be visible on the page).
 */
export const SCHEMA_TYPES = ["Article", "BlogPosting", "FAQPage", "HowTo", "BreadcrumbList", "Organization", "LocalBusiness", "Product"] as const;
export type SchemaType = (typeof SCHEMA_TYPES)[number];

export const schemaOptionsSchema = z.object({
  types: z.array(z.enum(SCHEMA_TYPES)).min(1, "Choose at least one type.").max(8),
  authorName: z.string().trim().max(200).default(""),
  publisherName: z.string().trim().max(200).default(""),
  logoUrl: z.union([z.literal(""), z.url()]).default(""),
  imageUrl: z.union([z.literal(""), z.url()]).default(""),
  business: z.object({
    telephone: z.string().trim().max(50).default(""),
    streetAddress: z.string().trim().max(200).default(""),
    addressLocality: z.string().trim().max(100).default(""),
    postalCode: z.string().trim().max(20).default(""),
    addressCountry: z.string().trim().max(2).default(""),
  }).partial().default({}),
  product: z.object({
    name: z.string().trim().max(200).default(""),
    price: z.string().trim().max(20).default(""),
    currency: z.string().trim().max(3).default(""),
    availability: z.enum(["InStock", "OutOfStock", "PreOrder"]).default("InStock"),
  }).partial().default({}),
});
export type SchemaOptions = z.infer<typeof schemaOptionsSchema>;

type Article = {
  title: string; metaDescription: string; excerpt: string; body: string; bodyFormat: "markdown" | "html";
  url: string; publishedAt?: string | null; updatedAt?: string | null;
};
type Site = { name: string; baseUrl: string };
type Node = Record<string, unknown>;

export function extractFaqs(html: string): { question: string; answer: string }[] {
  const doc = parseHtml(html).doc;
  const nodes = findAll(() => true, doc.children).filter((el) => /^(h[2-4]|p|ul|ol)$/.test(el.name));
  const out: { question: string; answer: string }[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (!/^h[2-4]$/.test(el.name)) continue;
    const q = normalizeText(textContent(el));
    if (!q.endsWith("?")) continue;
    const answer: string[] = [];
    for (let j = i + 1; j < nodes.length && !/^h[2-4]$/.test(nodes[j].name); j++) {
      if (nodes[j].parent && (nodes[j].parent as Element).name === "li") continue;
      answer.push(normalizeText(textContent(nodes[j])));
    }
    if (answer.join(" ").trim()) out.push({ question: q, answer: answer.join(" ").slice(0, 1000) });
  }
  return out.slice(0, 20);
}

export function extractHowToSteps(html: string): string[] {
  const doc = parseHtml(html).doc;
  const ol = findAll((el) => el.name === "ol", doc.children)[0];
  if (!ol) return [];
  return findAll((el) => el.name === "li", ol.children).map((li) => normalizeText(textContent(li))).filter(Boolean).slice(0, 30);
}

export function generateSchema(article: Article, site: Site, opts: SchemaOptions): { jsonld: Node; warnings: string[] } {
  const html = renderBody(article.body, article.bodyFormat);
  const warnings: string[] = [];
  const origin = new URL(site.baseUrl).origin;
  const orgId = `${origin}/#organization`;
  const publisherName = opts.publisherName || site.name;
  const graph: Node[] = [];
  const description = article.metaDescription || article.excerpt || undefined;

  for (const type of opts.types) {
    switch (type) {
      case "Article":
      case "BlogPosting": {
        if (!opts.imageUrl) warnings.push(`${type}: add an image URL — Google recommends one for article rich results.`);
        if (!opts.authorName) warnings.push(`${type}: add an author name for E-E-A-T signals.`);
        graph.push(clean({
          "@type": type, "@id": `${article.url}#article`, headline: article.title.slice(0, 110), description,
          image: opts.imageUrl || undefined, datePublished: article.publishedAt || undefined, dateModified: article.updatedAt || article.publishedAt || undefined,
          author: opts.authorName ? { "@type": "Person", name: opts.authorName } : undefined,
          publisher: { "@id": orgId }, mainEntityOfPage: article.url,
        }));
        break;
      }
      case "FAQPage": {
        const faqs = extractFaqs(html);
        if (!faqs.length) { warnings.push("FAQPage: no question headings (ending in “?”) with answers were found in the article."); break; }
        graph.push({ "@type": "FAQPage", "@id": `${article.url}#faq`, mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })) });
        break;
      }
      case "HowTo": {
        const steps = extractHowToSteps(html);
        if (steps.length < 2) { warnings.push("HowTo: the article needs a numbered list of at least two steps."); break; }
        graph.push({ "@type": "HowTo", "@id": `${article.url}#howto`, name: article.title, step: steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, text: s })) });
        break;
      }
      case "BreadcrumbList":
        graph.push({ "@type": "BreadcrumbList", itemListElement: [
          { "@type": "ListItem", position: 1, name: site.name, item: `${origin}/` },
          { "@type": "ListItem", position: 2, name: article.title, item: article.url },
        ] });
        break;
      case "Organization":
        graph.push(clean({ "@type": "Organization", "@id": orgId, name: publisherName, url: `${origin}/`, logo: opts.logoUrl || undefined }));
        break;
      case "LocalBusiness": {
        const b = opts.business;
        if (!b.streetAddress || !b.addressLocality) warnings.push("LocalBusiness: street address and city are required.");
        graph.push(clean({
          "@type": "LocalBusiness", "@id": `${origin}/#localbusiness`, name: publisherName, url: `${origin}/`, image: opts.logoUrl || opts.imageUrl || undefined,
          telephone: b.telephone || undefined,
          address: clean({ "@type": "PostalAddress", streetAddress: b.streetAddress || undefined, addressLocality: b.addressLocality || undefined, postalCode: b.postalCode || undefined, addressCountry: b.addressCountry || undefined }),
        }));
        break;
      }
      case "Product": {
        const p = opts.product;
        if (!p.name) { warnings.push("Product: enter the product name."); break; }
        if (!p.price || !p.currency) warnings.push("Product: price and currency are needed for merchant listings.");
        graph.push(clean({
          "@type": "Product", name: p.name, description, image: opts.imageUrl || undefined,
          offers: p.price ? clean({ "@type": "Offer", price: p.price, priceCurrency: p.currency || undefined, availability: `https://schema.org/${p.availability ?? "InStock"}`, url: article.url }) : undefined,
        }));
        break;
      }
    }
  }
  if (graph.some((n) => (n.publisher as Node | undefined)?.["@id"] === orgId) && !opts.types.includes("Organization")) {
    graph.push(clean({ "@type": "Organization", "@id": orgId, name: publisherName, url: `${origin}/`, logo: opts.logoUrl || undefined }));
  }
  return { jsonld: { "@context": "https://schema.org", "@graph": graph }, warnings };
}

/** Required properties per type (Google rich-result requirements, simplified). */
const REQUIRED: Record<string, string[]> = {
  Article: ["headline"], BlogPosting: ["headline"], NewsArticle: ["headline"],
  FAQPage: ["mainEntity"], HowTo: ["name", "step"], BreadcrumbList: ["itemListElement"],
  Organization: ["name", "url"], LocalBusiness: ["name", "address"], Product: ["name"],
  Question: ["name", "acceptedAnswer"], Offer: ["price", "priceCurrency"],
};

export function validateSchema(data: unknown): string[] {
  const problems: string[] = [];
  const visit = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((n, i) => visit(n, `${path}[${i}]`));
    if (!node || typeof node !== "object") return;
    const obj = node as Node;
    const type = typeof obj["@type"] === "string" ? (obj["@type"] as string) : null;
    if (type) for (const prop of REQUIRED[type] ?? []) if (obj[prop] === undefined || obj[prop] === "") problems.push(`${type} at ${path || "root"} is missing "${prop}".`);
    for (const [k, v] of Object.entries(obj)) if (typeof v === "object") visit(v, path ? `${path}.${k}` : k);
  };
  if (!data || typeof data !== "object") return ["JSON-LD must be an object."];
  if (!("@context" in (data as Node))) problems.push('Missing "@context": "https://schema.org".');
  visit(data, "");
  return problems;
}

function clean(n: Node): Node {
  return Object.fromEntries(Object.entries(n).filter(([, v]) => v !== undefined && !(typeof v === "object" && v && !Array.isArray(v) && Object.keys(v).length <= 1 && "@type" in v)));
}
