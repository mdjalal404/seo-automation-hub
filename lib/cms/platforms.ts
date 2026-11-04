/**
 * Client-safe descriptions of the supported CMS platforms (labels and UI copy only;
 * no secrets, no server imports). Adapters live in lib/cms/adapters and lib/wordpress.
 */
export const CMS_TYPES = ["wordpress", "webflow", "shopify", "custom"] as const;
export type CmsType = (typeof CMS_TYPES)[number];

export type PlatformInfo = {
  label: string;
  /** What a published item is called on this platform. */
  itemNoun: string;
  addressHint: string;
  connectionType: string;
  /** How to fully revoke access on the platform side after disconnecting here. */
  revokeHint: string;
  seoSupport: string;
  supportsTaxonomyIds: boolean;
};

export const PLATFORMS: Record<CmsType, PlatformInfo> = {
  wordpress: {
    label: "WordPress",
    itemNoun: "post",
    addressHint: "The WordPress site's public address, e.g. https://blog.example.com",
    connectionType: "wordpress_application_password",
    revokeHint: "delete the application password in WordPress under Users → Profile → Application Passwords",
    seoSupport:
      "Meta titles, descriptions and canonicals are only sent when the site exposes the SEO plugin's fields through the REST API (registered with show_in_rest).",
    supportsTaxonomyIds: true,
  },
  webflow: {
    label: "Webflow",
    itemNoun: "CMS item",
    addressHint: "The published site's address, e.g. https://www.example.com (collection pages live at /<collection-slug>/<item-slug>)",
    connectionType: "webflow_api_token",
    revokeHint: "delete the API token in Webflow under Site settings → Apps & integrations → API access",
    seoSupport:
      "Webflow has no per-item SEO API. Meta title and description are written to the collection fields mapped below, and only appear on the live page if the collection template binds its SEO settings to those fields.",
    supportsTaxonomyIds: false,
  },
  shopify: {
    label: "Shopify",
    itemNoun: "blog article",
    addressHint: "The storefront address, e.g. https://shop.example.com (articles live at /blogs/<blog-handle>/<article-handle>)",
    connectionType: "shopify_admin_token",
    revokeHint: "uninstall the custom app (or rotate its Admin API token) in Shopify under Settings → Apps and sales channels → Develop apps",
    seoSupport:
      "Meta title and description are written to Shopify's built-in article SEO fields (global.title_tag / global.description_tag). Shopify generates canonical URLs itself, so custom canonicals are not sent.",
    supportsTaxonomyIds: false,
  },
  custom: {
    label: "Custom CMS",
    itemNoun: "post",
    addressHint: "The public address of the site the custom CMS publishes to, e.g. https://www.example.com",
    connectionType: "custom_bearer_token",
    revokeHint: "revoke the API token in your CMS",
    seoSupport:
      "SEO fields are sent only if the CMS lists them in capabilities.seo_fields from GET /site, and are confirmed only when the API echoes them back (see docs/CUSTOM_CMS.md).",
    supportsTaxonomyIds: false,
  },
};

export function isCmsType(v: unknown): v is CmsType {
  return typeof v === "string" && (CMS_TYPES as readonly string[]).includes(v);
}

export function platformInfo(cmsType: string): PlatformInfo {
  return isCmsType(cmsType) ? PLATFORMS[cmsType] : { ...PLATFORMS.custom, label: cmsType };
}

/** Error codes meaning "the stored credentials were rejected" (any platform). */
export const AUTH_FAILURE_CODES = ["WP_AUTH_FAILED", "CMS_AUTH_FAILED"] as const;
export function isAuthFailureCode(code: string | null | undefined) {
  return !!code && (AUTH_FAILURE_CODES as readonly string[]).includes(code);
}
