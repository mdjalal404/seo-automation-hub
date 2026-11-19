#!/usr/bin/env node
/**
 * SEO deploy gate for CI/CD. Starts a gate run on SEO Automation Hub, waits for it, prints the
 * findings and exits 1 if the gate failed (so the pipeline stops), 0 if it passed, 2 on errors.
 *
 *   SEO_HUB_URL=https://hub.example.com SEO_HUB_API_KEY=seoh_… \
 *   node scripts/seo-gate.mjs --website <id> [--target https://preview.example.com] \
 *        [--paths /,/pricing] [--max-urls 20] [--fail-on error|warning] [--allow-noindex] [--timeout 600]
 *
 * No dependencies (Node 18+). Copy this file into any repository.
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const hub = (process.env.SEO_HUB_URL ?? "").replace(/\/$/, "");
const key = process.env.SEO_HUB_API_KEY ?? "";
const website = opt("website", process.env.SEO_HUB_WEBSITE_ID);
if (!hub || !key || !website) {
  console.error("Set SEO_HUB_URL and SEO_HUB_API_KEY, and pass --website <id> (or SEO_HUB_WEBSITE_ID).");
  process.exit(2);
}
const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };
const body = {
  website_id: website,
  target_base_url: opt("target", process.env.SEO_GATE_TARGET) || undefined,
  paths: opt("paths")?.split(",").map((p) => p.trim()).filter(Boolean),
  max_urls: Number(opt("max-urls", 20)),
  fail_on: opt("fail-on", "error"),
  allow_noindex: flag("allow-noindex"),
};
const timeoutMs = Number(opt("timeout", 600)) * 1000;

async function call(url, init) {
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${json.error ?? res.statusText}`);
  return json;
}

try {
  const start = await call(`${hub}/api/v1/gate`, { method: "POST", headers, body: JSON.stringify(body) });
  console.log(`SEO gate ${start.id} queued${body.target_base_url ? ` for ${body.target_base_url}` : ""}…`);
  const deadline = Date.now() + timeoutMs;
  let run;
  for (;;) {
    run = await call(start.status_url, { headers });
    if (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED") break;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs / 1000}s (status ${run.status}).`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (run.status !== "COMPLETED") throw new Error(`Gate run ${run.status.toLowerCase()}: ${run.error ?? "unknown error"}`);

  const icon = { error: "✖", warning: "▲", info: "·" };
  for (const c of run.checks) {
    const change = c.before || c.after ? `  (${c.before ?? "—"} → ${c.after ?? "—"})` : "";
    console.log(`${icon[c.severity]} ${c.severity.padEnd(7)} ${c.path.padEnd(40)} ${c.message}${change}`);
  }
  console.log(`\n${run.passed ? "PASSED" : "FAILED"}: ${run.checked} pages on ${run.target} · ${run.errors} errors · ${run.warnings} warnings (fail on ${run.fail_on})`);
  process.exit(run.passed ? 0 : 1);
} catch (err) {
  console.error(`SEO gate could not run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
}
