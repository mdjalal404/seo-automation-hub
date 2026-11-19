import { z } from "zod";
import { AppError } from "@/lib/errors";
import { parseServiceAccount, type ProviderId } from "@/lib/analytics/providers";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";

/** Secrets per provider (encrypted at rest; never sent to the browser). */
export type IntegrationSecret =
  | { provider: "google_search_console"; serviceAccount: string }
  | { provider: "google_analytics_4"; serviceAccount: string }
  | { provider: "microsoft_clarity"; apiToken: string }
  | { provider: "dataforseo"; login: string; password: string }
  | { provider: "similarweb"; apiKey: string }
  | { provider: "pagespeed"; apiKey: string | null }
  | { provider: "mixpanel"; username: string; secret: string }
  | { provider: "databricks"; token: string }
  | { provider: "slack"; webhookUrl: string }
  | { provider: "webhook"; url: string; signingSecret: string }
  | { provider: "indexnow"; key: string };

const MIN_SEVERITY = z.enum(["critical", "warning", "info"]).default("warning");

const text = (max: number) => z.string().trim().max(max);

export const integrationInputSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("google_search_console"), websiteId: z.uuid(), serviceAccount: text(20_000).min(50, "Paste the service account JSON key."), siteUrl: text(500).default("") }),
  z.object({ provider: z.literal("google_analytics_4"), websiteId: z.uuid(), serviceAccount: text(20_000).min(50, "Paste the service account JSON key."), propertyId: z.string().trim().regex(/^\d{4,15}$/, "Enter the numeric GA4 property ID.") }),
  z.object({ provider: z.literal("microsoft_clarity"), websiteId: z.uuid(), apiToken: text(4000).min(20, "Paste the Clarity data export token.") }),
  z.object({
    provider: z.literal("dataforseo"), websiteId: z.uuid(), login: text(200).min(3, "Enter the API login."), password: text(200).min(6, "Enter the API password."),
    locationCode: z.coerce.number().int().min(1).max(99_999_999).default(2840), languageCode: z.string().trim().regex(/^[a-z]{2}(-[a-z]{2,4})?$/i, "Use a language code like en.").default("en"),
    /** Extra markets for international rank tracking: "UK:2826:en, DE:2276:de" (label:location:language). */
    markets: text(500).default(""),
  }),
  z.object({ provider: z.literal("similarweb"), websiteId: z.uuid(), apiKey: text(500).min(10, "Paste the API key.") }),
  z.object({ provider: z.literal("pagespeed"), websiteId: z.uuid(), apiKey: text(500).default("") }),
  z.object({
    provider: z.literal("mixpanel"), websiteId: z.uuid(), username: text(300).min(3, "Enter the service account username."), secret: text(300).min(8, "Enter the service account secret."),
    projectId: z.string().trim().regex(/^\d{1,12}$/, "Enter the numeric project ID."), region: z.enum(["us", "eu", "in"]).default("us"),
    event: text(200).min(1, "Enter the conversion event name."), segmentProperty: text(200).min(1).default("landing_page"), where: text(1000).default(""),
  }),
  z.object({
    provider: z.literal("databricks"), websiteId: z.uuid(), host: text(300).min(5, "Enter the workspace host."), token: text(500).min(10, "Paste the access token."),
    warehouseId: text(64).min(8, "Enter the SQL warehouse ID."), catalog: text(128).default("main"), schema: text(128).default("seo"),
  }),
  z.object({
    provider: z.literal("slack"), websiteId: z.uuid(), minSeverity: MIN_SEVERITY,
    webhookUrl: z.string().trim().regex(/^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{10,200}$/, "Paste a Slack incoming webhook URL (https://hooks.slack.com/services/…)."),
  }),
  z.object({
    provider: z.literal("webhook"), websiteId: z.uuid(), minSeverity: MIN_SEVERITY,
    url: z.string().trim().max(2000).regex(/^https?:\/\//i, "Enter the endpoint URL (https://…)."),
    signingSecret: text(200).min(16, "Use a signing secret of at least 16 characters."),
  }),
  z.object({
    provider: z.literal("indexnow"), websiteId: z.uuid(),
    key: z.string().trim().regex(/^[a-zA-Z0-9-]{8,128}$/, "The key must be 8–128 letters, digits or dashes."),
    autoSubmit: z.enum(["on", "off"]).default("on"),
  }),
]);
export type IntegrationInput = z.infer<typeof integrationInputSchema>;

export function integrationAad(orgId: string, websiteId: string, provider: ProviderId) {
  return `integration:${orgId}:${websiteId}:${provider}`;
}

export function toSecret(v: IntegrationInput): IntegrationSecret {
  switch (v.provider) {
    case "google_search_console":
    case "google_analytics_4":
      parseServiceAccount(v.serviceAccount); // validates shape before anything is stored
      return v.provider === "google_search_console" ? { provider: v.provider, serviceAccount: v.serviceAccount } : { provider: v.provider, serviceAccount: v.serviceAccount };
    case "microsoft_clarity":
      return { provider: v.provider, apiToken: v.apiToken };
    case "dataforseo":
      return { provider: v.provider, login: v.login, password: v.password };
    case "similarweb":
      return { provider: v.provider, apiKey: v.apiKey };
    case "pagespeed":
      return { provider: v.provider, apiKey: v.apiKey || null };
    case "mixpanel":
      return { provider: v.provider, username: v.username, secret: v.secret };
    case "databricks":
      return { provider: v.provider, token: v.token };
    case "slack":
      return { provider: v.provider, webhookUrl: v.webhookUrl };
    case "webhook":
      return { provider: v.provider, url: v.url, signingSecret: v.signingSecret };
    case "indexnow":
      return { provider: v.provider, key: v.key };
  }
}

export function sealSecret(secret: IntegrationSecret, orgId: string, websiteId: string) {
  return encryptSecret(JSON.stringify(secret), integrationAad(orgId, websiteId, secret.provider));
}

export function openSecret<P extends ProviderId>(envelope: string, orgId: string, websiteId: string, provider: P): Extract<IntegrationSecret, { provider: P }> {
  const data = JSON.parse(decryptSecret(envelope, integrationAad(orgId, websiteId, provider))) as IntegrationSecret;
  if (data.provider !== provider) throw new AppError("INTERNAL", "Stored integration credentials do not match the provider.");
  return data as Extract<IntegrationSecret, { provider: P }>;
}

export type Market = { label: string; location_code: number; language_code: string };

export function parseMarkets(text: string): Market[] {
  if (!text.trim()) return [];
  return text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean).map((entry) => {
    const m = /^([\w -]{1,30}):(\d{1,8}):([a-z]{2}(?:-[a-z]{2,4})?)$/i.exec(entry);
    if (!m) throw new AppError("INVALID_INPUT", `Market "${entry}" should look like UK:2826:en (label:location code:language).`);
    return { label: m[1].trim(), location_code: Number(m[2]), language_code: m[3].toLowerCase() };
  }).slice(0, 5);
}
