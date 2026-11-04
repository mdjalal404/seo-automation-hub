/**
 * CMS-agnostic adapter contract. Implementations: WordPress (lib/wordpress), Webflow,
 * Shopify and the documented custom REST contract (lib/cms/adapters). A new CMS plugs in
 * by implementing CmsAdapter and registering it in lib/cms/registry.ts.
 */
export type SeoFieldName = "meta_title" | "meta_description" | "canonical_url";

/** Lifecycle of an SEO field: stored here → sent to CMS → confirmed by its API → verified on the live page. */
export type SeoFieldSync = {
  stored: boolean;
  sent: boolean;
  confirmed: boolean;
  verified: boolean | null;
  note?: string;
};
export type SeoSyncState = Partial<Record<SeoFieldName, SeoFieldSync>>;

export type PostPayload = {
  title: string;
  slug: string;
  contentHtml: string;
  excerpt: string;
  categories: number[];
  tags: number[];
  featuredMediaId: number | null;
  seo: { metaTitle: string; metaDescription: string; canonicalUrl: string };
};

/**
 * A post/item on the CMS. `status` is normalized across platforms:
 * "draft" | "pending" (saved but not live) | "publish" (live) | "future" | other platform values.
 */
export type RemotePost = {
  id: string;
  status: string;
  link: string;
  slug: string;
  title: string;
  meta: Record<string, unknown>;
};

export type ConnectionInfo = {
  siteName: string;
  siteUrl: string;
  user: { id: string; name: string; slug: string };
  /** null when the platform cannot tell before the first write. */
  canPublish: boolean | null;
  /** Detected SEO capabilities (plugins on WordPress, writable fields elsewhere). */
  seoPlugins: string[];
  /** Non-secret discovered settings persisted to websites.publishing_settings. */
  settings: Record<string, unknown>;
  /** Non-secret descriptive details shown on the website page. */
  details: Record<string, string>;
  recentPosts: { id: string; title: string; status: string; link: string }[];
};

export type SeoWriteResult = { meta: Record<string, string>; sync: SeoSyncState; warnings: string[] };

export interface CmsAdapter {
  /** Human-readable platform name used in messages ("WordPress", "Webflow", …). */
  readonly label: string;
  testConnection(): Promise<ConnectionInfo>;
  getPosts(opts?: { perPage?: number }): Promise<RemotePost[]>;
  getPost(id: string): Promise<RemotePost | null>;
  findPostBySlug(slug: string): Promise<RemotePost | null>;
  createDraft(payload: PostPayload): Promise<{ post: RemotePost; seo: SeoWriteResult }>;
  updateDraft(id: string, payload: PostPayload): Promise<{ post: RemotePost; seo: SeoWriteResult }>;
  /** Makes the post live and returns it with status "publish" and its public link. */
  publishPost(id: string): Promise<RemotePost>;
}
