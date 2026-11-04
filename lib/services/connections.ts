import "server-only";
import { unwrap } from "@/lib/actions/result";
import { assertCan, type SessionContext } from "@/lib/auth/session";
import { credentialLabel, parseCredentials, type CmsCredentials } from "@/lib/cms/credentials";
import { isAuthFailureCode, platformInfo } from "@/lib/cms/platforms";
import { createCmsAdapter } from "@/lib/cms/registry";
import type { ConnectionInfo } from "@/lib/cms/types";
import { allowPrivateNetworkTargets } from "@/lib/env";
import { AppError, isAppError } from "@/lib/errors";
import { logger } from "@/lib/observability/logger";
import { credentialAad, decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { enforceRateLimit } from "@/lib/security/rate-limit";
import { safeFetch } from "@/lib/security/safe-fetch";
import { normalizeWebsiteUrl } from "@/lib/security/url";
import { audit } from "@/lib/services/audit";
import { getWebsite } from "@/lib/services/websites";
import { createAdminClient } from "@/lib/supabase/admin";
import { connectionSchema, type ConnectionInput } from "@/lib/validation/schemas";

function connectionMetadata(info: ConnectionInfo, credentials: CmsCredentials) {
  return {
    username: credentialLabel(credentials),
    site_name: info.siteName,
    wp_user: info.user.name,
    can_publish: info.canPublish,
    seo_plugins: info.seoPlugins,
    details: info.details,
    recent_posts: info.recentPosts.slice(0, 5),
  };
}

/** Builds the credential object for the platform from validated form input. */
function toCredentials(v: ConnectionInput): CmsCredentials {
  switch (v.cmsType) {
    case "wordpress":
      return { kind: "wordpress", username: v.username, applicationPassword: v.applicationPassword };
    case "webflow": {
      const fieldMap = Object.fromEntries(
        Object.entries({ body: v.bodyField, summary: v.summaryField, metaTitle: v.metaTitleField, metaDescription: v.metaDescriptionField }).filter(([, s]) => s),
      );
      return { kind: "webflow", apiToken: v.apiToken, collectionId: v.collectionId, ...(Object.keys(fieldMap).length ? { fieldMap } : {}) };
    }
    case "shopify":
      return { kind: "shopify", shopDomain: v.shopDomain, accessToken: v.accessToken, blogHandle: v.blogHandle, authorName: v.authorName };
    case "custom":
      return { kind: "custom", apiBaseUrl: normalizeWebsiteUrl(v.apiBaseUrl, { allowPrivate: allowPrivateNetworkTargets() }), apiToken: v.apiToken };
  }
}

/**
 * Tests the supplied CMS credentials first and stores them (encrypted) only if the
 * CMS accepts them. The plaintext secret never leaves this function.
 */
export async function connectCms(ctx: SessionContext, input: unknown) {
  assertCan(ctx, "connections.manage");
  const v = connectionSchema.parse(input);
  await enforceRateLimit("cms-connect", `${ctx.user.id}`, 10, 600);
  const { website } = await getWebsite(ctx, v.websiteId); // RLS-scoped: proves org ownership
  if (v.cmsType !== website.cms_type) {
    throw new AppError("INVALID_INPUT", `This website is set up for ${platformInfo(website.cms_type).label}, not ${platformInfo(v.cmsType).label}.`);
  }
  const credentials = toCredentials(v);
  const label = platformInfo(website.cms_type).label;
  const adapter = createCmsAdapter({ cmsType: website.cms_type, baseUrl: website.base_url, credentials, http: safeFetch, settings: { min_request_interval_ms: 0 } });
  const info = await adapter.testConnection();
  if (info.canPublish === false) {
    throw new AppError(website.cms_type === "wordpress" ? "WP_FORBIDDEN" : "CMS_FORBIDDEN",
      website.cms_type === "wordpress"
        ? `WordPress accepted the login, but user "${info.user.slug}" cannot publish posts. Use an Author, Editor or Administrator account.`
        : `${label} accepted the credentials, but they do not allow publishing. Check the token's permissions/scopes.`);
  }

  const admin = createAdminClient();
  const envelope = encryptSecret(JSON.stringify(credentials), credentialAad(ctx.org.id, website.id));
  const now = new Date().toISOString();
  unwrap(await admin.from("cms_connections").upsert({
    organization_id: ctx.org.id, website_id: website.id, connection_type: platformInfo(website.cms_type).connectionType,
    encrypted_credentials: envelope, metadata: connectionMetadata(info, credentials), connection_status: "connected",
    last_tested_at: now, last_error: null,
  }, { onConflict: "website_id" }));
  unwrap(await admin.from("websites").update({
    connection_status: "connected", publishing_settings: { ...website.publishing_settings, ...info.settings },
  }).eq("id", website.id).eq("organization_id", ctx.org.id));
  await audit(ctx, "connection.created", "website", website.id, { platform: website.cms_type, account: credentialLabel(credentials), seo_plugins: info.seoPlugins });
  return info;
}

export async function testStoredConnection(ctx: SessionContext, websiteId: string) {
  assertCan(ctx, "connections.manage");
  await enforceRateLimit("cms-test", ctx.user.id, 20, 600);
  const { website, connection } = await getWebsite(ctx, websiteId);
  if (!connection) throw new AppError("NOT_FOUND", "This website is not connected yet.");
  const admin = createAdminClient();
  const stored = unwrap(await admin.from("cms_connections").select("encrypted_credentials, metadata").eq("website_id", websiteId).eq("organization_id", ctx.org.id).single());
  const credentials = parseCredentials(decryptSecret(stored.encrypted_credentials, credentialAad(ctx.org.id, websiteId)), website.cms_type);
  const adapter = createCmsAdapter({ cmsType: website.cms_type, baseUrl: website.base_url, credentials, http: safeFetch, settings: website.publishing_settings });
  const now = new Date().toISOString();
  try {
    const info = await adapter.testConnection();
    unwrap(await admin.from("cms_connections").update({ connection_status: "connected", last_tested_at: now, last_error: null, metadata: connectionMetadata(info, credentials) }).eq("website_id", websiteId).eq("organization_id", ctx.org.id));
    unwrap(await admin.from("websites").update({ connection_status: "connected" }).eq("id", websiteId).eq("organization_id", ctx.org.id));
    return info;
  } catch (err) {
    const status = isAppError(err) && isAuthFailureCode(err.code) ? "auth_failed" : "error";
    const message = isAppError(err) ? err.message : "Connection test failed.";
    logger.warn("connection.test_failed", { websiteId, code: isAppError(err) ? err.code : "unknown" });
    await admin.from("cms_connections").update({ connection_status: status, last_tested_at: now, last_error: message }).eq("website_id", websiteId).eq("organization_id", ctx.org.id);
    await admin.from("websites").update({ connection_status: status }).eq("id", websiteId).eq("organization_id", ctx.org.id);
    throw err;
  }
}

export async function deleteConnection(ctx: SessionContext, websiteId: string) {
  assertCan(ctx, "connections.manage");
  const active = unwrap(await ctx.supabase.from("content_jobs").select("id").eq("website_id", websiteId).in("status", ["VALIDATING", "PUBLISHING", "VERIFYING"]).limit(1));
  if (active?.length) throw new AppError("CONFLICT", "Jobs are running for this website. Try again when they finish.");
  const rows = unwrap(await ctx.supabase.from("cms_connections").delete().eq("website_id", websiteId).eq("organization_id", ctx.org.id).select("id"));
  if (!rows?.length) throw new AppError("NOT_FOUND", "No connection to remove.");
  unwrap(await createAdminClient().from("websites").update({ connection_status: "not_connected" }).eq("id", websiteId).eq("organization_id", ctx.org.id));
  await audit(ctx, "connection.deleted", "website", websiteId);
}
