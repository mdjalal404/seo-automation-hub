import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { createCmsAdapter } from "@/lib/cms/registry";
import type { ProcessorDeps } from "@/lib/publishing/processor";
import { createSupabaseJobRepository } from "@/lib/publishing/supabase-repository";
import { parseCredentials } from "@/lib/cms/credentials";
import { credentialAad, decryptSecret } from "@/lib/security/crypto";
import { safeFetch } from "@/lib/security/safe-fetch";
import { createAdminClient } from "@/lib/supabase/admin";
import { queueIndexNow } from "@/lib/tasks/monitoring";

/** Production wiring for the job processor (worker script, cron route, "process now"). */
export function createProcessorDeps(label = "worker"): ProcessorDeps {
  const db = createAdminClient();
  return {
    repo: createSupabaseJobRepository(db),
    http: safeFetch,
    workerId: `${label}:${hostname()}:${randomUUID().slice(0, 8)}`,
    leaseSeconds: 300,
    decryptCredentials(ctx) {
      const json = decryptSecret(ctx.encryptedCredentials!, credentialAad(ctx.website.organization_id, ctx.website.id));
      return parseCredentials(json, ctx.website.cms_type);
    },
    createAdapter(ctx, credentials) {
      return createCmsAdapter({
        cmsType: ctx.website.cms_type,
        baseUrl: ctx.website.base_url,
        credentials,
        http: safeFetch,
        settings: ctx.website.publishing_settings,
      });
    },
    async onPublished(info) {
      await queueIndexNow(db, { id: info.websiteId, organization_id: info.organizationId }, [info.url], "Published from SEO Automation Hub", `publish:${info.jobId}`);
    },
  };
}
