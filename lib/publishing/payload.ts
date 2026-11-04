import type { PostPayload } from "@/lib/cms/types";
import type { ContentRow } from "@/lib/database/types";
import { renderBody } from "@/lib/seo/html";
import type { ContentForCheck } from "@/lib/seo/types";

export function toPostPayload(c: ContentRow): PostPayload {
  return {
    title: c.title,
    slug: c.slug,
    contentHtml: renderBody(c.body, c.body_format),
    excerpt: c.excerpt,
    categories: c.categories ?? [],
    tags: c.tags ?? [],
    featuredMediaId: c.featured_media_id,
    seo: { metaTitle: c.meta_title, metaDescription: c.meta_description, canonicalUrl: c.canonical_url },
  };
}

export function toCheckInput(c: ContentRow): ContentForCheck {
  return {
    id: c.id,
    websiteId: c.website_id,
    title: c.title,
    slug: c.slug,
    body: c.body,
    bodyFormat: c.body_format,
    excerpt: c.excerpt,
    metaTitle: c.meta_title,
    metaDescription: c.meta_description,
    canonicalUrl: c.canonical_url,
    targetKeyword: c.target_keyword,
  };
}
