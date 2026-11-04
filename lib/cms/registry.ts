import { CustomCmsAdapter } from "@/lib/cms/adapters/custom";
import { ShopifyAdapter } from "@/lib/cms/adapters/shopify";
import { WebflowAdapter } from "@/lib/cms/adapters/webflow";
import { credentialsFor, type CmsCredentials } from "@/lib/cms/credentials";
import type { CmsAdapter } from "@/lib/cms/types";
import { appEnvironment } from "@/lib/env";
import { AppError } from "@/lib/errors";
import type { HttpClient } from "@/lib/security/safe-fetch";
import { WordPressAdapter } from "@/lib/wordpress/adapter";

export type AdapterFactoryInput = {
  cmsType: string;
  baseUrl: string;
  credentials: CmsCredentials;
  http: HttpClient;
  settings?: Record<string, unknown>;
};

/**
 * API endpoint overrides for local mocks. Ignored in production, so a stray variable
 * can never redirect real tokens to another host.
 */
function devOverride(name: "WEBFLOW_API_BASE_URL" | "SHOPIFY_ADMIN_BASE_URL") {
  if (appEnvironment() === "production") return undefined;
  return process.env[name] || undefined;
}

const interval = (s?: Record<string, unknown>) => (typeof s?.min_request_interval_ms === "number" ? s.min_request_interval_ms : undefined);

/** Add new CMS integrations here. */
export function createCmsAdapter(input: AdapterFactoryInput): CmsAdapter {
  switch (input.cmsType) {
    case "wordpress":
      return new WordPressAdapter({
        baseUrl: input.baseUrl,
        credentials: credentialsFor(input.credentials, "wordpress"),
        http: input.http,
        restRoot: typeof input.settings?.rest_root === "string" ? input.settings.rest_root : undefined,
        minIntervalMs: interval(input.settings),
      });
    case "webflow":
      return new WebflowAdapter({
        siteUrl: input.baseUrl, credentials: credentialsFor(input.credentials, "webflow"), http: input.http,
        apiBase: devOverride("WEBFLOW_API_BASE_URL"), minIntervalMs: interval(input.settings),
      });
    case "shopify":
      return new ShopifyAdapter({
        storefrontUrl: input.baseUrl, credentials: credentialsFor(input.credentials, "shopify"), http: input.http,
        adminBaseOverride: devOverride("SHOPIFY_ADMIN_BASE_URL"), minIntervalMs: interval(input.settings),
      });
    case "custom":
      return new CustomCmsAdapter({ siteUrl: input.baseUrl, credentials: credentialsFor(input.credentials, "custom"), http: input.http, minIntervalMs: interval(input.settings) });
    default:
      throw new AppError("INVALID_INPUT", `Unsupported CMS type: ${input.cmsType}`);
  }
}
