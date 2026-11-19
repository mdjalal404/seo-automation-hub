import { z } from "zod";
import type { LlmClient, LlmUsage } from "@/lib/ai/llm";
import { slugify } from "@/lib/validation/schemas";

/**
 * Content generation pipeline: brief → draft → editorial QA review.
 * Output is always saved as a DRAFT that goes through the normal SEO validation and
 * human approval workflow — the pipeline never publishes.
 */
export const generationInputSchema = z.object({
  websiteId: z.uuid(),
  topic: z.string().trim().min(3, "Describe the topic.").max(300),
  targetKeyword: z.string().trim().min(2, "Enter the target keyword.").max(200),
  secondaryKeywords: z.array(z.string().trim().min(1).max(200)).max(30).default([]),
  audience: z.string().trim().max(300).default(""),
  tone: z.enum(["professional", "friendly", "expert", "conversational"]).default("professional"),
  wordCount: z.coerce.number().int().min(300).max(4000).default(1200),
  brandNotes: z.string().trim().max(2000).default(""),
  clusterId: z.union([z.literal("").transform(() => null), z.uuid()]).nullable().default(null),
});
export type GenerationInput = z.infer<typeof generationInputSchema>;

export type LinkCandidate = { title: string; url: string; keyword?: string };

const briefSchema = z.object({
  searchIntent: z.enum(["informational", "commercial", "transactional", "navigational", "local"]),
  audience: z.string(),
  angle: z.string(),
  outline: z.array(z.object({ heading: z.string(), points: z.array(z.string()) })),
  questions: z.array(z.string()),
  entities: z.array(z.string()),
});
export type ContentBrief = z.infer<typeof briefSchema>;

const draftSchema = z.object({
  title: z.string(),
  metaTitle: z.string(),
  metaDescription: z.string(),
  excerpt: z.string(),
  bodyMarkdown: z.string(),
  faqs: z.array(z.object({ question: z.string(), answer: z.string() })),
});
export type ContentDraft = z.infer<typeof draftSchema>;

const reviewSchema = z.object({
  scores: z.object({ helpfulness: z.number(), expertise: z.number(), originality: z.number(), readability: z.number(), seo: z.number() }),
  claimsToVerify: z.array(z.string()),
  issues: z.array(z.object({ severity: z.enum(["high", "medium", "low"]), message: z.string() })),
  verdict: z.enum(["ready_for_editor", "needs_revision"]),
});
export type ContentReview = z.infer<typeof reviewSchema>;

export type PipelineResult = {
  brief: ContentBrief;
  draft: ContentDraft & { slug: string };
  review: ContentReview;
  steps: { kind: "brief" | "draft" | "review"; model: string; usage: LlmUsage }[];
  provider: LlmClient["provider"];
};

const SYSTEM = `You are a senior SEO content strategist and editor. You write accurate, people-first content that demonstrates real expertise, answers the searcher's question early, and is easy for both readers and AI answer engines to quote. Never invent statistics, studies, quotes, prices, or credentials; when a fact needs a source the writer must add, mark it as [verify: …].`;

export async function runContentPipeline(llm: LlmClient, input: GenerationInput, links: LinkCandidate[], onStep?: (s: string) => Promise<void>): Promise<PipelineResult> {
  const steps: PipelineResult["steps"] = [];
  const context = [
    `Topic: ${input.topic}`,
    `Primary keyword: ${input.targetKeyword}`,
    input.secondaryKeywords.length ? `Secondary keywords: ${input.secondaryKeywords.join(", ")}` : "",
    input.audience ? `Audience: ${input.audience}` : "",
    `Tone: ${input.tone}`,
    `Target length: about ${input.wordCount} words`,
    input.brandNotes ? `Brand notes:\n${input.brandNotes}` : "",
  ].filter(Boolean).join("\n");

  await onStep?.("Writing the content brief");
  const brief = await llm.structured({
    system: SYSTEM,
    prompt: `Create a content brief for an article.\n\n${context}\n\nCover search intent, the reader, a distinctive angle, an H2/H3 outline with key points, the questions searchers ask (for an FAQ), and the entities/concepts the article must mention to be topically complete.`,
    schema: briefSchema,
    maxTokens: 6_000,
    mock: () => mockBrief(input),
  });
  steps.push({ kind: "brief", model: brief.model, usage: brief.usage });

  await onStep?.("Drafting the article");
  const linkList = links.slice(0, 15).map((l) => `- ${l.title}: ${l.url}`).join("\n");
  const draft = await llm.structured({
    system: SYSTEM,
    prompt: `Write the article from this brief.\n\n${context}\n\nBrief:\n${JSON.stringify(brief.data)}\n\nRequirements:
- Markdown body starting with a 2–3 sentence direct answer to the main query, then H2/H3 sections from the outline (do not include an H1; the title is separate).
- Use the primary keyword naturally in the first 100 words and in at least one H2; no keyword stuffing.
- Short paragraphs, lists or a table where they help, concrete examples. Write in a natural human voice with varied sentence lengths; avoid filler and clichés.
- End with an "FAQ" H2 answering 3–5 of the brief's questions in 2–3 sentences each (also return them in "faqs").
- Meta title ≤ 60 characters, meta description 120–155 characters, excerpt ≤ 2 sentences.
${linkList ? `- Link to 2–4 of these existing pages where genuinely relevant, using descriptive anchor text:\n${linkList}` : ""}`,
    schema: draftSchema,
    maxTokens: 16_000,
    mock: () => mockDraft(input, brief.data, links),
  });
  steps.push({ kind: "draft", model: draft.model, usage: draft.usage });

  await onStep?.("Reviewing quality");
  const review = await llm.structured({
    system: "You are a strict editorial quality reviewer for SEO content. Score honestly from 0 to 10; most first drafts are 5–7.",
    prompt: `Review this draft for the query "${input.targetKeyword}". Score helpfulness, expertise (E-E-A-T signals), originality, readability and on-page SEO. List factual claims a human must verify before publishing, and concrete issues to fix.\n\nTitle: ${draft.data.title}\n\n${draft.data.bodyMarkdown}`,
    schema: reviewSchema,
    maxTokens: 4_000,
    effort: "low",
    mock: () => mockReview(),
  });
  steps.push({ kind: "review", model: review.model, usage: review.usage });

  return { brief: brief.data, draft: { ...draft.data, slug: slugify(input.targetKeyword) || slugify(draft.data.title) }, review: review.data, steps, provider: llm.provider };
}

// ---------------------------------------------------------------------------
// Deterministic development output (LLM_PROVIDER=mock). Labelled in the UI.
// ---------------------------------------------------------------------------
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function mockBrief(input: GenerationInput): ContentBrief {
  const k = input.targetKeyword;
  return {
    searchIntent: /buy|price|cost|best|vs|review/i.test(k) ? "commercial" : "informational",
    audience: input.audience || "People researching this topic for the first time",
    angle: `A practical, step-by-step look at ${k} with examples`,
    outline: [
      { heading: `What is ${k}?`, points: ["Plain-language definition", "Who it is for"] },
      { heading: `How ${k} works`, points: ["The main steps", "Common variations"] },
      { heading: `How to choose`, points: ["Criteria", "Mistakes to avoid"] },
    ],
    questions: [`What is ${k}?`, `How much does ${k} cost?`, `How long does ${k} take?`],
    entities: [k, ...input.secondaryKeywords.slice(0, 5)],
  };
}

function mockDraft(input: GenerationInput, brief: ContentBrief, links: LinkCandidate[]): ContentDraft {
  const k = input.targetKeyword;
  const link = links[0] ? ` For background, see [${links[0].title}](${links[0].url}).` : "";
  const sections = brief.outline.map((s) => `## ${s.heading}\n\n${s.points.map((p) => `${p} matters when you look at ${k}: this sample paragraph stands in for real copy written by the model.`).join(" ")}${link}\n`).join("\n");
  const faqs = brief.questions.map((q) => ({ question: q, answer: `This is sample development output. A real model answers "${q}" here in two or three sentences.` }));
  return {
    title: `${cap(k)}: A Practical Guide`,
    metaTitle: `${cap(k)}: A Practical Guide`.slice(0, 60),
    metaDescription: `Learn what ${k} is, how it works and how to choose the right option, with practical examples and answers to common questions.`.slice(0, 155),
    excerpt: `A practical guide to ${k}.`,
    bodyMarkdown: `${cap(k)} is explained here in plain language, starting with the short answer. This draft was produced by the development mock, not a real AI model.\n\n${sections}\n## FAQ\n\n${faqs.map((f) => `### ${f.question}\n\n${f.answer}`).join("\n\n")}\n`,
    faqs,
  };
}

function mockReview(): ContentReview {
  return {
    scores: { helpfulness: 5, expertise: 4, originality: 4, readability: 7, seo: 7 },
    claimsToVerify: [],
    issues: [{ severity: "high", message: "Development mock output: replace the sample paragraphs with real content." }],
    verdict: "needs_revision",
  };
}
