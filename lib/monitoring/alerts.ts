import type { SupabaseClient } from "@supabase/supabase-js";
import { openSecret } from "@/lib/analytics/credentials";
import { isAppError } from "@/lib/errors";
import type { Finding, Severity } from "@/lib/monitoring/diff";
import { meetsSeverity, sendSlack, sendWebhook, type AlertBatch, type OutgoingAlert } from "@/lib/monitoring/notify";
import { logger } from "@/lib/observability/logger";
import type { HttpClient } from "@/lib/security/safe-fetch";

/**
 * Persists findings as alerts (one open alert per fingerprint; repeats bump `occurrences`),
 * resolves alerts whose condition has cleared, and delivers newly opened alerts to the
 * website's Slack / webhook channels. Delivery problems never fail the calling task.
 */
type Website = { id: string; organization_id: string; name: string; base_url: string };
type OpenAlert = { id: string; kind: string; url: string | null; fingerprint: string; occurrences: number };

export type RecordOptions = {
  /** Decide for each open alert of this source that was not re-detected: true = still present, false = resolve, null = keep. */
  stillPresent?: (a: OpenAlert) => boolean | null;
};

export const appLink = (path: string) => `${(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

export async function recordFindings(db: SupabaseClient, http: HttpClient, w: Website, source: "audit" | "traffic" | "gate", findings: Finding[], opts: RecordOptions = {}) {
  const { data: openRows, error } = await db.from("seo_alerts").select("id, kind, url, fingerprint, occurrences").eq("website_id", w.id).eq("source", source).neq("status", "resolved");
  if (error) throw error;
  const open = new Map((openRows as OpenAlert[]).map((a) => [a.fingerprint, a]));
  const now = new Date().toISOString();
  const created: OutgoingAlert[] = [];
  let updated = 0, resolved = 0;
  const seen = new Set<string>();

  for (const f of findings) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    const existing = open.get(f.fingerprint);
    if (existing) {
      await db.from("seo_alerts").update({ occurrences: existing.occurrences + 1, last_seen_at: now, evidence: f.evidence, title: f.title, severity: f.severity }).eq("id", existing.id);
      updated++;
      continue;
    }
    const { data, error: insErr } = await db.from("seo_alerts").insert({
      organization_id: w.organization_id, website_id: w.id, source, kind: f.kind, severity: f.severity, title: f.title.slice(0, 300), url: f.url?.slice(0, 2048) ?? null,
      evidence: f.evidence.slice(0, 20), fingerprint: f.fingerprint.slice(0, 600),
    }).select("id").single();
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") { updated++; continue; } // opened concurrently
      throw insErr;
    }
    created.push({ id: data.id as string, kind: f.kind, severity: f.severity, title: f.title, url: f.url, evidence: f.evidence });
  }

  for (const a of open.values()) {
    if (seen.has(a.fingerprint)) continue;
    const present = opts.stillPresent ? opts.stillPresent(a) : null;
    if (present === false) {
      await db.from("seo_alerts").update({ status: "resolved", resolved_at: now, resolved_reason: source === "traffic" ? "No longer detected in Search Console data" : "Fixed: the latest check no longer finds the problem" }).eq("id", a.id);
      resolved++;
    }
  }

  const notified = created.length ? await deliver(db, http, w, created) : {};
  return { created: created.length, updated, resolved, notified };
}

/** Sends one message per channel with the alerts at or above that channel's minimum severity. */
export async function deliver(db: SupabaseClient, http: HttpClient, w: Website, alerts: OutgoingAlert[]) {
  const { data } = await db.from("integrations").select("id, provider, encrypted_credentials, metadata").eq("website_id", w.id).eq("organization_id", w.organization_id).in("provider", ["slack", "webhook"]);
  const channels = (data ?? []) as { id: string; provider: "slack" | "webhook"; encrypted_credentials: string; metadata: Record<string, unknown> }[];
  const results: Record<string, string> = {};
  for (const ch of channels) {
    const min = (ch.metadata.min_severity as Severity | undefined) ?? "warning";
    const batch: AlertBatch = { website: w, alerts: alerts.filter((a) => meetsSeverity(a.severity, min)), link: appLink(`/monitoring?website=${w.id}`) };
    if (!batch.alerts.length) continue;
    try {
      if (ch.provider === "slack") await sendSlack(http, openSecret(ch.encrypted_credentials, w.organization_id, w.id, "slack").webhookUrl, batch);
      else {
        const s = openSecret(ch.encrypted_credentials, w.organization_id, w.id, "webhook");
        await sendWebhook(http, s.url, s.signingSecret, batch);
      }
      results[ch.provider] = `sent ${batch.alerts.length}`;
      await db.from("integrations").update({ status: "connected", last_error: null, last_synced_at: new Date().toISOString() }).eq("id", ch.id);
    } catch (err) {
      const msg = isAppError(err) ? err.message : "Delivery failed";
      results[ch.provider] = `failed: ${msg}`;
      logger.warn("alerts.delivery_failed", { websiteId: w.id, channel: ch.provider, code: isAppError(err) ? err.code : "INTERNAL" });
      await db.from("integrations").update({ status: isAppError(err) && err.code === "CMS_AUTH_FAILED" ? "auth_failed" : "error", last_error: msg }).eq("id", ch.id);
    }
  }
  const ids = alerts.map((a) => a.id).filter(Boolean) as string[];
  if (ids.length && Object.keys(results).length) await db.from("seo_alerts").update({ notified: { ...results, at: new Date().toISOString() } }).in("id", ids);
  return results;
}
