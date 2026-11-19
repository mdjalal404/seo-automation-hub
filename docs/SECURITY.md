# Security model and threat analysis

## Assets
- WordPress application passwords for client sites (highest value: they allow publishing).
- Agency content, approvals and audit trail.
- Supabase service-role key, credential encryption key, cron secret.

## Trust boundaries
| Boundary | Control |
| --- | --- |
| Browser → Next.js | Supabase Auth session cookies (httpOnly, refreshed in `proxy.ts`); every page/action re-validates the user with `auth.getUser()`; server actions get Next.js' built-in Origin/Host CSRF check. |
| Next.js → Postgres (user) | User-scoped client: RLS on every table, column-level grants, and SECURITY DEFINER RPCs that re-check `auth.uid()` role (approve, enqueue, cancel, retry, members). |
| Next.js / worker → Postgres (service role) | Used only after an explicit server-side authorization check, or by the worker; every query is filtered by the `organization_id` taken from the job row. |
| Server → customer websites | `lib/security/safe-fetch.ts`: HTTPS only, no embedded credentials, standard ports, private/loopback/link-local/metadata/CGNAT ranges blocked **at connect time** (DNS-rebinding safe), redirects re-validated per hop (none for writes; Authorization dropped cross-origin), timeouts and response size limits. |

## Tenant isolation
- Every tenant table carries `organization_id`; composite foreign keys (`(organization_id, website_id)` etc.) make it impossible to attach a row to another tenant's parent.
- RLS: members read their org; writes by role (owner/admin/member/viewer). Workflow columns (`status`, approval, hashes, publish results), jobs and QA results are **not writable by clients at all** — only via RPCs/worker. Tested in `tests/db/rls.test.ts` against the real migrations.
- The active-workspace cookie is only a preference; membership is re-checked on every request.

## Credentials
- AES-256-GCM, random 96-bit IV, key from `CREDENTIAL_ENCRYPTION_KEY`, associated data `cms:<org>:<website>` (a ciphertext copied to another tenant's row fails to decrypt).
- Ciphertext column is not selectable by the `authenticated` role (column grants); decrypted only in server memory at job time.
- Credentials are tested before being stored; never returned to the browser, logged, or included in errors. The logger redacts sensitive keys and `Basic/Bearer` values.
- **Rotation:** set a new key + new `CREDENTIAL_ENCRYPTION_KEY_ID`, move the old one to `CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS`, deploy, then re-save connections (reconnect or a re-encryption script) and remove the old key. Losing all keys means sites must be reconnected. Store keys in your host's secret manager, never in the repo.

- Multi-CMS: the encrypted credential object holds both the token and its destination (Shopify shop domain, custom-CMS API base URL). Changing where a token is sent therefore requires entering the token again. Shopify domains must match `*.myshopify.com`. Custom-CMS API URLs follow the same SSRF policy as websites, with no embedded credentials, query strings or fragments. The development-only overrides `WEBFLOW_API_BASE_URL` and `SHOPIFY_ADMIN_BASE_URL` are ignored when `APP_ENV=production`. A trigger enforces that the connection type matches the website's platform, and the platform cannot change while credentials are stored. Only the `Authorization` / `X-Shopify-Access-Token` header carries a token; logs record route labels and status codes, never URLs with secrets or headers.

- AI-content detection: by default it runs locally and article text never leaves the app. If the optional Sapling provider is enabled, article text is sent to Sapling during validation. Treat this as a data-processing decision for each client. `SAPLING_API_KEY` is server-only, is sent only in the request body to `api.sapling.ai`, and is never logged.

- SEO integrations (Search Console, GA4, Clarity, DataForSEO, Similarweb, PageSpeed): credentials are verified before storage, encrypted with associated data `integration:<org>:<website>:<provider>`, and the ciphertext column is not granted to `authenticated`. Google access uses read-only scopes (`webmasters.readonly`, `analytics.readonly`) through a service-account JWT signed in memory. Endpoint overrides (`ANALYTICS_API_BASE_URL`) and `LLM_PROVIDER=mock` are ignored in production.
- AI pipelines send the topic, keywords, brand notes, article text and your published page titles/URLs to Anthropic (`ANTHROPIC_API_KEY`, server-only). AI visibility checks send only the query. Treat this as a data-processing decision per client. Model output is stored as a draft and is never published without validation and approval.
- The crawler and all provider calls use the SSRF-hardened fetch (connect-time IP checks, timeouts, size limits). The crawler stays on the website's host and respects robots.txt.

## Publishing safety
- Content state machine enforced by a database trigger (`content_transition_allowed`); validation failure can never transition to publishing.
- Approval is bound to a content hash; any material edit withdraws it (DB trigger). Content is locked while a publish job is active.
- One active publish job per content item (partial unique index); idempotency keys de-duplicate submissions.
- Ambiguous writes (timeout after sending, 5xx on POST, lost worker lease) are retried only after reconciliation: by stored post ID, then by slug **only if the title matches** (an unrelated post with the same slug is never overwritten). The post ID is persisted before the post is made public.
- Bulk publishing requires an explicit confirmation flag checked server-side.

## Abuse controls
- Postgres-backed rate limits (work across serverless instances): login per IP and per email, signup per IP, connection create/test per user.
- Generic login error (no account enumeration).
- Security headers (frame-deny, nosniff, HSTS, referrer policy) in `next.config.ts`; article previews are sanitized server-side.

## Remaining risks / not yet addressed
- WordPress application passwords grant the WordPress user's full capabilities; use a dedicated Author/Editor account per site.
- No per-client access lists: viewers/members see all clients in a workspace.
- No MFA, SSO or email invitations; no session listing/revocation UI.
- The cron route secret is a shared bearer token; rotate it if leaked.
- Content HTML is sent to WordPress as authored (WordPress applies its own `kses` filtering per user capability).
- Rate limits are fixed-window and per-key; a distributed attack across many IPs is not throttled globally.
- Dependency and container scanning are not configured.
