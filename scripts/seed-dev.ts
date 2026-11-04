/**
 * DEVELOPMENT SEED — creates a demo workspace with sample clients, websites, articles
 * and real job records produced by the actual pipeline against the local mock WordPress,
 * Webflow, Shopify and custom CMS servers.
 * Refuses to run unless APP_ENV=development and Supabase is on localhost.
 *
 *   npm run seed:dev   (start `npm run mock:wp` and `npm run mock:cms` first for the publishing samples)
 */
import { createClient } from "@supabase/supabase-js";
import { runWorkerBatch } from "../lib/publishing/processor";
import { createProcessorDeps } from "../lib/publishing/worker";
import { credentialAad, encryptSecret } from "../lib/security/crypto";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (process.env.APP_ENV !== "development" || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url)) {
  console.error("Refusing to seed: requires APP_ENV=development and a local Supabase URL.");
  process.exit(1);
}
const email = "demo@example.test";
const password = process.env.DEMO_USER_PASSWORD ?? "";
if (password.length < 10) {
  console.error("Set DEMO_USER_PASSWORD (10+ chars) in .env.local — `npm run setup:local` generates one.");
  process.exit(1);
}
const mockBase = `http://localhost:${process.env.MOCK_WP_PORT ?? 8787}`;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const userClient = createClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, { auth: { persistSession: false } });

const words = (topic: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${topic} insight ${i + 1} explains a practical step agencies can apply for clients.`).join(" ");

async function must<T>(p: PromiseLike<{ data: T; error: unknown } | { data: unknown; error: unknown }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as T;
}

async function main() {
  const existing = await admin.auth.admin.listUsers({ perPage: 200 });
  if (existing.data.users.some((u) => u.email === email)) {
    // Workspaces seeded before multi-CMS support get the new platform samples added once.
    await must(userClient.auth.signInWithPassword({ email, password }), "sign in");
    const org = await must(admin.from("organizations").select("id").eq("slug", "demo-agency").maybeSingle(), "org") as { id: string } | null;
    const has = org ? await must(admin.from("websites").select("id").eq("organization_id", org.id).neq("cms_type", "wordpress"), "sites") as unknown[] : [];
    if (org && !has.length) {
      const client = await must(admin.from("clients").select("id").eq("organization_id", org.id).order("created_at").limit(2), "clients") as { id: string }[];
      const user = existing.data.users.find((u) => u.email === email)!;
      await seedOtherPlatforms(org.id, client.at(-1)!.id, user.id);
      console.log("Added Webflow, Shopify and custom CMS samples to the existing demo workspace.");
    } else {
      console.log(`Demo user ${email} already exists — nothing to do. Reset with: npx supabase db reset`);
    }
    return;
  }
  const created = await must<{ user: { id: string } | null }>(admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Demo Owner" } }), "create user");
  const userId = created.user!.id;
  await must(userClient.auth.signInWithPassword({ email, password }), "sign in");

  const orgId = await must(userClient.rpc("create_organization", { p_name: "Demo Agency", p_slug: "demo-agency" }), "create org") as string;
  const [acme, northwind] = await must(userClient.from("clients").insert([
    { organization_id: orgId, name: "Acme Dental (demo)", notes: "Sample client created by the development seed." },
    { organization_id: orgId, name: "Northwind Outdoors (demo)" },
  ]).select("id"), "clients") as { id: string }[];
  const [blog, journal] = await must(userClient.from("websites").insert([
    { organization_id: orgId, client_id: acme.id, name: "Demo Blog", base_url: mockBase, timezone: "Europe/London", publishing_settings: { max_concurrency: 1, min_request_interval_ms: 100 } },
    { organization_id: orgId, client_id: northwind.id, name: "Northwind Journal", base_url: "https://northwind.example.com", timezone: "America/New_York", publishing_settings: { max_concurrency: 1 } },
  ]).select("id"), "websites") as { id: string }[];
  void journal;

  let mockUp = false;
  try {
    mockUp = (await fetch(`${mockBase}/wp-json/`)).ok;
  } catch { /* not running */ }
  const creds = { username: process.env.MOCK_WP_USER ?? "demo-editor", applicationPassword: process.env.MOCK_WP_APP_PASSWORD ?? "" };
  await must(admin.from("cms_connections").insert({
    organization_id: orgId, website_id: blog.id, encrypted_credentials: encryptSecret(JSON.stringify(creds), credentialAad(orgId, blog.id)),
    connection_status: mockUp ? "connected" : "error", last_tested_at: new Date().toISOString(),
    metadata: { username: creds.username, site_name: "Mock WordPress (development)", seo_plugins: ["yoast"], wp_user: creds.username },
    last_error: mockUp ? null : "Mock WordPress was not running when the seed ran.",
  }), "connection");
  await must(admin.from("websites").update({ connection_status: mockUp ? "connected" : "error" }).eq("id", blog.id), "website status");

  const articles = [
    { title: "Local SEO checklist for dental practices", slug: "local-seo-checklist-dentists", meta_title: "Local SEO checklist for dental practices in 2026", meta_description: "A practical local SEO checklist for dental practices: business profiles, reviews, location pages and tracking what matters.", target_keyword: "local seo", body: `Local SEO helps dental practices appear when nearby patients search.\n\n## Claim your business profile\n\n${words("Local SEO", 40)}\n\n## Build location pages\n\n${words("Location page", 20)}` },
    { title: "How to choose hiking boots", slug: "choose-hiking-boots", meta_title: "", meta_description: "Too short", target_keyword: "hiking boots", body: `# How to choose hiking boots\n\nShort intro.\n\n#### Fit\n\n<img src="https://example.com/boot.jpg">\n\n[broken](javascript:void(0))` },
    { title: "Teeth whitening myths, explained", slug: "teeth-whitening-myths", meta_title: "Teeth whitening myths explained by dentists", meta_description: "We separate teeth whitening facts from myths so patients can make informed, safe choices about their smile.", target_keyword: "teeth whitening", body: `Teeth whitening is one of the most requested treatments.\n\n## Myth: it damages enamel\n\n${words("Whitening", 40)}` },
    { title: "Draft: winter camping gear list", slug: "winter-camping-gear", meta_title: "", meta_description: "", target_keyword: "", body: "Notes to expand later." },
  ];
  const ids = await must(userClient.from("content_items").insert(articles.map((a) => ({
    ...a, organization_id: orgId, website_id: blog.id, created_by: userId,
  }))).select("id"), "content") as { id: string }[];

  // Validate the first three through the real pipeline.
  for (const { id } of ids.slice(0, 3)) {
    await must(userClient.rpc("enqueue_content_job", { p_content: id, p_job_type: "VALIDATE", p_request_key: `seed-validate-${id}` }), "enqueue validate");
  }
  const deps = createProcessorDeps("seed");
  await runWorkerBatch(deps, { maxJobs: 10, organizationId: orgId });

  // Approve + publish the first article; approve the third and schedule it.
  await must(userClient.rpc("approve_content", { p_content: ids[0].id }), "approve");
  await must(userClient.rpc("approve_content", { p_content: ids[2].id }), "approve 2");
  if (mockUp) {
    await must(userClient.rpc("enqueue_content_job", { p_content: ids[0].id, p_job_type: "PUBLISH", p_request_key: "seed-publish-1" }), "publish");
    await runWorkerBatch(deps, { maxJobs: 5, organizationId: orgId });
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    await must(userClient.from("content_items").update({ scheduled_at: at }).eq("id", ids[2].id), "schedule");
    await must(userClient.rpc("enqueue_content_job", { p_content: ids[2].id, p_job_type: "PUBLISH", p_request_key: "seed-publish-2", p_run_at: at }), "schedule publish");
  }
  await seedOtherPlatforms(orgId, northwind.id, userId);
  console.log(`Seeded demo workspace for ${email} (password: DEMO_USER_PASSWORD in .env.local).${mockUp ? "" : " Mock WordPress was not running, so no publishing samples were created."}`);
}

/** One connected website per non-WordPress platform, each with an article published through the real pipeline. */
async function seedOtherPlatforms(orgId: string, clientId: string, userId: string) {
  const port = (name: string, d: number) => Number(process.env[name] ?? d);
  const sites = [
    {
      name: "Northwind Webflow site", cms_type: "webflow", connection_type: "webflow_api_token", base_url: `http://localhost:${port("MOCK_WEBFLOW_PORT", 8788)}`,
      creds: { kind: "webflow", apiToken: process.env.MOCK_WEBFLOW_TOKEN ?? "", collectionId: "65f0c0ffee0000000000b10b" },
      metadata: { username: "collection 65f0c0ffee0000000000b10b", site_name: "Blog Posts", wp_user: "Webflow API token", seo_plugins: ["meta title field", "meta description field"] },
    },
    {
      name: "Northwind Shopify store", cms_type: "shopify", connection_type: "shopify_admin_token", base_url: `http://localhost:${port("MOCK_SHOPIFY_PORT", 8789)}`,
      creds: { kind: "shopify", shopDomain: "mock-store.myshopify.com", accessToken: process.env.MOCK_SHOPIFY_TOKEN ?? "", blogHandle: "news", authorName: "Northwind Editorial" },
      metadata: { username: "mock-store.myshopify.com", site_name: "Mock Shopify store (development)", wp_user: "Custom app (Admin API)", seo_plugins: ["shopify seo title", "shopify seo description"] },
    },
    {
      name: "Northwind custom CMS", cms_type: "custom", connection_type: "custom_bearer_token", base_url: `http://localhost:${port("MOCK_CUSTOM_PORT", 8790)}`,
      creds: { kind: "custom", apiBaseUrl: `http://localhost:${port("MOCK_CUSTOM_PORT", 8790)}/api/v1`, apiToken: process.env.MOCK_CUSTOM_TOKEN ?? "" },
      metadata: { username: `localhost:${port("MOCK_CUSTOM_PORT", 8790)}`, site_name: "Mock Custom CMS (development)", wp_user: "SEO Hub service account", seo_plugins: ["meta_title", "meta_description", "canonical_url"] },
    },
  ];
  const deps = createProcessorDeps("seed");
  for (const site of sites) {
    let up = false;
    try {
      up = (await fetch(`${site.base_url}/`)).status === 404; // mocks answer 404 on "/"
    } catch { /* not running */ }
    const row = await must(userClient.from("websites").insert({
      organization_id: orgId, client_id: clientId, name: site.name, base_url: site.base_url, cms_type: site.cms_type, timezone: "UTC",
      publishing_settings: { max_concurrency: 1, min_request_interval_ms: 100 },
    }).select("id").single(), `website ${site.cms_type}`) as { id: string };
    await must(admin.from("cms_connections").insert({
      organization_id: orgId, website_id: row.id, connection_type: site.connection_type,
      encrypted_credentials: encryptSecret(JSON.stringify(site.creds), credentialAad(orgId, row.id)),
      connection_status: up ? "connected" : "error", last_tested_at: new Date().toISOString(), metadata: site.metadata,
      last_error: up ? null : "The mock CMS was not running when the seed ran.",
    }), `connection ${site.cms_type}`);
    await must(admin.from("websites").update({ connection_status: up ? "connected" : "error" }).eq("id", row.id), "website status");
    const item = await must(userClient.from("content_items").insert({
      organization_id: orgId, website_id: row.id, created_by: userId,
      title: `Trail running shoes guide (${site.cms_type})`, slug: `trail-running-shoes-${site.cms_type}`, target_keyword: "trail running shoes",
      meta_title: "Trail running shoes: how to choose the right pair",
      meta_description: "How to choose trail running shoes: grip, drop, cushioning and fit, with advice for muddy, rocky and mixed terrain.",
      body: `Trail running shoes differ from road shoes in grip, protection and fit.\n\n## Grip and lugs\n\n${words("Trail shoe", 40)}`,
    }).select("id").single(), "content") as { id: string };
    if (!up) continue;
    await must(userClient.rpc("enqueue_content_job", { p_content: item.id, p_job_type: "VALIDATE", p_request_key: `seed-validate-${item.id}` }), "validate");
    await runWorkerBatch(deps, { maxJobs: 2, organizationId: orgId });
    // The background worker may have picked the job up instead; wait for the result.
    for (let i = 0; i < 20; i++) {
      const c = await must(admin.from("content_items").select("status").eq("id", item.id).single(), "status") as { status: string };
      if (c.status !== "DRAFT" && c.status !== "VALIDATING") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await must(userClient.rpc("approve_content", { p_content: item.id }), "approve");
    await must(userClient.rpc("enqueue_content_job", { p_content: item.id, p_job_type: "PUBLISH", p_request_key: `seed-publish-${item.id}` }), "publish");
    await runWorkerBatch(deps, { maxJobs: 2, organizationId: orgId });
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
