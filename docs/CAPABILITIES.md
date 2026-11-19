# Capabilities map

This document is for technical reviewers. It maps common requirements of an "SEO automation" role to the code in this repository. For each requirement it names the feature, where the code lives, and how the code is tested.

The app is about 21,000 lines of TypeScript, SQL and Python (Next.js 16, Supabase/Postgres, Claude API).

**Testing status.** Every external integration has been exercised end to end against local mocks written from each vendor's public API documentation:
- Google: Search Console, GA4, URL Inspection, PageSpeed
- Microsoft Clarity, DataForSEO, Similarweb, Mixpanel, Databricks
- Slack incoming webhooks, IndexNow
- WordPress, Webflow, Shopify
- Anthropic

None has been called with production credentials from this repository. See [Known limitations](#known-limitations).

## 1. Automating repetitive SEO workflows end to end

| Workflow | Automation | Code |
| --- | --- | --- |
| Pre-publish QA | 19 configurable checks run on every save and validation: metadata, headings, links, duplicates, JSON-LD, AI-written share, AI-search readiness | `lib/seo/engine.ts`, `lib/seo/checks/*` |
| Publishing | Approval-gated, idempotent publishing to WordPress, Webflow, Shopify or a custom CMS, followed by live-page verification | `lib/publishing/processor.ts`, `lib/cms/adapters/*` |
| Recurring work | Postgres-backed task queue (`SKIP LOCKED`, leases, retries limited to tasks that are safe to repeat) with daily, weekly or monthly autopilot schedules | `lib/tasks/runner.ts`, `supabase/migrations/20261105000000_seo_automation.sql` (`claim_next_task`, `enqueue_due_schedules`) |
| Opportunity detection | Striking-distance queries, low CTR versus position, cannibalization, content decay | `lib/analytics/insights.ts` |
| Measuring impact | Search Console clicks and position compared 28 days before and after each publish or applied agent proposal | `lib/analytics/impact.ts` |
| **Regression monitoring** | Every audit is diffed against the previous one (broken pages, noindex, canonical/title/description/H1/schema/content changes, new errors, robots.txt/sitemap/AI-crawler changes). Every Search Console sync is checked for traffic and ranking anomalies (7 days vs the previous 28, z-score). Alerts include before/after evidence, de-duplicate by fingerprint and resolve themselves when fixed. | `lib/monitoring/diff.ts`, `lib/monitoring/anomalies.ts`, `lib/monitoring/alerts.ts` |
| **Alerting** | Slack incoming webhooks and HMAC-signed JSON webhooks, filtered by severity; delivery results stored on each alert. | `lib/monitoring/notify.ts` |
| **Indexing** | IndexNow submission after each verified publish and for pages an audit finds changed (key file verified on connect). | `lib/indexing/indexnow.ts`, `lib/publishing/worker.ts` (`onPublished`) |
| **SEO deploy gate** | CI/CD check after a deploy or on a preview URL: key pages vs each page's last known-good state from recent audits. API keys (SHA-256 hashed), `POST /api/v1/gate`, and a zero-dependency CLI that exits 1 on failure. | `lib/monitoring/gate.ts`, `app/api/v1/gate`, `scripts/seo-gate.mjs` |

## 2. Scripts, data pipelines and internal tools (Python/JS, APIs, CI)

- **TypeScript:** the web app, API clients, worker and ETL (`lib/`, `scripts/worker.ts`).
- **Python:** the `python/seo_toolkit` package, with no third-party dependencies for log work.
  - `seo-toolkit logs` streams multi-GB logs, plain or `.gz`.
  - It verifies Googlebot by reverse and forward DNS, measures crawl waste, and lists sitemap URLs Googlebot never requested.
  - `seo-toolkit opportunities` exports Search Console opportunities from the hub's Postgres to CSV.
  - Tests are in `python/tests`.
- **CI:** `.gitlab-ci.yml` (GitLab) and `.github/workflows/ci.yml` (GitHub Actions) run lint, typecheck, unit/integration/database tests, Python tests and a production build.
- **SEO in other teams' pipelines:** `scripts/seo-gate.mjs` plus the public `/api/v1/gate` endpoint let any repository fail a deploy that breaks SEO. Ready-made GitHub Actions and GitLab CI snippets are on the *API & CI/CD* page.
- **Data access:**
  - CSV, JSON and PDF exports: `app/api/analytics/export`, `app/api/audits/[id]/export`.
  - SQL view `v_page_performance` for BI tools.

## 3. LLM and agentic workflows with quality control at scale

| Use | How it works | Quality control | Code |
| --- | --- | --- | --- |
| Content generation | Three Claude calls with schema-validated JSON output: brief, then draft, then reviewer | Output is always a draft, flagged "AI draft". The reviewer lists claims to verify. Normal validation and human approval apply. Tokens are logged per step (`ai_runs`). | `lib/ai/content-pipeline.ts` |
| **SEO agent** | Claude tool-use loop (Anthropic SDK tool runner). Eight tools: site overview, Search Console, opportunity detection, audit issues, keywords, content, live page inspection, `propose_action`. | The agent cannot write. It can only file proposals, and people approve them before anything is applied (queue a draft, rewrite meta tags, insert a link). Limits: 20 steps and 15 proposals per run. Tools are scoped to one website, and live fetches stay on its host. Every tool call is stored with inputs, outputs and timings. Page content is treated as untrusted. | `lib/agents/seo-agent.ts`, `lib/services/automation.ts` (`decideProposal`), `app/(app)/agent/*` |
| Content QA at scale | LLM rubric with six dimensions, plus deterministic signals (AI-share estimate, AI-search readiness, length) | The verdict comes from **fixed thresholds in code**, not from the model, so results stay comparable across thousands of pages and model versions. Unchanged content (same hash) is not re-reviewed. | `lib/ai/content-qa.ts` |
| Internal linking | TF-IDF similarity plus exact anchor-phrase matching, using published articles, cluster URLs and crawled pages | Links are inserted only outside headings, code and existing links. Editing withdraws approval. | `lib/seo/internal-links.ts` |
| AI visibility | Readiness score from nine on-page signals, plus measured citations: Claude with live web search, and Google AI Overview references via DataForSEO. Robots.txt access is checked for ten AI crawlers. | Results are stored per query and engine, and tracked over time. | `lib/seo/ai-visibility.ts`, `lib/tasks/runner.ts` (`runVisibilityCheck`), `lib/audit/crawler.ts` |
| AI-written share | Local heuristic (style profile plus sentence signals), with Sapling as an optional provider | Calibration numbers are in the README. It is labelled as an estimate. | `lib/seo/ai-detection.ts` |

Model handling: `claude-opus-5-5` with structured outputs and server-side refusal fallbacks. Typed errors are mapped to retryable or permanent failures. A clearly labelled mock provider exists for development and is refused in production (`lib/ai/llm.ts`).

## 4. Programmatic and technical SEO

- **Feed-driven pages:** a template plus a CSV/JSON feed produces up to 500 drafts per run.
  - Templates support `{{column|filter}}` placeholders and `{{#if}}` blocks.
  - Rows are rejected for duplicate or existing slugs.
  - Thin or doorway-like pages are flagged by measuring how much of the body comes from the row's own data.
  - Examples include game-key marketplace pages (`lib/programmatic/templates.ts`).
- **Structured data:** JSON-LD for Article/BlogPosting, FAQPage, HowTo (both extracted from the visible content), BreadcrumbList, Organization, LocalBusiness and Product, with checks for required properties (`lib/seo/schema-generator.ts`).
- **Crawl and indexation health:** the crawler (`lib/audit/crawler.ts`) is breadth-first, respects robots.txt, and is protected against server-side request forgery (`lib/security/safe-fetch.ts`). It reports 34 issue types. Every finding stores its evidence (for example, the other URLs that share a duplicate title, the broken link target, the insecure resource URL, the word count). The evidence is shown in the report and included in the issues CSV and the PDF. The types include:
  - status codes, redirects and broken internal links;
  - canonicals and noindex;
  - duplicate titles and descriptions;
  - orphan pages, click depth and sitemap coverage;
  - indexable parameter URLs and non-indexable URLs in the sitemap;
  - **hreflang:** invalid codes, missing self-reference, missing return links, broken targets, no x-default;
  - Search Console URL Inspection verdicts and Core Web Vitals (PageSpeed).
- **Crawl budget from server logs:** `lib/audit/logs.ts` and `/crawl-budget`. The analysis covers:
  - Googlebot requests by section, status and day;
  - waste on redirects, errors and parameter URLs;
  - the most-crawled parameters;
  - indexable pages Googlebot never requested;
  - AI-bot crawling.
- **Exports:** audit results as a PDF report, CSV of pages, CSV of issues, or JSON.

## 5. SEO and traffic data pipelines

| Source | What is pulled | Code |
| --- | --- | --- |
| Google Search Console | Daily query × page rows (90-day backfill, then rolling re-pull), plus URL Inspection | `lib/analytics/providers.ts` (`gscQuery`, `gscInspectUrl`) |
| GA4 | Organic landing-page sessions, users, engaged sessions, key events | `ga4OrganicReport` |
| Mixpanel | Daily conversion events segmented by landing page, with an optional organic filter | `mixpanelSegmentation` |
| DataForSEO | Search volume, live SERP position and top 10, AI Overview citations; **multi-market** (up to 5 extra locations and languages) | `dfsSearchVolume`, `dfsSerp`, `runRankCheck` |
| Similarweb | Monthly visits | `similarwebTraffic` |
| Microsoft Clarity | Rage clicks, dead clicks, scroll depth per page | `clarityInsights` |
| PageSpeed Insights | Field and lab Core Web Vitals | `pagespeed` |
| **Databricks** (out) | ETL into Delta tables: search performance, traffic, keyword snapshot, audit pages. Reruns are idempotent (the time window is deleted and re-inserted). Every value is sent as a typed parameter, never interpolated into SQL. | `lib/analytics/warehouse.ts` |

Google uses service-account authentication (a JWT signed in memory, read-only scopes). All credentials are encrypted with AES-256-GCM and per-tenant associated data, readable only by the service role (`lib/analytics/credentials.ts`, `docs/SECURITY.md`).

## 6. Working with product and engineering

- **Multi-tenant:** workspaces, roles and Postgres row-level security, with database tests (`tests/db`).
- **Documentation:** the README covers setup, environment, deployment and limitations; [SECURITY.md](SECURITY.md) has the threat model; [CUSTOM_CMS.md](CUSTOM_CMS.md) defines an integration contract.
- **Tests:**
  - 181 unit, integration and database tests (Vitest);
  - 20 Playwright browser tests against local mocks of every external service, including the full regression → alert → failed CI gate → fix → auto-resolve flow;
  - Python unit tests.

## Known limitations

- No real third-party credentials have been used. Request and response shapes follow vendor documentation and should be confirmed against staging accounts. This applies in particular to Similarweb authentication, Clarity field names, Mixpanel segmentation parameters and Databricks parameter limits.
- In the web app, bots in logs are identified by user agent only. The Python CLI adds DNS verification.
- The crawler does not render JavaScript.
- Agent quality depends on the model and data available. Proposals are recommendations and go through approval by design.
- Traffic anomaly detection needs at least 35 days of Search Console data and a few clicks per day; very small sites will not trigger it.
- IndexNow is not used by Google.
- Impact measurement compares before and after windows. It does not control for seasonality or algorithm updates.
