-- SEO automation: AI pipelines, keywords & clustering, technical audits, programmatic
-- templates, analytics integrations and the background task queue that runs them.
-- Writes to integrations/analytics/audit/task tables go through server code with the
-- service role after an explicit capability check; members can read their workspace.

-- ---------------------------------------------------------------------------
-- Content additions
-- ---------------------------------------------------------------------------
alter table public.content_items
  add column schema_jsonld jsonb,
  add column ai_generated boolean not null default false,
  add column brief jsonb,
  add column generation_task_id uuid unique,
  add column template_id uuid;
grant update (schema_jsonld) on public.content_items to authenticated;

-- ---------------------------------------------------------------------------
-- Background task queue (audits, analytics sync, AI generation, visibility checks)
-- ---------------------------------------------------------------------------
create table public.automation_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  task_type text not null check (task_type in ('SITE_AUDIT', 'ANALYTICS_SYNC', 'AI_VISIBILITY_CHECK', 'RANK_CHECK')),
  cadence text not null check (cadence in ('daily', 'weekly', 'monthly')),
  params jsonb not null default '{}'::jsonb,
  enabled boolean not null default true,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (website_id, task_type),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);

create table public.automation_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  task_type text not null check (task_type in ('SITE_AUDIT', 'ANALYTICS_SYNC', 'GENERATE_CONTENT', 'AI_VISIBILITY_CHECK', 'RANK_CHECK')),
  status text not null default 'QUEUED' check (status in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  params jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  progress text,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 300),
  attempts integer not null default 0,
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  run_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  lease_expires_at timestamptz,
  locked_by text,
  error_code text,
  error_message text,
  schedule_id uuid references public.automation_schedules (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key),
  unique (organization_id, id),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index tasks_claim_idx on public.automation_tasks (status, run_at) where status = 'QUEUED';
create index tasks_org_idx on public.automation_tasks (organization_id, created_at desc);
create index tasks_website_idx on public.automation_tasks (website_id, task_type, created_at desc);
-- One active run per website and task type (prevents duplicate crawls/syncs).
create unique index tasks_one_active_per_type on public.automation_tasks (website_id, task_type)
  where status in ('QUEUED', 'RUNNING') and task_type <> 'GENERATE_CONTENT';

alter table public.content_items
  add constraint content_generation_task_fk foreign key (generation_task_id) references public.automation_tasks (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Keywords & clusters
-- ---------------------------------------------------------------------------
create table public.keyword_clusters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  head_keyword text not null,
  intent text not null default 'informational' check (intent in ('informational', 'commercial', 'transactional', 'navigational', 'local')),
  total_volume integer not null default 0,
  keyword_count integer not null default 0,
  target_url text,
  content_item_id uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade,
  foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete set null (content_item_id)
);
create index clusters_website_idx on public.keyword_clusters (website_id, total_volume desc);

create table public.keywords (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  keyword text not null check (char_length(keyword) between 1 and 200 and keyword = lower(keyword)),
  search_volume integer check (search_volume is null or search_volume >= 0),
  difficulty numeric check (difficulty is null or difficulty between 0 and 100),
  cpc numeric check (cpc is null or cpc >= 0),
  intent text check (intent is null or intent in ('informational', 'commercial', 'transactional', 'navigational', 'local')),
  position numeric,
  ranking_url text,
  position_checked_at timestamptz,
  source text not null default 'manual' check (source in ('manual', 'csv', 'gsc', 'dataforseo')),
  tracked boolean not null default false,
  cluster_id uuid,
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (website_id, keyword),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade,
  foreign key (organization_id, cluster_id) references public.keyword_clusters (organization_id, id) on delete set null (cluster_id)
);
create index keywords_cluster_idx on public.keywords (cluster_id);
create trigger trg_keywords_touch before update on public.keywords for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Programmatic page templates
-- ---------------------------------------------------------------------------
create table public.page_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  title_template text not null check (char_length(title_template) between 1 and 500),
  slug_template text not null check (char_length(slug_template) between 1 and 300),
  meta_title_template text not null default '' check (char_length(meta_title_template) <= 300),
  meta_description_template text not null default '' check (char_length(meta_description_template) <= 1000),
  excerpt_template text not null default '' check (char_length(excerpt_template) <= 2000),
  keyword_template text not null default '' check (char_length(keyword_template) <= 200),
  body_template text not null check (char_length(body_template) between 1 and 200000),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create trigger trg_templates_touch before update on public.page_templates for each row execute function public.touch_updated_at();
alter table public.content_items
  add constraint content_template_fk foreign key (template_id) references public.page_templates (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Technical audits
-- ---------------------------------------------------------------------------
create table public.site_audits (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  task_id uuid unique references public.automation_tasks (id) on delete set null,
  score integer check (score is null or score between 0 and 100),
  pages_crawled integer not null default 0,
  -- {issue_code: count}, robots/sitemap/llms.txt findings, AI crawler access, Core Web Vitals
  summary jsonb not null default '{}'::jsonb,
  site_checks jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index audits_website_idx on public.site_audits (website_id, created_at desc);

create table public.site_audit_pages (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  audit_id uuid not null,
  url text not null,
  status_code integer,
  depth integer not null default 0,
  title text,
  meta_description text,
  canonical text,
  indexable boolean,
  word_count integer,
  load_ms integer,
  inlinks integer not null default 0,
  issues text[] not null default '{}',
  details jsonb not null default '{}'::jsonb,
  foreign key (organization_id, audit_id) references public.site_audits (organization_id, id) on delete cascade
);
create index audit_pages_audit_idx on public.site_audit_pages (audit_id);

-- ---------------------------------------------------------------------------
-- Analytics integrations and data
-- ---------------------------------------------------------------------------
create table public.integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  provider text not null check (provider in ('google_search_console', 'google_analytics_4', 'microsoft_clarity', 'dataforseo', 'similarweb', 'pagespeed')),
  -- AES-256-GCM envelope (lib/security/crypto.ts). Never plaintext.
  encrypted_credentials text not null check (encrypted_credentials like 'v1:%'),
  -- Non-secret settings: property ID, site URL, service-account email, location…
  metadata jsonb not null default '{}'::jsonb,
  status public.connection_status not null default 'connected',
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (website_id, provider),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create trigger trg_integrations_touch before update on public.integrations for each row execute function public.touch_updated_at();

create table public.search_performance_daily (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  date date not null,
  query text not null,
  page text not null,
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr numeric not null default 0,
  position numeric not null default 0,
  primary key (website_id, date, query, page),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index search_perf_query_idx on public.search_performance_daily (website_id, query);
create index search_perf_page_idx on public.search_performance_daily (website_id, page);

create table public.traffic_daily (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  source text not null check (source in ('ga4', 'clarity', 'similarweb')),
  date date not null,
  page text not null default '',
  -- ga4: sessions, users, engaged_sessions, conversions, bounce_rate; clarity: sessions,
  -- scroll_depth, dead_clicks, rage_clicks, quickbacks; similarweb: visits, bounce_rate…
  metrics jsonb not null default '{}'::jsonb,
  primary key (website_id, source, date, page),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- AI runs (cost/traceability) and AI visibility
-- ---------------------------------------------------------------------------
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid,
  content_item_id uuid,
  task_id uuid references public.automation_tasks (id) on delete set null,
  kind text not null check (kind in ('brief', 'draft', 'review', 'visibility', 'cluster_naming', 'meta')),
  provider text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ai_runs_org_idx on public.ai_runs (organization_id, created_at desc);

create table public.ai_visibility_checks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  content_item_id uuid,
  task_id uuid references public.automation_tasks (id) on delete set null,
  query text not null,
  engine text not null check (engine in ('claude_web_search', 'google_ai_overview')),
  cited boolean not null,
  mentioned boolean not null,
  cited_urls jsonb not null default '[]'::jsonb,
  answer_excerpt text,
  checked_at timestamptz not null default now(),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index ai_visibility_website_idx on public.ai_visibility_checks (website_id, checked_at desc);

-- Modeled view for SQL users / BI tools: page performance across sources (last 28 days).
create view public.v_page_performance with (security_invoker = true) as
  select s.organization_id, s.website_id, s.page,
         sum(s.clicks) as clicks, sum(s.impressions) as impressions,
         case when sum(s.impressions) > 0 then round(sum(s.clicks)::numeric / sum(s.impressions), 4) else 0 end as ctr,
         round(sum(s.position * s.impressions) / nullif(sum(s.impressions), 0), 2) as avg_position,
         count(distinct s.query) as queries
    from public.search_performance_daily s
   where s.date >= current_date - 28
   group by s.organization_id, s.website_id, s.page;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create trigger trg_schedules_touch before update on public.automation_schedules for each row execute function public.touch_updated_at();
create trigger trg_tasks_touch before update on public.automation_tasks for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.automation_schedules enable row level security;
alter table public.automation_tasks enable row level security;
alter table public.keyword_clusters enable row level security;
alter table public.keywords enable row level security;
alter table public.page_templates enable row level security;
alter table public.site_audits enable row level security;
alter table public.site_audit_pages enable row level security;
alter table public.integrations enable row level security;
alter table public.search_performance_daily enable row level security;
alter table public.traffic_daily enable row level security;
alter table public.ai_runs enable row level security;
alter table public.ai_visibility_checks enable row level security;

do $$
declare t text;
begin
  foreach t in array array['automation_schedules', 'automation_tasks', 'keyword_clusters', 'keywords', 'page_templates',
    'site_audits', 'site_audit_pages', 'search_performance_daily', 'traffic_daily', 'ai_runs', 'ai_visibility_checks'] loop
    execute format('create policy %1$s_select on public.%1$s for select to authenticated using (public.is_org_member(organization_id))', t);
  end loop;
  -- Editors (owner/admin/member) manage keywords, clusters and templates.
  foreach t in array array['keywords', 'keyword_clusters', 'page_templates'] loop
    execute format('create policy %1$s_insert on public.%1$s for insert to authenticated with check (public.has_org_role(organization_id, ''{owner,admin,member}''))', t);
    execute format('create policy %1$s_update on public.%1$s for update to authenticated using (public.has_org_role(organization_id, ''{owner,admin,member}'')) with check (public.has_org_role(organization_id, ''{owner,admin,member}''))', t);
    execute format('create policy %1$s_delete on public.%1$s for delete to authenticated using (public.has_org_role(organization_id, ''{owner,admin,member}''))', t);
  end loop;
end $$;

-- Integrations: owners/admins can see non-secret columns and delete; secrets are service-role only.
create policy integrations_select on public.integrations for select to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));
create policy integrations_delete on public.integrations for delete to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));
revoke all on public.integrations from authenticated;
grant select (id, organization_id, website_id, provider, metadata, status, last_synced_at, last_error, created_at, updated_at)
  on public.integrations to authenticated;
grant delete on public.integrations to authenticated;

-- Schedules: owners/admins.
create policy schedules_write on public.automation_schedules for all to authenticated
  using (public.has_org_role(organization_id, '{owner,admin}')) with check (public.has_org_role(organization_id, '{owner,admin}'));

revoke insert, update, delete on public.automation_tasks, public.site_audits, public.site_audit_pages,
  public.search_performance_daily, public.traffic_daily, public.ai_runs, public.ai_visibility_checks from authenticated;
revoke all on public.automation_schedules, public.automation_tasks, public.keyword_clusters, public.keywords, public.page_templates,
  public.site_audits, public.site_audit_pages, public.integrations, public.search_performance_daily, public.traffic_daily,
  public.ai_runs, public.ai_visibility_checks from anon;
revoke all on public.v_page_performance from anon;
grant select on public.v_page_performance to authenticated;

-- ---------------------------------------------------------------------------
-- Worker functions (service role only)
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_task(p_worker text, p_lease_seconds integer default 600)
returns setof public.automation_tasks language plpgsql security definer set search_path = public as $$
declare
  cand uuid;
begin
  select id into cand from public.automation_tasks
   where status = 'QUEUED' and run_at <= now()
   order by run_at, created_at
   limit 1
   for update skip locked;
  if cand is null then
    return;
  end if;
  return query
    update public.automation_tasks
       set status = 'RUNNING', attempts = attempts + 1, started_at = now(), locked_by = p_worker,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds), error_code = null, error_message = null
     where id = cand
     returning *;
end $$;

-- Tasks only read from external services or write idempotently (generation is keyed by
-- content_items.generation_task_id), so an expired lease can be requeued safely.
create or replace function public.reap_expired_tasks()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with expired as (
    update public.automation_tasks
       set status = case when attempts >= max_attempts then 'FAILED' else 'QUEUED' end,
           completed_at = case when attempts >= max_attempts then now() else null end,
           run_at = now() + interval '1 minute',
           error_code = 'LEASE_EXPIRED', error_message = 'The worker stopped responding; the task was requeued.',
           lease_expires_at = null, locked_by = null
     where status = 'RUNNING' and lease_expires_at < now()
     returning 1)
  select count(*) into n from expired;
  return n;
end $$;

-- Enqueues every due schedule once (idempotency key = schedule + due time) and advances it.
create or replace function public.enqueue_due_schedules()
returns integer language plpgsql security definer set search_path = public as $$
declare
  s public.automation_schedules;
  n integer := 0;
begin
  for s in select * from public.automation_schedules where enabled and next_run_at <= now() for update skip locked loop
    begin
      insert into public.automation_tasks (organization_id, website_id, task_type, params, idempotency_key, schedule_id)
      values (s.organization_id, s.website_id, s.task_type, s.params, 'schedule:' || s.id || ':' || extract(epoch from s.next_run_at)::bigint, s.id)
      on conflict do nothing;
      if found then n := n + 1; end if;
    exception when unique_violation then
      null; -- a run of this type is already active for the website
    end;
    update public.automation_schedules
       set last_run_at = now(),
           next_run_at = greatest(now(), s.next_run_at) + case s.cadence when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end
     where id = s.id;
  end loop;
  return n;
end $$;

revoke execute on function public.claim_next_task(text, integer) from public, anon, authenticated;
revoke execute on function public.reap_expired_tasks() from public, anon, authenticated;
revoke execute on function public.enqueue_due_schedules() from public, anon, authenticated;
grant execute on function public.claim_next_task(text, integer) to service_role;
grant execute on function public.reap_expired_tasks() to service_role;
grant execute on function public.enqueue_due_schedules() to service_role;
