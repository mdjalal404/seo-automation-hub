-- Agentic SEO runs with human-approved proposals, server log (crawl budget) analysis,
-- bulk AI content QA, Mixpanel and Databricks integrations.

alter table public.automation_tasks drop constraint automation_tasks_task_type_check;
alter table public.automation_tasks add constraint automation_tasks_task_type_check check (task_type in (
  'SITE_AUDIT', 'ANALYTICS_SYNC', 'GENERATE_CONTENT', 'AI_VISIBILITY_CHECK', 'RANK_CHECK', 'AGENT_RUN', 'CONTENT_QA', 'WAREHOUSE_EXPORT'));
-- Agent runs and QA batches may run alongside each other; keep the one-active rule for crawls/syncs/exports.
drop index public.tasks_one_active_per_type;
create unique index tasks_one_active_per_type on public.automation_tasks (website_id, task_type)
  where status in ('QUEUED', 'RUNNING') and task_type not in ('GENERATE_CONTENT', 'AGENT_RUN', 'CONTENT_QA');

alter table public.automation_schedules drop constraint automation_schedules_task_type_check;
alter table public.automation_schedules add constraint automation_schedules_task_type_check check (task_type in (
  'SITE_AUDIT', 'ANALYTICS_SYNC', 'AI_VISIBILITY_CHECK', 'RANK_CHECK', 'AGENT_RUN', 'WAREHOUSE_EXPORT'));

alter table public.integrations drop constraint integrations_provider_check;
alter table public.integrations add constraint integrations_provider_check check (provider in (
  'google_search_console', 'google_analytics_4', 'microsoft_clarity', 'dataforseo', 'similarweb', 'pagespeed', 'mixpanel', 'databricks'));

alter table public.traffic_daily drop constraint traffic_daily_source_check;
alter table public.traffic_daily add constraint traffic_daily_source_check check (source in ('ga4', 'clarity', 'similarweb', 'mixpanel'));

alter table public.ai_runs drop constraint ai_runs_kind_check;
alter table public.ai_runs add constraint ai_runs_kind_check check (kind in ('brief', 'draft', 'review', 'visibility', 'cluster_naming', 'meta', 'agent', 'qa'));

-- ---------------------------------------------------------------------------
-- Agent runs: goal, tool-call trace, final report. Agents only read data and
-- create proposals; people approve proposals before anything changes.
-- ---------------------------------------------------------------------------
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  task_id uuid unique references public.automation_tasks (id) on delete set null,
  goal text not null check (char_length(goal) between 5 and 2000),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  steps jsonb not null default '[]'::jsonb,
  report text,
  provider text,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (organization_id, id),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index agent_runs_website_idx on public.agent_runs (website_id, created_at desc);

create table public.agent_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  run_id uuid not null,
  kind text not null check (kind in ('new_article', 'content_refresh', 'meta_rewrite', 'internal_link', 'technical_fix', 'schema')),
  title text not null check (char_length(title) between 1 and 300),
  rationale text not null check (char_length(rationale) <= 4000),
  evidence jsonb not null default '[]'::jsonb,
  target_url text,
  payload jsonb not null default '{}'::jsonb,
  priority text not null default 'medium' check (priority in ('high', 'medium', 'low')),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'done')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (organization_id, run_id) references public.agent_runs (organization_id, id) on delete cascade,
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index agent_proposals_website_idx on public.agent_proposals (website_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Server log analysis (crawl budget)
-- ---------------------------------------------------------------------------
create table public.log_analyses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  source_name text not null check (char_length(source_name) between 1 and 300),
  lines_total integer not null default 0,
  lines_parsed integer not null default 0,
  bot_hits integer not null default 0,
  -- per bot, status, section, parameters, daily hits, top URLs, crawl waste…
  summary jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index log_analyses_website_idx on public.log_analyses (website_id, created_at desc);

-- ---------------------------------------------------------------------------
-- AI content QA results (LLM rubric + deterministic checks)
-- ---------------------------------------------------------------------------
create table public.content_reviews (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  content_item_id uuid not null,
  task_id uuid references public.automation_tasks (id) on delete set null,
  content_hash text not null,
  scores jsonb not null default '{}'::jsonb,
  verdict text not null check (verdict in ('pass', 'needs_revision', 'fail')),
  issues jsonb not null default '[]'::jsonb,
  claims_to_verify jsonb not null default '[]'::jsonb,
  provider text not null,
  model text not null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade
);
create index content_reviews_item_idx on public.content_reviews (content_item_id, created_at desc);

alter table public.agent_runs enable row level security;
alter table public.agent_proposals enable row level security;
alter table public.log_analyses enable row level security;
alter table public.content_reviews enable row level security;
create policy agent_runs_select on public.agent_runs for select to authenticated using (public.is_org_member(organization_id));
create policy agent_proposals_select on public.agent_proposals for select to authenticated using (public.is_org_member(organization_id));
create policy log_analyses_select on public.log_analyses for select to authenticated using (public.is_org_member(organization_id));
create policy content_reviews_select on public.content_reviews for select to authenticated using (public.is_org_member(organization_id));
-- Writes happen in server code (service role) after a capability check.
revoke insert, update, delete on public.agent_runs, public.agent_proposals, public.log_analyses, public.content_reviews from authenticated;
revoke all on public.agent_runs, public.agent_proposals, public.log_analyses, public.content_reviews from anon;
