# SEO Automation Hub

A multi-tenant SaaS for SEO agencies: manage clients and their WordPress, Webflow, Shopify or custom-CMS sites, validate content against configurable SEO rules, approve it, publish it through a persistent background job queue, and verify the live page afterwards.

**Status:** pilot-ready MVP. Everything below was run locally against a local Supabase and **mock** WordPress, Webflow, Shopify and custom-CMS servers. Publishing to a real site on any platform has not been verified from this repository yet (see [Connect real sites](#connect-a-real-wordpress-site)).

## Stack

Next.js 16 (App Router, server actions, `proxy.ts`) · React 19 · TypeScript strict · Tailwind CSS 4 · shadcn/ui (Base UI) · React Hook Form + Zod · Supabase (Postgres, Auth, RLS) · Vitest + PGlite · Playwright.

## Architecture

```
app/                 routes: (auth) login/signup, onboarding, (app)/dashboard, clients, websites,
                     content, content-queue, job-history, automation-rules, reports, settings;
                     api/cron/process-jobs, api/health; app/actions/* (server actions)
components/          ui/ (shadcn), layout/, common/, content/, jobs/, websites/
lib/
  auth/              permissions matrix, session + workspace resolution
  security/          crypto (AES-256-GCM), url policy, safe-fetch (SSRF), rate-limit
  seo/               check registry, rules, engine, live-page verification
  cms/               adapter interface, registry, platform metadata, credentials, shared JSON transport;
                     adapters/ for Webflow, Shopify and the custom CMS contract
  wordpress/         WordPress REST adapter, SEO-plugin meta adapters
  publishing/        job processor, repository interface, Supabase repository, worker wiring
  jobs/ content/     job + content state machines, retry classification
  services/          business logic used by server actions (clients, websites, content, jobs, …)
  csv/ reporting/ scheduling/ validation/
scripts/             worker, mock WordPress + mock CMS servers, local env setup, dev seed
dev/mock-wordpress/  DEVELOPMENT/TEST-only WordPress imitation
dev/mock-cms/        DEVELOPMENT/TEST-only Webflow, Shopify and custom-CMS imitations
supabase/migrations/ schema, RLS, workflow RPCs
tests/               db/ (RLS), unit/, integration/, e2e/
```

Key decisions:

- **Authorization is enforced three times:** server actions check the role matrix, Postgres RLS and column grants restrict every query, and workflow RPCs (`approve_content`, `enqueue_content_job`, `cancel_job`, `retry_job`, …) re-check `auth.uid()`. The UI only hides what you cannot do.
- **Persistent job queue in Postgres instead of Trigger.dev.** Trigger.dev needs an external account; the queue (`content_jobs` + `claim_next_job` with leases, advisory-locked per-website concurrency, idempotency keys and lease reaping) survives restarts, needs no extra infrastructure and is fully testable. The processor (`lib/publishing/processor.ts`) is independent of the runner, so a Trigger.dev task could call `processJob` later.
- **Approval is bound to a content hash** computed by a database trigger; material edits withdraw approval and invalidate validation automatically.
- **CMS adapter interface** (`lib/cms/types.ts`) implemented for WordPress, Webflow, Shopify and a documented custom REST contract. The job processor, verification, retries and reconciliation are shared; adapters only translate to each platform's API and normalize post status to `draft` / `pending` / `publish`.

## Database

Migrations in `supabase/migrations/`:

| Migration | Contents |
| --- | --- |
| `…000000_core_schema.sql` | `profiles`, `organizations`, `memberships`, `clients`, `websites`, `cms_connections`, `content_items`, `content_jobs`, `qa_results`, `automation_rules`, `audit_logs`, `rate_limits`; enums; indexes; composite tenant FKs; content state-machine + hash trigger; RLS policies; column-level grants |
| `…000100_workflow_functions.sql` | workspace/member RPCs, approval, job enqueue/cancel/retry, `claim_next_job`, `reap_expired_leases`, `check_rate_limit` |
| `…000200_claim_specific_job.sql` | `claim_job` (run one validation inline through the same job record) |
| `…000300_multi_cms.sql` | `websites.cms_type` ∈ wordpress/webflow/shopify/custom; matching `cms_connections.connection_type` enforced by trigger; platform cannot change while connected; `retry_job` accepts `CMS_AUTH_FAILED` |
| `20261119000000_monitoring_indexnow_gate.sql` | `seo_alerts` (one open alert per fingerprint), `api_keys` (hash not readable by clients), `INDEXNOW_SUBMIT` / `SEO_GATE` tasks, Slack / webhook / IndexNow integrations |

All timestamps are UTC. Scheduled times are entered in the website's IANA timezone and converted with DST handling (`lib/scheduling/timezone.ts`).

## WordPress integration

- Connect with **site URL + username + application password** (never the login password). The UI explains how to create one. Credentials are tested before they are stored, then encrypted.
- Adapter (`lib/wordpress/adapter.ts`): `testConnection`, `getPosts`, `getPost`, `findPostBySlug`, `createDraft`, `updateDraft`, `publishPost`, `schedulePost`; live-page verification is in `lib/seo/verification.ts`. Supports title, body (Markdown rendered to HTML, or HTML), excerpt, slug, category/tag IDs, featured media ID, draft and scheduled (`future`) status, `?rest_route=` sites.
- Errors are classified: 401 → credentials rejected (connection marked `auth_failed`, no retry); 403/400/404 → permanent; 429 → retry after `Retry-After`; 5xx/timeouts → retry with backoff, writes treated as ambiguous and reconciled first.
- **SEO plugin metadata** (Yoast, Rank Math): WordPress core does not expose plugin fields over REST. The app writes them only if the site's REST `meta` object exposes the keys, and reports per field: *stored here → sent → confirmed by the API → verified on the live page*. To enable writing, register the keys on the WordPress site, e.g. in a small must-use plugin:

  ```php
  <?php // wp-content/mu-plugins/seo-rest-meta.php
  foreach (['_yoast_wpseo_title','_yoast_wpseo_metadesc','_yoast_wpseo_canonical'] as $key) {
    register_post_meta('post', $key, [
      'show_in_rest' => true, 'single' => true, 'type' => 'string',
      'auth_callback' => fn() => current_user_can('edit_posts'),
    ]);
  }
  ```
  (Rank Math keys: `rank_math_title`, `rank_math_description`, `rank_math_canonical_url`.)

## Webflow, Shopify and custom CMS integrations

Pick the platform when adding a website. Every platform uses the same workflow (validate → approve → queue → reconcile → draft → publish → verify live page), the same retry and backoff rules, and the same per-field SEO status (*stored → sent → confirmed → verified*). Credentials are tested before they are stored. The whole credential object, including where the token may be sent (the shop domain or API base URL), is encrypted and bound to the website.

| | Webflow | Shopify | Custom CMS |
| --- | --- | --- | --- |
| API | Data API v2 (`api.webflow.com/v2`) | GraphQL Admin API `2025-10` (`<shop>.myshopify.com`) | [Custom CMS API v1](docs/CUSTOM_CMS.md) (any HTTPS base URL) |
| Credentials | Site API token (CMS read + write) + collection ID | Custom-app Admin API token (`read_content`, `write_content`) + blog handle | Bearer token + API base URL |
| Publishes | Items of one CMS collection: created with `isDraft`, then `POST /collections/{id}/items/publish` | Blog articles: created unpublished, then `isPublished: true` | Posts: `POST /posts`, then `POST /posts/{id}/publish` |
| Body / excerpt | Mapped Rich Text field / summary field | `body` / `summary` | `content_html` / `excerpt` |
| Meta title / description | Mapped collection fields (auto-detected `seo-title` / `seo-description`, or set when connecting). They only reach the page if the template's SEO settings bind them. | Built-in SEO metafields `global.title_tag` / `global.description_tag` | `seo.meta_title` / `seo.meta_description`, if listed in `capabilities.seo_fields` |
| Canonical URL | Only if a canonical field is mapped | Not supported (Shopify sets canonicals itself); shown as *not sent* | `seo.canonical_url`, if listed in `capabilities.seo_fields` |
| Live URL | `<website address>/<collection slug>/<item slug>` | `<storefront address>/blogs/<blog handle>/<article handle>` | `url` returned by the API |
| Errors | 401 → `CMS_AUTH_FAILED` (connection marked `auth_failed`, manual retry after reconnecting) · 403/4xx → permanent · 429 → retry after `Retry-After` · 5xx/timeouts → retry, with writes reconciled first | Same as Webflow, plus GraphQL `THROTTLED` → retry, `ACCESS_DENIED` → permanent, `userErrors` → permanent (a taken handle → conflict) | Same as Webflow |

Notes:

- **Webflow** sends requests at least 1.1 seconds apart (Webflow's API allows about 60 requests per minute). The site must have been published once in the Designer before items can be published through the API. Edits to a live item are staged until it is published again, so the processor always calls publish after an update.
- **Shopify** finds articles by handle using fuzzy search, then keeps only exact handle matches. The *Website address* is the storefront domain; the connection uses the store's `myshopify.com` domain.
- **Custom CMS** requests go through the same SSRF-guarded client as WordPress: HTTPS only, no private networks, and no redirects on writes.

## SEO validation checks

Pre-publish (each configurable per workspace or website: enabled, severity, thresholds): title present · meta description present · title length · meta description length · slug present/well-formed · H1 policy (none in body / exactly one / any) · heading structure (min H2, no skipped levels, empty headings) · content not empty · minimum word count · image alt attributes · malformed/unsafe URLs · duplicate slug on website · duplicate title on website · internal-link destinations (HTTP, bounded, concurrency 3) · JSON-LD syntax · canonical syntax/host consistency · target-keyword usage.

**AI-written content (estimate).** Each validation estimates what share of the text reads as AI-generated. The result appears in three places: as a warning alongside the other validation warnings (with a meter and the most AI-like passages to rewrite), as a badge in the article header (for example "AI-written · 52%", or "AI 8%" when below the limit), and in `qa_results.details`. The warning appears at 40% by default; you can change this under *Automation rules* ("Warn at AI %"), make the check an error so it blocks approval, or turn it off. Articles under 80 words are skipped.
- The **built-in heuristic** (`lib/seo/ai-detection.ts`) runs locally and never sends text anywhere. It combines two levels of signals:
  - **Whole document:** a style profile — no contractions, impersonal "you"-addressed copy, frequent "X, Y, and Z" lists, generic marketing vocabulary ("journey", "rewarding", "essential", "enriching"…), even sentence pacing, few concrete numbers, and a "Conclusion" or "Final thoughts" heading.
  - **Each sentence:** stock phrases and templates ("Whether you are…", "not only… but also", "plays a crucial role"), with personal voice (I/my, contractions, questions) lowering the score.

  The percentage is the share of words in flagged sentences. In calibration, ChatGPT-style service pages and blog posts scored 80–100%, and human-written prose (a personal account and open-source documentation) scored 0–12%. Lightly edited, conversational AI text can still score around 30–50%. It is English-only and **an estimate, not proof of authorship**; human copy written to a formulaic SEO template can score high.
- **Optional:** set `AI_DETECTION_PROVIDER=sapling` and `SAPLING_API_KEY` to use Sapling's detector. This sends the article text to Sapling during full validation. If the call fails, or during the quick offline re-check before publishing, the built-in heuristic is used instead and labelled as such. The Sapling integration was built from its public docs and has not been called with a real key from this repository.

Post-publish: live page accessible (HTTP 200) · indexable (no `noindex`) · published title · published content (sampled passages) · rendered meta title/description/canonical (when confirmed saved).

Checks are labelled *technical check* or *configurable recommendation*. Only `error` severity blocks approval (optionally warnings too). Add a check by implementing `SeoCheck` and calling `registerCheck`.

## SEO automation (AI, technical, programmatic, analytics)

All of this runs as background **tasks** (`automation_tasks`, separate from the publishing queue) that the worker claims with `SKIP LOCKED` and leases. They are either read-only towards external services or idempotent, so a failed or interrupted task can be retried safely. **Nothing here publishes on its own:** generated and template pages are drafts that go through validation and human approval like any other article.

| Feature | Where | What it does |
| --- | --- | --- |
| AI content pipeline | *AI studio* | Three Claude calls: **brief** (intent, outline, questions, entities), then **draft** (answer-first Markdown, FAQ, meta title/description, links to your published pages), then **quality review** (scores, claims a human must verify, issues). Saved as a draft flagged "AI draft", with the report on the article page. Tokens per step are recorded in `ai_runs`. |
| Keyword research & clustering | *Keywords* | Paste lists or import Search Console queries automatically on each sync. Intent is classified by rules. Clustering uses shared Google top-10 URLs when rank checks have run, otherwise word similarity. Any cluster can be turned into an AI draft. |
| Rank & AI Overview tracking | *Keywords*, autopilot | Uses DataForSEO for search volume, live Google position, top-10 URLs and whether a Google AI Overview cites the site. |
| AI visibility | Article page, *Keywords*, autopilot | **Readiness score** (validation check `ai_visibility`, a warning below 60 by default): answer up front, question headings, FAQ, lists/tables, specific facts, external citations, short paragraphs, structured data, depth. **Citation checks:** Claude answers the query with live web search, and the app records whether your domain is cited or mentioned. Google AI Overview citations come from DataForSEO. ChatGPT and Perplexity are not queried directly. |
| Internal linking | Article page | Suggests unlinked phrases matching your published articles, mapped cluster URLs and pages from the latest audit, ranked by TF-IDF similarity. "Add link" inserts the link into the body outside headings, code and existing links, which withdraws approval as with any edit. |
| JSON-LD generator | Article page | Article/BlogPosting, FAQPage and HowTo (both extracted from the visible article), BreadcrumbList, Organization, LocalBusiness and Product, with required-property validation. Stored on the article, with a copy button for the `<script>`. It is **not** injected into the CMS automatically. |
| Technical audits | *Site audits*, autopilot | Crawls the site breadth-first (same host, robots.txt respected, polite spacing, up to 500 pages). Covers status codes, redirects, broken internal links, titles, descriptions, H1, thin content, noindex, canonicals, alt text, mixed content, JSON-LD validity, orphan pages, sitemap coverage and click depth. Site-level checks cover robots.txt, sitemaps, llms.txt and per-agent access for GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended and others. Core Web Vitals come from PageSpeed Insights when connected. Indexation comes from Search Console URL Inspection for the 10 most-linked pages when connected. **Export** from the report: a client-ready PDF report, pages (CSV), issues as a fix list sorted by severity (CSV), or the full report (JSON) via `/api/audits/<id>/export?format=pdf|pages|issues|json`. |
| Programmatic pages | *Page templates* | A template with `{{column}}`, filters (`|title`, `|slug`…) and `{{#if}}` blocks, plus a CSV/JSON feed of up to 500 rows. The preview flags missing columns, duplicate or existing slugs, and thin pages where less than 25% of the body comes from the row's own data. Each valid row then becomes a draft. |
| Analytics | *Analytics* | Search Console clicks, impressions, CTR and position (daily, query × page); GA4 organic landing pages; Clarity rage/dead clicks and scroll depth; Similarweb monthly visits. Opportunities are detected automatically: striking distance (positions 8–20), low CTR versus position, cannibalization, and content decay (−30% over 28 days). CSV export is included. |
| SEO agent | *SEO agent* | Claude tool-use loop (SDK tool runner). Eight tools: site overview, Search Console, opportunity detection, audit issues, keywords, content, live page inspection, `propose_action`. It **only files proposals**. An owner or admin approves them: approval queues an AI draft, applies a meta rewrite or link to a tracked article, or adds a to-do. Each run is limited to 20 steps and 15 proposals, scoped to one website, and stores every tool call. |
| Crawl budget & logs | *Crawl budget & logs* | Upload Apache/Nginx logs (plain or `.gz`, up to 200 MB). Shows Googlebot requests by section, status and day, crawl waste (redirects, errors, parameter URLs), the most-crawled parameters, indexable pages never crawled, and AI-bot activity. The audit adds parameter-URL, sitemap-hygiene and **hreflang** checks. |
| Content QA at scale | *Content QA* | LLM rubric plus deterministic signals. The verdict comes from fixed thresholds in code; unchanged content is skipped. |
| Impact | *Analytics* | Search Console clicks and position compared 28 days before and after each publish or applied proposal. |
| Warehouse export | *Integrations & autopilot* | Databricks SQL Statement Execution API: idempotent loads into Delta tables, all values sent as parameters. |
| Monitoring & alerts | *Monitoring & alerts* | Each audit is compared with the previous one: pages that broke, redirect or became noindex; canonical, title, description, H1, structured-data and content changes; new error-level issues; robots.txt, sitemap and AI-crawler changes; score drops. Each Search Console sync checks the last 7 days against the 28 before (site clicks with a z-score test, page clicks, ranking drops). Alerts carry before/after evidence, are de-duplicated by fingerprint, and **close themselves** when a later check finds the problem fixed. New alerts go to **Slack** (incoming webhook) and/or a **signed webhook** (`X-SEOHub-Signature: sha256=HMAC(secret, timestamp.body)`), filtered by severity. |
| IndexNow | *Monitoring & alerts*, *Integrations* | After every verified publish, and for pages an audit finds changed, URLs are submitted to IndexNow (Bing, Yandex, Seznam, Naver). Google does not use IndexNow. The key file is verified on the site when connecting; URLs can also be submitted by hand. |
| SEO deploy gate (CI/CD) | *API & CI/CD* | `POST /api/v1/gate` with an API key (only a SHA-256 hash is stored) fetches key pages on the live site or a preview URL and compares them with each page's **last known-good** state across the last 5 audits: status, noindex, canonical, title, description, H1, JSON-LD and hreflang. `scripts/seo-gate.mjs` (no dependencies) runs it from GitHub Actions or GitLab CI and exits 1 when the gate fails. A failed gate opens a critical alert; a later passing run closes it. |
| Autopilot | *Integrations & autopilot* | Daily/weekly/monthly schedules for analytics sync, audits, rank checks and AI-visibility checks (`enqueue_due_schedules()`, run by the worker and the cron route). |

**Configuration.** Set `ANTHROPIC_API_KEY` (server-only) for the AI features. The model defaults to `claude-opus-5-5` (override with `ANTHROPIC_MODEL`), with the server-side refusal fallback enabled. Integrations are connected per website in the UI:
- **Search Console and GA4** use a Google service-account JSON key; add the account's email to the property.
- **Clarity, DataForSEO, Similarweb and PageSpeed** use API keys.

Credentials are tested against the provider before being stored with AES-256-GCM (associated data `integration:<org>:<website>:<provider>`), and are readable only by the service role.

**More sources.** Mixpanel conversions by landing page, using a service account, are stored as `traffic_daily` source `mixpanel`. DataForSEO rank checks can cover up to 5 extra markets (`UK:2826:en, DE:2276:de`).

**Python toolkit** (`python/`): `pip install -e python` provides two commands:
- `seo-toolkit logs access.log.gz --verify-dns --sitemap-urls urls.txt` analyzes multi-GB logs and verifies Googlebot by reverse and forward DNS.
- `seo-toolkit opportunities --website <id>` exports a CSV from Postgres (needs `[db]` and `DATABASE_URL`).

**CI:** `.gitlab-ci.yml` and `.github/workflows/ci.yml` run lint, typecheck, tests, Python tests and the production build.

[docs/CAPABILITIES.md](docs/CAPABILITIES.md) maps these features to typical SEO-automation requirements.

**SQL / BI.** Synced data lives in `search_performance_daily`, `traffic_daily`, `keywords`, `ai_visibility_checks` and the `v_page_performance` view (RLS applies). Connect any SQL client or BI tool to Postgres, or use the CSV export at `/api/analytics/export`.

**Serverless note.** The cron route gives tasks about 20 s per invocation, so crawls stop early and are marked *partial*. Run `npm run worker` on an always-on host for full audits, large syncs and AI generation (1–3 minutes per article).

**Development mocks.** `npm run mock:analytics` (started by `npm run dev:all`) serves the following, all clearly labelled and refused when `APP_ENV=production`:
- synthetic Google (token endpoint with real JWT signature checks, Search Console, URL Inspection, GA4, PageSpeed), Clarity, DataForSEO and Similarweb APIs on `:8791`;
- a demo site with deliberate SEO issues on `:8792`;
- `LLM_PROVIDER=mock` for sample AI output that is labelled as such.

To try it, add a website `http://localhost:8792` and connect integrations with the values in `.env.local`. The Google key file is `dev/.mock-google-service-account.json` and the GA4 property is `123456789`.

**Not verified here.** No call has been made with real credentials to Anthropic, Google, Clarity, DataForSEO, Similarweb or PageSpeed. The clients follow each vendor's public API documentation and were tested against the mocks above. In particular, Similarweb's `api-key` header authentication and Clarity's response field names should be confirmed against a real account.

## Background jobs

Job states `QUEUED → VALIDATING → PUBLISHING → VERIFYING → COMPLETED`, plus `FAILED`, `CANCELLED`, `RETRY_SCHEDULED`. Publishing: re-check approval hash and run offline validation → reconcile with the CMS (stored post ID, then slug + matching title) → create draft and **persist the post ID** → publish → fetch and verify the live page. Retries: bounded exponential backoff (30 s … 30 min, jitter), max 5 attempts, never for permanent errors. A failed verification ends in `VERIFICATION_FAILED` for investigation; retrying it re-verifies without re-publishing. Per-website concurrency (default 1), per-request spacing, request timeouts, worker leases (crashed workers' jobs are reaped and reconciled).

Runners:
- `npm run worker` — long-running poller (any Node host, container, VM).
- `GET /api/cron/process-jobs` with `Authorization: Bearer $CRON_SECRET` — processes a ~45 s batch; `vercel.json` schedules it every minute.
- "Process due jobs now" on the queue page (owner/admin, own workspace only).

## Run locally

Prerequisites: Node 20.9+ (tested on 24), Docker Desktop running.

```bash
npm install
```
```bash
npx supabase start
```
```bash
npm run setup:local
```
```bash
npm run dev:all
```

`setup:local` writes `.env.local` from `supabase status` and generates the encryption key, the cron secret, the mock credentials and the demo password. If `.env.local` already exists, it only adds missing settings. `dev:all` starts Next.js (http://localhost:3000), the worker, the mock WordPress (http://localhost:8787) and the mock Webflow, Shopify and custom CMS servers (http://localhost:8788, :8789, :8790). Sign up at `/signup` (local Supabase does not require email confirmation).

Optional demo data (development only; refuses to run unless `APP_ENV=development` with local Supabase):

```bash
npm run seed:dev
```

Sign in as `demo@example.test` with `DEMO_USER_PASSWORD` from `.env.local`. The demo workspace includes a connected site on each platform, with one article published through the real pipeline. Re-running the seed on a workspace created before multi-CMS support adds those sites. To reset the database: `npm run db:reset`.

### Connect the mock WordPress (simulated)

Add a website with address `http://localhost:8787`, then connect with `MOCK_WP_USER` / `MOCK_WP_APP_PASSWORD` from `.env.local`. The site is labelled **Development target**; it only works because `ALLOW_PRIVATE_NETWORK_TARGETS=true`, which is ignored when `APP_ENV=production`. Fault injection: `POST http://localhost:8787/__mock/faults|mode|reset` (see `scripts/mock-wordpress.ts`).

### Connect the mock Webflow, Shopify and custom CMS (simulated)

These are development-only mocks (`scripts/mock-cms.ts`). Publishing to them is simulated. In development, `WEBFLOW_API_BASE_URL` and `SHOPIFY_ADMIN_BASE_URL` send the adapters to the mocks; both are ignored when `APP_ENV=production`.

- **Webflow:** address `http://localhost:8788`, token `MOCK_WEBFLOW_TOKEN`, collection ID `65f0c0ffee0000000000b10b`.
- **Shopify:** address `http://localhost:8789`, shop domain `mock-store.myshopify.com` (any `*.myshopify.com` works), token `MOCK_SHOPIFY_TOKEN`, blog `news`.
- **Custom CMS:** address `http://localhost:8790`, API base URL `http://localhost:8790/api/v1`, token `MOCK_CUSTOM_TOKEN`.

Each mock accepts `POST /__mock/reset`, `/__mock/faults` and `/__mock/mode` (`{"breakRendering":true}`).

### Connect a real WordPress site

1. Use a **staging** site first, served over HTTPS, WordPress 5.6+.
2. Create a dedicated user with the Author or Editor role; under *Users → Profile → Application Passwords* create a password named "SEO Automation Hub".
3. In the app: *Websites → Add website* with the public `https://` address, then paste the username and application password and click *Test and connect*.
4. Optional: register SEO plugin meta keys (above) so meta fields can be saved.
5. Create an article, validate, approve and publish; check *Live page verification* and *SEO metadata status*.
6. To revoke: *Disconnect* in the app **and** delete the application password in WordPress.

Security plugins or hosts that block `/wp-json/` or application passwords will cause connection errors; the message explains which.

### Connect a real Webflow site

1. In Webflow, go to *Site settings → Apps & integrations → API access* and generate a token with CMS read and write access.
2. Note the blog collection's ID, which is shown in its CMS collection settings.
3. In the collection template's SEO settings, bind the title and meta description to your SEO fields (for example `seo-title` and `seo-description`). Publish the site once.
4. In the app, add a website with platform *Webflow* and the public site address. Paste the token and collection ID, and optionally the field slugs, then click *Test and connect*.
5. To revoke access, disconnect in the app **and** delete the token in Webflow.

### Connect a real Shopify store

1. In Shopify admin, go to *Settings → Apps and sales channels → Develop apps*. Create an app with the Admin API scopes `read_content` and `write_content`, then install it.
2. In the app, add a website with platform *Shopify* and the storefront address. Enter the `*.myshopify.com` domain, the Admin API access token, the blog handle (default `news`) and the author name, then click *Test and connect*.
3. To revoke access, disconnect in the app **and** uninstall the custom app or rotate its token.

### Connect a custom CMS

Implement [docs/CUSTOM_CMS.md](docs/CUSTOM_CMS.md) (six JSON endpoints). Then add a website with platform *Custom CMS* and enter the API base URL and bearer token. The reference implementation is in `dev/mock-cms/custom.ts`.

## Tests and checks

```bash
npm test
```
```bash
npx playwright test
```
```bash
npm run lint
```
```bash
npm run typecheck
```
```bash
npm run build
```

- `tests/db` — migrations + RLS + RPCs run in PGlite (no Docker): cross-tenant reads/writes, column grants, roles, approval invalidation, duplicate-publish protection, job claiming/concurrency, lease reaping, rate limiting.
- `tests/unit` — URL/SSRF policy, encryption + rotation, log redaction, SEO checks, state-machine parity with the DB, retry classification, permissions, input schemas, timezone conversion.
- `tests/integration` — WordPress, Webflow, Shopify and custom adapters against their mocks (auth failures, field mapping, staged Webflow edits, Shopify throttling, user errors and exact handle matching, contract validation); the full publishing pipeline on each new platform (publish and verify, an ambiguous create timeout without a duplicate, a revoked token marking the connection `auth_failed` and becoming retryable); the multi-CMS schema guards; full publishing workflow against the real schema (happy path, ambiguous timeout without duplicate posts, 503/429 backoff, verification failure + re-verify, pre-publish validation block, slug-collision protection, invalid credentials, missing SEO plugin support, max attempts); `safeFetch` on real sockets (redirects, timeouts, size limits).
- `tests/e2e` — Playwright against the running local stack: sign up → client → connect (invalid then valid credentials) → article → validate → approve → publish → verified → job completed → dashboard; plus failed validation, missing SEO plugin support, failed verification + retry, transient errors, viewer restrictions, cross-workspace access, expired session, login rate limiting; and, for Webflow, Shopify and the custom CMS: add a website, reject a bad token, connect, then validate, approve, publish and verify an article. Requires `npx supabase start` and `npm run setup:local` (Playwright starts `dev:all` if it is not already running).

## Environment variables

See `.env.example`. Public (embedded in the browser bundle): `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Server-only secrets: `SUPABASE_SERVICE_ROLE_KEY`, `CREDENTIAL_ENCRYPTION_KEY` (+ `_ID`, `_PREVIOUS_KEYS`), `CRON_SECRET`, `ANTHROPIC_API_KEY` (AI pipelines; optional `ANTHROPIC_MODEL`), and optionally `SAPLING_API_KEY` (with `AI_DETECTION_PROVIDER=sapling`). Analytics provider credentials are entered in the UI and stored encrypted, not in environment variables. Missing configuration shows a setup page (`/setup`) listing variable names only; `/api/health` reports whether configuration is complete.

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Deploy (Vercel + Supabase)

1. Create a Supabase project. Apply migrations: `npx supabase link --project-ref <ref>` then `npx supabase db push`.
2. Supabase Auth: set *Site URL* to your app URL, add `https://<app>/auth/confirm` to redirect URLs, configure SMTP for confirmation emails, and set the confirmation email template link to `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`.
3. Vercel: import the repo, set all variables from `.env.example` with `APP_ENV=production` and `ALLOW_PRIVATE_NETWORK_TARGETS` unset. Do **not** set mock/demo variables (`MOCK_*`, `DEMO_USER_PASSWORD`, `WEBFLOW_API_BASE_URL`, `SHOPIFY_ADMIN_BASE_URL`, `ANALYTICS_API_BASE_URL`, `LLM_PROVIDER=mock`).
4. Jobs: `vercel.json` calls the cron route every minute. **Vercel Hobby only allows daily cron jobs** — on Hobby, use an external scheduler hitting `/api/cron/process-jobs` with the bearer secret, or run `npm run worker` on a small always-on host. Function duration limits cap each batch (`maxDuration = 60`).
5. Smoke test: `/api/health` returns `{"ok":true}`. Sign up, connect a staging site on each platform you use, and publish one article.

Never run `npm run seed:dev`, `npm run mock:wp`, `npm run mock:cms` or `npm run mock:analytics` in production (all refuse to).

## Known limitations

- Real WordPress, Webflow and Shopify publishing, Vercel deployment and hosted Supabase were **not** exercised here. All automated publishing tests use mocks written from the public API documentation. The Webflow and Shopify request and response shapes (including Shopify's article search syntax and API version `2025-10`) should be checked against a staging site or store before production use.
- Webflow: one collection per website. Option, reference and image fields are not filled. Webflow-native scheduling and localization are not used.
- Shopify: blog articles only (no pages or products). Tags, images and custom canonicals are not sent.
- Category, tag and featured-media IDs are WordPress-only and are hidden for other platforms.
- No email invitations (owners add users who have already signed up), no MFA/SSO, no per-client access restriction for members/viewers.
- Categories/tags/featured image use existing WordPress IDs; term lookup/creation and media upload are not implemented.
- Posts only (`/wp/v2/posts`); custom post types and WordPress pages are not supported.
- Scheduling is done by this app's queue (publishes at the time); WordPress-native `future` scheduling exists in the adapter but is not used by the workflow.
- Internal-link checks follow at most 20 links per article. The pre-publish JSON-LD check validates syntax only; the schema generator checks required properties for the types it produces.
- Generated JSON-LD is not inserted into the CMS. Add it through your theme or SEO plugin.
- AI visibility is measured on Claude (web search) and Google AI Overviews (via DataForSEO). ChatGPT, Perplexity and Gemini are not queried. Citations vary between runs, so treat them as a trend.
- Keyword difficulty is DataForSEO's Google Ads competition index, not an organic difficulty score. Keyword clustering and intent are heuristics.
- The crawler does not render JavaScript. Client-side rendered sites will appear thin.
- Duplicate-title/slug checks only see content tracked in this app (plus WordPress slug reconciliation at publish time).
- Observability is structured JSON logs (`metric.*` events) — no dashboards or alerting are configured.
- Rich text is Markdown or HTML in a textarea with a sanitized preview; no WYSIWYG editor.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model.
