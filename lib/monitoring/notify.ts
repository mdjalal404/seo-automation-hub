import { createHmac, timingSafeEqual } from "node:crypto";
import { ENDPOINTS } from "@/lib/analytics/providers";
import { AppError } from "@/lib/errors";
import type { HttpClient, HttpResponse } from "@/lib/security/safe-fetch";
import type { Severity } from "@/lib/monitoring/diff";

/**
 * Alert delivery: Slack incoming webhooks and signed JSON webhooks. Sends are single POSTs
 * without automatic retries (a retry could post the same alert twice); failures are recorded
 * on the alert and shown in the app.
 */
export type OutgoingAlert = { id?: string; kind: string; severity: Severity; title: string; url: string | null; evidence: string[] };
export type AlertBatch = { website: { id: string; name: string; base_url: string }; alerts: OutgoingAlert[]; link: string; test?: boolean };

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
export const meetsSeverity = (s: Severity, min: Severity) => RANK[s] <= RANK[min];
const ICON: Record<Severity, string> = { critical: ":red_circle:", warning: ":large_orange_circle:", info: ":large_blue_circle:" };
/** Slack mrkdwn: escape control characters (&, <, >) in untrusted text. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function slackPayload(b: AlertBatch) {
  if (b.test) return { text: `SEO Automation Hub is connected. SEO alerts for ${b.website.name} will be posted here.` };
  const counts = (["critical", "warning", "info"] as const).map((s) => [s, b.alerts.filter((a) => a.severity === s).length] as const).filter(([, n]) => n);
  const summary = `${b.alerts.length} SEO alert${b.alerts.length === 1 ? "" : "s"} for ${b.website.name} (${counts.map(([s, n]) => `${n} ${s}`).join(", ")})`;
  const shown = b.alerts.slice(0, 15);
  return {
    text: summary,
    blocks: [
      { type: "header", text: { type: "plain_text", text: summary.slice(0, 150) } },
      ...shown.map((a) => ({
        type: "section",
        text: { type: "mrkdwn", text: `${ICON[a.severity]} *${esc(a.title)}*${a.url ? `\n<${a.url.replace(/[<>|]/g, "")}|${esc(a.url)}>` : ""}\n${a.evidence.slice(0, 4).map((e) => `• ${esc(e)}`).join("\n")}`.slice(0, 2900) },
      })),
      ...(b.alerts.length > shown.length ? [{ type: "context", elements: [{ type: "mrkdwn", text: `…and ${b.alerts.length - shown.length} more` }] }] : []),
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in SEO Automation Hub" }, url: b.link }] },
    ],
  };
}

function check(label: string, res: HttpResponse) {
  if (res.status >= 200 && res.status < 300) return;
  if (res.status === 403 || res.status === 404 || res.status === 410) throw new AppError("CMS_AUTH_FAILED", `${label} rejected the request (${res.status}). The URL may have been revoked.`, { status: res.status });
  if (res.status === 429) throw new AppError("RATE_LIMITED", `${label} is rate limiting requests.`, { status: 429 });
  throw new AppError("NETWORK_ERROR", `${label} returned HTTP ${res.status}.`, { status: res.status });
}

export async function sendSlack(http: HttpClient, webhookUrl: string, b: AlertBatch) {
  const path = new URL(webhookUrl).pathname;
  const res = await http(`${ENDPOINTS.slack()}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(slackPayload(b)), timeoutMs: 10_000, maxBytes: 10_000 });
  check("Slack", res);
}

export function webhookBody(b: AlertBatch) {
  return {
    type: b.test ? "test" : "seo.alerts",
    website: { id: b.website.id, name: b.website.name, url: b.website.base_url },
    link: b.link,
    alerts: b.alerts.map((a) => ({ id: a.id ?? null, kind: a.kind, severity: a.severity, title: a.title, url: a.url, evidence: a.evidence })),
  };
}

/** Signature over `${timestamp}.${body}` so receivers can reject replays outside a time window. */
export function signWebhook(secret: string, timestamp: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifyWebhookSignature(secret: string, timestamp: string, body: string, signature: string, toleranceSec = 300, now = Date.now()) {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const got = Buffer.from(signature);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export async function sendWebhook(http: HttpClient, url: string, secret: string, b: AlertBatch) {
  const body = JSON.stringify(webhookBody(b));
  const ts = String(Math.floor(Date.now() / 1000));
  const res = await http(url, {
    method: "POST", body, timeoutMs: 10_000, maxBytes: 10_000,
    headers: { "content-type": "application/json", "user-agent": "SEOAutomationHub-Webhook/1.0", "x-seohub-timestamp": ts, "x-seohub-signature": signWebhook(secret, ts, body) },
  });
  check("The webhook endpoint", res);
}
