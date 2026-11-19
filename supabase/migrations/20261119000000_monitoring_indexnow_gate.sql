-- SEO monitoring (audit-to-audit regressions, traffic anomalies) with alerts delivered to
-- Slack or a signed webhook, IndexNow submission, and a CI/CD "SEO deploy gate" driven by
-- API keys.

alter table public.automation_tasks drop constraint automation_tasks_task_type_check;
alter table public.automation_tasks add constraint automation_tasks_task_type_check check (task_type in (
  'SITE_AUDIT', 'ANALYTICS_SYNC', 'GENERATE_CONTENT', 'AI_VISIBILITY_CHECK', 'RANK_CHECK', 'AGENT_RUN', 'CONTENT_QA', 'WAREHOUSE_EXPORT',
  'INDEXNOW_SUBMIT', 'SEO_GATE'));
-- Several deploys (gate runs) and IndexNow batches may be in flight at once.
drop index public.tasks_one_active_per_type;
create unique index tasks_one_active_per_type on public.automation_tasks (website_id, task_type)
  where status in ('QUEUED', 'RUNNING') and task_type not in ('GENERATE_CONTENT', 'AGENT_RUN', 'CONTENT_QA', 'INDEXNOW_SUBMIT', 'SEO_GATE');

alter table public.integrations drop constraint integrations_provider_check;
alter table public.integrations add constraint integrations_provider_check check (provider in (
  'google_search_console', 'google_analytics_4', 'microsoft_clarity', 'dataforseo', 'similarweb', 'pagespeed', 'mixpanel', 'databricks',
  'slack', 'webhook', 'indexnow'));

-- ---------------------------------------------------------------------------
-- Alerts. One open alert per (website, fingerprint): repeats bump occurrences.
-- ---------------------------------------------------------------------------
create table public.seo_alerts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  source text not null check (source in ('audit', 'traffic', 'gate')),
  kind text not null check (char_length(kind) between 1 and 60),
  severity text not null check (severity in ('critical', 'warning', 'info')),
  title text not null check (char_length(title) between 1 and 300),
  url text,
  evidence jsonb not null default '[]'::jsonb,
  fingerprint text not null check (char_length(fingerprint) <= 600),
  status text not null default 'open' check (status in ('open', 'acknowledged', 'resolved')),
  occurrences integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_reason text,
  acknowledged_by uuid references auth.users (id) on delete set null,
  notified jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create unique index seo_alerts_open_fingerprint on public.seo_alerts (website_id, fingerprint) where status <> 'resolved';
create index seo_alerts_website_idx on public.seo_alerts (website_id, status, last_seen_at desc);

-- ---------------------------------------------------------------------------
-- API keys for CI/CD and scripts. Only a SHA-256 hash of the secret is stored;
-- the full key is shown once at creation.
-- ---------------------------------------------------------------------------
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  prefix text not null unique check (prefix ~ '^[a-z0-9]{10}$'),
  key_hash text not null check (key_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null default '{gate}',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_org_idx on public.api_keys (organization_id, created_at desc);

alter table public.seo_alerts enable row level security;
alter table public.api_keys enable row level security;
create policy seo_alerts_select on public.seo_alerts for select to authenticated using (public.is_org_member(organization_id));
create policy api_keys_select on public.api_keys for select to authenticated using (public.is_org_member(organization_id));
-- Writes happen in server code (service role) after a capability check.
revoke insert, update, delete on public.seo_alerts, public.api_keys from authenticated;
revoke all on public.seo_alerts, public.api_keys from anon;
-- Members may list keys but never read the hash.
revoke select on public.api_keys from authenticated;
grant select (id, organization_id, name, prefix, scopes, created_by, created_at, last_used_at, revoked_at) on public.api_keys to authenticated;
