/**
 * Keyword intent classification and clustering.
 *
 * Clustering is deterministic: keywords are grouped when their top-10 Google results
 * overlap (the standard "SERP similarity" method, used when DataForSEO SERP data is
 * available) or, without SERP data, when their normalized word sets are similar.
 * Larger-volume keywords become cluster heads.
 */
export type Intent = "informational" | "commercial" | "transactional" | "navigational" | "local";

export type KeywordInput = { id?: string; keyword: string; volume?: number | null; serpUrls?: string[] };
export type Cluster = { name: string; head: string; intent: Intent; totalVolume: number; keywords: KeywordInput[] };

const STOP = new Set("a an and are as at be by can do does for from how i in is it my of on or the to what when where which who why will with you your".split(" "));

export function normalizeKeyword(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && /(ch|sh|x|s)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}

export function tokens(keyword: string): Set<string> {
  return new Set(normalizeKeyword(keyword).split(" ").filter((w) => w && !STOP.has(w)).map(stem));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

export function classifyIntent(keyword: string): Intent {
  const k = ` ${normalizeKeyword(keyword)} `;
  if (/ near me | nearby | in my area | open now /.test(k)) return "local";
  if (/ (buy|order|price|prices|pricing|cost|cheap|discount|coupon|deal|deals|hire|book|quote|for sale|subscribe|download) /.test(k)) return "transactional";
  if (/ (best|top|vs|versus|review|reviews|compare|comparison|alternative|alternatives|recommended) /.test(k)) return "commercial";
  if (/ (login|log in|sign in|account|official site|website|contact|customer service) /.test(k)) return "navigational";
  return "informational";
}

export type ClusterOptions = { similarity?: number; serpOverlap?: number };

export function clusterKeywords(input: KeywordInput[], opts: ClusterOptions = {}): Cluster[] {
  const threshold = opts.similarity ?? 0.5;
  const minOverlap = opts.serpOverlap ?? 3;
  const sorted = [...input].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || a.keyword.length - b.keyword.length);
  const clusters: { head: KeywordInput; headTokens: Set<string>; headSerp: Set<string>; members: KeywordInput[] }[] = [];
  for (const kw of sorted) {
    const t = tokens(kw.keyword);
    const serp = new Set(kw.serpUrls ?? []);
    let best: (typeof clusters)[number] | null = null;
    let bestScore = 0;
    for (const c of clusters) {
      let score = 0;
      if (serp.size && c.headSerp.size) {
        let shared = 0;
        for (const u of serp) if (c.headSerp.has(u)) shared++;
        score = shared >= minOverlap ? 1 + shared / 10 : 0;
      } else {
        score = jaccard(t, c.headTokens);
        if (score < threshold) score = 0;
      }
      if (score > bestScore) [best, bestScore] = [c, score];
    }
    if (best) best.members.push(kw);
    else clusters.push({ head: kw, headTokens: t, headSerp: serp, members: [kw] });
  }
  return clusters.map((c) => ({
    name: c.head.keyword.replace(/\b\p{L}/gu, (m) => m.toUpperCase()),
    head: c.head.keyword,
    intent: majorityIntent(c.members),
    totalVolume: c.members.reduce((n, k) => n + (k.volume ?? 0), 0),
    keywords: c.members,
  })).sort((a, b) => b.totalVolume - a.totalVolume || b.keywords.length - a.keywords.length);
}

function majorityIntent(members: KeywordInput[]): Intent {
  const counts = new Map<Intent, number>();
  for (const m of members) counts.set(classifyIntent(m.keyword), (counts.get(classifyIntent(m.keyword)) ?? 0) + (m.volume ?? 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "informational";
}

/** Parses a pasted list or CSV ("keyword,volume") into unique normalized keywords. */
export function parseKeywordList(text: string, max = 2000): { keyword: string; volume: number | null }[] {
  const seen = new Map<string, number | null>();
  for (const line of text.split(/\r?\n/)) {
    const [rawKw, rawVol] = line.split(/[,\t;]/);
    const keyword = normalizeKeyword(rawKw ?? "");
    if (!keyword || keyword === "keyword") continue;
    const vol = rawVol ? Number(rawVol.replace(/[^\d.]/g, "")) : NaN;
    if (!seen.has(keyword)) seen.set(keyword, Number.isFinite(vol) ? Math.round(vol) : null);
    if (seen.size >= max) break;
  }
  return [...seen.entries()].map(([keyword, volume]) => ({ keyword, volume }));
}
