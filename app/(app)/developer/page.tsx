import { PageHeader } from "@/components/common/page-header";
import { ToneBadge } from "@/components/common/status-badge";
import { can } from "@/lib/auth/permissions";
import { requireWorkspace } from "@/lib/auth/session";
import { formatRelative } from "@/lib/format";
import { listApiKeys, listGateRuns } from "@/lib/services/monitoring";
import { pickWebsite } from "@/lib/services/site-picker";
import { ApiKeyManager, GateRunForm } from "./developer-forms";

export const metadata = { title: "API & CI/CD" };
const SEV = { error: "danger", warning: "warning", info: "neutral" } as const;

export default async function DeveloperPage() {
  const ctx = await requireWorkspace();
  const [{ websites }, keys, runs] = await Promise.all([pickWebsite(ctx), listApiKeys(ctx), listGateRuns(ctx)]);
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const site = websites[0]?.id ?? "<website-id>";
  const github = `# .github/workflows/seo-gate.yml — runs after your deploy job
name: SEO deploy gate
on:
  deployment_status:
jobs:
  seo-gate:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: >-
          node scripts/seo-gate.mjs --website ${site}
          --target "\${{ github.event.deployment_status.environment_url }}" --allow-noindex
        env:
          SEO_HUB_URL: ${appUrl}
          SEO_HUB_API_KEY: \${{ secrets.SEO_HUB_API_KEY }}`;
  const gitlab = `# .gitlab-ci.yml
seo-gate:
  stage: .post
  image: node:22
  script:
    - node scripts/seo-gate.mjs --website ${site} --target "$CI_ENVIRONMENT_URL" --allow-noindex
  variables:
    SEO_HUB_URL: ${appUrl}
    # SEO_HUB_API_KEY: set as a masked CI/CD variable`;
  const curl = `curl -X POST ${appUrl}/api/v1/gate \\
  -H "Authorization: Bearer $SEO_HUB_API_KEY" -H "Content-Type: application/json" \\
  -d '{"website_id":"${site}","target_base_url":"https://preview.example.com","allow_noindex":true}'
# → 202 {"id":"…","status_url":"${appUrl}/api/v1/gate/…"}  — poll until status is COMPLETED, then read "passed"`;

  return (
    <>
      <PageHeader title="API & CI/CD" description="Stop deploys that break SEO. The deploy gate fetches key pages after a deploy (or on a preview URL) and compares status codes, noindex, canonicals, titles, descriptions, H1, structured data and hreflang with each page's last known-good state from recent audits. A failing gate exits non-zero in CI and opens a critical alert." />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">API keys</h2>
          <div className="px-4 py-3"><ApiKeyManager keys={keys.map((k) => ({ ...k, usage: `created ${formatRelative(k.created_at)}${k.last_used_at ? ` · used ${formatRelative(k.last_used_at)}` : " · never used"}` }))} canManage={can(ctx.role, "integrations.manage")} /></div>
        </section>
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Run the gate from here</h2>
          <div className="px-4 py-3"><GateRunForm websites={websites} canRun={can(ctx.role, "seo.run")} /></div>
        </section>
      </div>

      <section className="mt-6 rounded-xl border bg-card">
        <h2 className="border-b px-4 py-3 text-sm font-semibold">Recent gate runs</h2>
        {runs.length ? (
          <ul className="divide-y text-sm" data-testid="gate-runs">
            {runs.map((r) => {
              const res = r.result;
              const name = websites.find((w) => w.id === r.website_id)?.name ?? "Website";
              return (
                <li key={r.id} className="px-4 py-2.5">
                  <details>
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      <ToneBadge tone={r.status !== "COMPLETED" ? (r.status === "FAILED" ? "danger" : "progress") : res.passed ? "success" : "danger"}>
                        {r.status === "COMPLETED" ? (res.passed ? "passed" : "failed") : r.status.toLowerCase()}
                      </ToneBadge>
                      <span className="font-medium">{name}</span>
                      <span className="text-muted-foreground">{res.target ?? (r.params.targetBaseUrl as string | undefined) ?? ""}</span>
                      {r.status === "COMPLETED" ? <span className="text-xs text-muted-foreground">{res.checked} pages · {res.errors} errors · {res.warnings} warnings</span> : <span className="text-xs text-muted-foreground">{r.progress ?? r.error_message ?? ""}</span>}
                      <span className="ml-auto text-xs text-muted-foreground">{res.source === "api" ? "CI/API" : "app"} · {formatRelative(r.created_at)}</span>
                    </summary>
                    {res.checks?.length ? (
                      <table className="mt-2 w-full text-xs">
                        <thead className="text-left text-muted-foreground"><tr><th className="py-1 pr-2">Severity</th><th className="py-1 pr-2">Path</th><th className="py-1 pr-2">Finding</th><th className="py-1 pr-2">Before</th><th className="py-1">Now</th></tr></thead>
                        <tbody className="divide-y">
                          {res.checks.map((c, i) => (
                            <tr key={i}><td className="py-1 pr-2"><ToneBadge tone={SEV[c.severity]}>{c.severity}</ToneBadge></td><td className="py-1 pr-2 font-mono">{c.path}</td><td className="py-1 pr-2">{c.message}</td><td className="max-w-48 truncate py-1 pr-2 text-muted-foreground">{c.before ?? "—"}</td><td className="max-w-48 truncate py-1 text-muted-foreground">{c.after ?? "—"}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    ) : r.status === "COMPLETED" ? <p className="mt-2 text-xs text-muted-foreground">No findings: every checked page matches the baseline.</p> : null}
                  </details>
                </li>
              );
            })}
          </ul>
        ) : <p className="px-4 py-6 text-sm text-muted-foreground">No gate runs yet.</p>}
      </section>

      <section className="mt-6 grid gap-6 lg:grid-cols-2">
        {[["GitHub Actions", github], ["GitLab CI", gitlab]].map(([title, code]) => (
          <div key={title} className="rounded-xl border bg-card">
            <h2 className="border-b px-4 py-3 text-sm font-semibold">{title}</h2>
            <pre className="overflow-x-auto px-4 py-3 text-xs"><code>{code}</code></pre>
          </div>
        ))}
        <div className="rounded-xl border bg-card lg:col-span-2">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">REST API</h2>
          <pre className="overflow-x-auto px-4 py-3 text-xs"><code>{curl}</code></pre>
          <p className="px-4 pb-3 text-xs text-muted-foreground"><code>scripts/seo-gate.mjs</code> (no dependencies) wraps this: it starts the run, waits, prints each finding and exits 1 when the gate fails, 0 when it passes, 2 when it cannot run.</p>
        </div>
      </section>
    </>
  );
}
