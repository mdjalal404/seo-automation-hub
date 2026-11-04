import { AppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import type { HttpClient } from "@/lib/security/safe-fetch";

/**
 * Estimates how much of an article reads as AI-generated.
 *
 * No detector can prove authorship. Results are always reported as an *estimate* with
 * the method that produced it:
 * - "heuristic": built in, offline, explainable. Scores each sentence on stock "LLM
 *   phrasing", formulaic transitions and unusually uniform sentence rhythm (low
 *   burstiness). Deliberately conservative: it under-reports rather than accusing
 *   human writers.
 * - "sapling": optional external detector (AI_DETECTION_PROVIDER=sapling + SAPLING_API_KEY).
 *   Sends the article text to Sapling; falls back to the heuristic if unavailable.
 */
export type AiEstimate = {
  /** Share of words in passages that read as AI-generated, 0–100. */
  aiPercent: number;
  method: "heuristic" | "sapling";
  sentencesAnalyzed: number;
  /** Up to three of the most AI-like passages (trimmed), to help editors rewrite. */
  flagged: string[];
  note?: string;
};

export const MIN_WORDS_FOR_ESTIMATE = 80;

// Phrases strongly associated with LLM output in marketing/SEO copy.
const STRONG = [
  /\bdelv(e|es|ing)\b/, /\btapestry\b/, /\btestament to\b/, /\bin today's (fast-paced|digital|ever-changing|ever-evolving|competitive|modern)\b/,
  /\bever-(evolving|changing) (landscape|world)\b/, /\bnavigat(e|ing) the (complexities|intricacies|landscape|world)\b/,
  /\bit(?: is|'s) (important|worth|crucial|essential) to (note|remember|consider|understand)\b/, /\bunlock(ing)? the (full )?(potential|power)\b/,
  /\bharness(ing)? the power\b/, /\bembark(ing)? on\b/, /\bin the realm of\b/, /\blook no further\b/,
  /\bplays? a (crucial|pivotal|vital|key|significant) role\b/, /\ba (game[- ]changer)\b/, /\bin conclusion\b/, /\bin summary\b/,
  /\belevate your\b/, /\bdive (deep )?into\b/, /\btake (your|the) [\w-]+( [\w-]+)? to the next level\b/, /\bpeace of mind\b/,
  /\b(learning|educational|spiritual|fitness|weight[- ]loss|seo|healing) journey\b/, /\bcannot be overstated\b/, /\bbuild(ing)? a (lifelong|lasting|strong(er)?) (connection|relationship|foundation)\b/,
];
// Sentence templates typical of LLM explainer/marketing copy.
const TEMPLATES = [
  /\bwhether you(?: are|'re)\b/, /\bnot only\b[^.]*\bbut also\b/, /\b(can|will) help (you|your|them|businesses|students)\b/,
  /\ballows? (you|users|students|families|businesses|customers|individuals|teams) to\b/, /\bmakes? (it )?([\w-]+ )?(easier|simpler|more [\w-]+)\b/,
  /\bis (an? )?(important|essential|crucial|key|great|excellent|convenient|ideal|popular) (step|option|way|part|choice|factor|aspect)\b/,
  /\b(the|a) (right|best|perfect|ideal) (choice|fit|option|teacher|partner|solution)\b/, /\bwhen (selecting|choosing|looking for|it comes to)\b/,
  /\bconsider (their|the|your|factors)\b/, /\bat (their|your) own pace\b/, /\bwide (range|variety) of\b/, /\bfrom [\w-]+( [\w-]+)? to [\w-]+/,
];
// Vocabulary over-represented in LLM output but also normal in professional writing: weak signals.
const WEAK = [
  /\bseamless(ly)?\b/, /\brobust\b/, /\bleverag(e|es|ing)\b/, /\blandscape\b/, /\bcutting-edge\b/, /\btransformative\b/,
  /\bmyriad\b/, /\bplethora\b/, /\bparamount\b/, /\bmeticulous(ly)?\b/, /\bintricate\b/, /\bholistic\b/, /\bempower(s|ing)?\b/,
  /\bstreamlin(e|es|ing)\b/, /\bunderscor(e|es|ing)\b/, /\bfoster(s|ing)?\b/, /\bpivotal\b/, /\bcrucial\b/, /\bcomprehensive\b/,
  /\bresonat(e|es|ing)\b/, /\bvibrant\b/, /\bembrac(e|es|ing)\b/, /\bnuanced\b/, /\boptimal\b/, /\bessential\b/, /\brewarding\b/,
  /\benrich(ing|ed)?\b/, /\bmeaningful\b/, /\bpersonali[sz]ed\b/, /\btailored\b/, /\bconvenient\b/, /\bcomfortable\b/, /\bvaluable\b/,
  /\binvaluable\b/, /\benhanc(e|es|ed|ing)\b/, /\bensur(e|es|ing)\b/, /\bdedicated\b/, /\bqualified\b/, /\bknowledgeable\b/,
  /\bexpertise\b/, /\binsights?\b/, /\bvarious\b/, /\bnumerous\b/, /\bthrive\b/, /\bhassle-free\b/, /\btop-notch\b/, /\bworld-class\b/,
  /\bstate-of-the-art\b/, /\buser-friendly\b/, /\bbeginner-friendly\b/, /\blifelong\b/, /\bconfidence\b/, /\bwell-being\b/,
  /\bjourney\b/, /\bgradually\b/, /\beffective(ly)?\b/, /\bsignificant(ly)?\b/, /\bflexible\b/, /\bunique\b/, /\bexplore\b/,
];
const TRANSITION_START = /^(additionally|furthermore|moreover|overall|ultimately|notably|importantly|in conclusion|in summary|in essence|that said|by doing so|as a result|in addition|with (the|its) (help|rise)),?\s/;
// "X, Y, and Z" lists ("rule of three"), heavily overused by chat assistants.
const TRIAD = /\b[\w'-]+(?: [\w'-]+){0,3}, [\w'-]+(?: [\w'-]+){0,3},? (?:and|or) [\w'-]+/g;
const CONCLUSION_HEADING = /^(conclusion|in conclusion|final thoughts|key takeaways|in summary|summary|wrapping up|the bottom line|faqs?|frequently asked questions)\b/i;

const words = (s: string) => s.split(/\s+/).filter(Boolean);
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const norm = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");

/** Short lines without terminal punctuation are treated as headings, not sentences. */
function isHeading(line: string) {
  return words(line).length <= 12 && !/[.!:;,]$/.test(line.trim());
}

export function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .filter((line) => !isHeading(line))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(])/))
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 3);
}

function coefficientOfVariation(lengths: number[]) {
  if (lengths.length < 3) return 1;
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  return mean ? Math.sqrt(variance) / mean : 1;
}

const count = (re: RegExp, s: string) => (s.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`)) ?? []).length;

/** Signals in one sentence: positive = AI-like, negative = human voice. */
function localScore(sentence: string) {
  const lower = norm(sentence);
  const strong = STRONG.filter((re) => re.test(lower)).length;
  const template = TEMPLATES.filter((re) => re.test(lower)).length;
  const weak = WEAK.filter((re) => re.test(lower)).length;
  const triads = count(TRIAD, lower);
  const transition = TRANSITION_START.test(lower) ? 1 : 0;
  const voice =
    (/\b(i|i'm|i've|i'd|me|my)\b/.test(lower) ? 1 : 0) + (/n't\b|'(re|ve|ll|d)\b/.test(lower) ? 1 : 0) + (/[?!]$/.test(lower) ? 1 : 0);
  return Math.min(0.9, strong * 0.45 + template * 0.25 + weak * 0.12 + Math.min(2, triads) * 0.15 + transition * 0.25) - Math.min(0.5, voice * 0.2);
}

/**
 * Document-level style profile in [0, 1]. Chat-assistant text is typically formal
 * (no contractions), addressed to "you" rather than written as "I", full of
 * "X, Y, and Z" lists and generic marketing vocabulary, evenly paced, light on
 * concrete numbers, and often ends with a "Conclusion" heading.
 */
export function documentProfile(text: string) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const headings = lines.filter(isHeading);
  const sentences = splitSentences(text);
  const all = norm(sentences.join(" "));
  const n = Math.max(1, words(all).length);
  const per100 = (k: number) => (100 * k) / n;
  const contractions = per100(count(/\b\w+n't\b|\b\w+'(re|ve|ll|d|m)\b|\bit's\b|\bthat's\b|\blet's\b/g, all));
  const firstPerson = per100(count(/\b(i|me|my|i'm|i've)\b/g, all));
  const triads = count(TRIAD, all) / Math.max(1, sentences.length);
  const vocab = per100(sentences.reduce((k, s) => k + WEAK.filter((re) => re.test(norm(s))).length + TEMPLATES.filter((re) => re.test(norm(s))).length * 2 + STRONG.filter((re) => re.test(norm(s))).length * 3, 0));
  const numbers = per100(count(/\b\d[\d,.]*\b/g, all));
  const cv = coefficientOfVariation(sentences.map((s) => words(s).length));
  const features = {
    formal: clamp(1 - contractions / 1.2),
    impersonal: clamp(1 - firstPerson / 0.8),
    lists: clamp(triads / 0.35),
    vocabulary: clamp(vocab / 6),
    evenPacing: clamp((0.65 - cv) / 0.35),
    vague: clamp(1 - numbers / 1.5),
    conclusion: headings.some((h) => CONCLUSION_HEADING.test(h)) ? 1 : 0,
  };
  const score =
    0.17 * features.formal + 0.1 * features.impersonal + 0.2 * features.lists + 0.25 * features.vocabulary +
    0.08 * features.evenPacing + 0.08 * features.vague + 0.12 * features.conclusion;
  return { score: clamp(score), features };
}

/** Per-sentence AI-likeness in [0, 1], combining the document profile with local signals. Exported for tests. */
export function scoreSentences(sentences: string[], profile = documentProfile(sentences.join("\n"))): number[] {
  return sentences.map((s) => clamp(0.8 * profile.score + localScore(s) - 0.1));
}

export function heuristicEstimate(text: string): AiEstimate {
  const sentences = splitSentences(text);
  const scores = scoreSentences(sentences, documentProfile(text));
  let total = 0;
  let flaggedWords = 0;
  sentences.forEach((s, i) => {
    const n = words(s).length;
    total += n;
    if (scores[i] >= 0.5) flaggedWords += n;
  });
  const flagged = sentences
    .map((s, i) => ({ s, score: scores[i] }))
    .filter((x) => x.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => (x.s.length > 160 ? `${x.s.slice(0, 157)}…` : x.s));
  return { aiPercent: total ? Math.round((100 * flaggedWords) / total) : 0, method: "heuristic", sentencesAnalyzed: sentences.length, flagged };
}

type SaplingResponse = { score?: number; sentence_scores?: { score: number; sentence: string }[] };

/** Sapling AI Detector (https://sapling.ai/docs/api/detector). Not exercised against the live API in this repository. */
export async function saplingEstimate(text: string, apiKey: string, http: HttpClient): Promise<AiEstimate> {
  const res = await http("https://api.sapling.ai/api/v1/aidetect", {
    method: "POST",
    timeoutMs: 20_000,
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ key: apiKey, text: text.slice(0, 50_000), sent_scores: true }),
  });
  if (res.status !== 200) throw new AppError("NETWORK_ERROR", `AI detector returned HTTP ${res.status}.`);
  const data = JSON.parse(res.text) as SaplingResponse;
  const sentences = (data.sentence_scores ?? []).filter((s) => typeof s.score === "number" && typeof s.sentence === "string");
  if (!sentences.length && typeof data.score !== "number") throw new AppError("NETWORK_ERROR", "AI detector returned an unexpected response.");
  let total = 0;
  let flaggedWords = 0;
  for (const s of sentences) {
    const n = words(s.sentence).length;
    total += n;
    if (s.score >= 0.5) flaggedWords += n;
  }
  const aiPercent = total ? Math.round((100 * flaggedWords) / total) : Math.round((data.score ?? 0) * 100);
  const flagged = sentences.filter((s) => s.score >= 0.5).sort((a, b) => b.score - a.score).slice(0, 3)
    .map((s) => (s.sentence.length > 160 ? `${s.sentence.slice(0, 157)}…` : s.sentence.trim()));
  return { aiPercent, method: "sapling", sentencesAnalyzed: sentences.length, flagged };
}

export function aiDetectionProvider(): { provider: "sapling"; apiKey: string } | null {
  const key = process.env.SAPLING_API_KEY;
  return process.env.AI_DETECTION_PROVIDER === "sapling" && key ? { provider: "sapling", apiKey: key } : null;
}

/** Uses the configured external detector when network access is allowed, else the heuristic. */
export async function estimateAiShare(text: string, http?: HttpClient): Promise<AiEstimate> {
  const provider = aiDetectionProvider();
  if (provider && http) {
    try {
      return await saplingEstimate(text, provider.apiKey, http);
    } catch (err) {
      logger.warn("ai_detection.provider_failed", { provider: provider.provider, code: err instanceof AppError ? err.code : "unknown" });
      return { ...heuristicEstimate(text), note: "The external AI detector was unavailable, so the built-in estimate was used." };
    }
  }
  return heuristicEstimate(text);
}
