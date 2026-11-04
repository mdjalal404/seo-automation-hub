import type { CmsType } from "@/lib/cms/platforms";
import { AppError } from "@/lib/errors";

/**
 * Per-platform credentials. The whole object is encrypted (AES-256-GCM, bound to the
 * organization and website), including where the token may be sent (shop domain, API
 * base URL), so the destination of a secret cannot be changed without re-entering it.
 */
export type WordPressCredentials = { kind?: "wordpress"; username: string; applicationPassword: string };
export type WebflowFieldMap = { body: string; summary?: string; metaTitle?: string; metaDescription?: string; canonical?: string };
export type WebflowCredentials = { kind: "webflow"; apiToken: string; collectionId: string; fieldMap?: Partial<WebflowFieldMap> };
export type ShopifyCredentials = { kind: "shopify"; shopDomain: string; accessToken: string; blogHandle: string; authorName: string };
export type CustomCmsCredentials = { kind: "custom"; apiBaseUrl: string; apiToken: string };

export type CmsCredentials = WordPressCredentials | WebflowCredentials | ShopifyCredentials | CustomCmsCredentials;

/** Parses decrypted credentials; envelopes written before multi-CMS support have no `kind` and are WordPress. */
export function parseCredentials(json: string, cmsType: string): CmsCredentials {
  const raw = JSON.parse(json) as CmsCredentials;
  const kind = raw.kind ?? "wordpress";
  if (kind !== cmsType) throw new AppError("CONFIG_MISSING", "Stored credentials belong to a different platform. Reconnect the website.");
  return { ...raw, kind } as CmsCredentials;
}

export function credentialsFor<K extends CmsType>(creds: CmsCredentials, kind: K): Extract<CmsCredentials, { kind?: K }> {
  if ((creds.kind ?? "wordpress") !== kind) throw new AppError("CONFIG_MISSING", `Expected ${kind} credentials.`);
  return creds as Extract<CmsCredentials, { kind?: K }>;
}

/** Display-safe identity for audit logs and metadata (never the secret). */
export function credentialLabel(creds: CmsCredentials): string {
  switch (creds.kind ?? "wordpress") {
    case "webflow": return `collection ${(creds as WebflowCredentials).collectionId}`;
    case "shopify": return (creds as ShopifyCredentials).shopDomain;
    case "custom": return new URL((creds as CustomCmsCredentials).apiBaseUrl).host;
    default: return (creds as WordPressCredentials).username;
  }
}
