import type { PostPayload, RemotePost, SeoFieldName, SeoSyncState, SeoWriteResult } from "@/lib/cms/types";

/**
 * SEO plugin metadata adapters. WordPress core does not expose plugin fields through
 * the REST API; they are writable only when the site registers them with
 * register_post_meta(..., ['show_in_rest' => true]). We therefore only send a field
 * when the post's REST `meta` object proves the key is exposed, and only report it
 * as confirmed when the API echoes back the value we sent.
 */
export interface SeoMetaAdapter {
  id: "yoast" | "rankmath";
  label: string;
  keys: Partial<Record<SeoFieldName, string>>;
}

export const SEO_META_ADAPTERS: SeoMetaAdapter[] = [
  { id: "yoast", label: "Yoast SEO", keys: { meta_title: "_yoast_wpseo_title", meta_description: "_yoast_wpseo_metadesc", canonical_url: "_yoast_wpseo_canonical" } },
  { id: "rankmath", label: "Rank Math", keys: { meta_title: "rank_math_title", meta_description: "rank_math_description", canonical_url: "rank_math_canonical_url" } },
];

const FIELD_VALUE: Record<SeoFieldName, (p: PostPayload) => string> = {
  meta_title: (p) => p.seo.metaTitle,
  meta_description: (p) => p.seo.metaDescription,
  canonical_url: (p) => p.seo.canonicalUrl,
};

/** Picks the adapter whose keys are exposed in the post's REST meta object. */
export function detectWritableAdapter(exposedMeta: Record<string, unknown>): SeoMetaAdapter | null {
  return SEO_META_ADAPTERS.find((a) => Object.values(a.keys).some((k) => k in exposedMeta)) ?? null;
}

export function buildSeoMeta(payload: PostPayload, exposedMeta: Record<string, unknown>) {
  const adapter = detectWritableAdapter(exposedMeta);
  const meta: Record<string, string> = {};
  if (!adapter) return { adapter, meta };
  for (const [field, key] of Object.entries(adapter.keys) as [SeoFieldName, string][]) {
    const value = FIELD_VALUE[field](payload);
    if (value && key in exposedMeta) meta[key] = value;
  }
  return { adapter, meta };
}

/** Compares what we sent against what the CMS returned. */
export function seoSyncFromResponse(
  payload: PostPayload,
  sentMeta: Record<string, string>,
  adapter: SeoMetaAdapter | null,
  post: RemotePost,
): SeoWriteResult {
  const sync: SeoSyncState = {};
  const warnings: string[] = [];
  for (const field of Object.keys(FIELD_VALUE) as SeoFieldName[]) {
    const value = FIELD_VALUE[field](payload);
    if (!value) continue;
    const key = adapter?.keys[field];
    if (!key || !(key in sentMeta)) {
      sync[field] = {
        stored: true, sent: false, confirmed: false, verified: null,
        note: adapter
          ? `${adapter.label} field for ${field} is not exposed in the REST API.`
          : "No supported SEO plugin fields are exposed via the REST API. Stored in this app only.",
      };
      continue;
    }
    const confirmed = String(post.meta?.[key] ?? "") === value;
    sync[field] = { stored: true, sent: true, confirmed, verified: null, note: confirmed ? undefined : "WordPress did not echo back the value that was sent." };
  }
  const unsent = Object.entries(sync).filter(([, s]) => s && !s.sent).map(([f]) => f);
  if (unsent.length) {
    warnings.push(`SEO fields not saved to WordPress: ${unsent.join(", ")}. Register the plugin meta keys with show_in_rest to enable this (see README).`);
  }
  return { meta: sentMeta, sync, warnings };
}
