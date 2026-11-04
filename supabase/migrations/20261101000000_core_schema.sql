-- SEO Automation Hub — core schema
-- All timestamps are timestamptz (stored as UTC). Website-local scheduling is
-- converted to UTC by the application using websites.timezone (IANA name).


-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.org_role as enum ('owner', 'admin', 'member', 'viewer');

create type public.content_status as enum (
  'DRAFT', 'VALIDATING', 'READY_FOR_REVIEW', 'APPROVED', 'QUEUED',
  'PUBLISHING', 'VERIFYING', 'PUBLISHED',
  'VALIDATION_FAILED', 'PUBLISH_FAILED', 'VERIFICATION_FAILED', 'CANCELLED'
);

create type public.job_status as enum (
  'QUEUED', 'VALIDATING', 'PUBLISHING', 'VERIFYING', 'COMPLETED',
  'FAILED', 'CANCELLED', 'RETRY_SCHEDULED'
);

create type public.job_type as enum ('VALIDATE', 'CREATE_DRAFT', 'PUBLISH', 'VERIFY');

create type public.validation_status as enum (
  'NOT_RUN', 'PASSED', 'PASSED_WITH_WARNINGS', 'FAILED', 'STALE'
);

create type public.connection_status as enum (
  'not_connected', 'pending', 'connected', 'auth_failed', 'error'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
  -- Workspace-level settings, e.g. {"minutes_saved_per_publish": 20}
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  notes text check (notes is null or char_length(notes) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index clients_org_idx on public.clients (organization_id, name);

create table public.websites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  client_id uuid not null,
  name text not null check (char_length(name) between 1 and 200),
  base_url text not null check (base_url ~ '^https?://'),
  cms_type text not null default 'wordpress' check (cms_type in ('wordpress')),
  connection_status public.connection_status not null default 'not_connected',
  timezone text not null default 'UTC',
  -- e.g. {"max_concurrency": 1, "min_request_interval_ms": 500, "default_post_status": "draft"}
  publishing_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  -- Composite FK guarantees the client belongs to the same organization.
  foreign key (organization_id, client_id) references public.clients (organization_id, id) on delete cascade
);
create index websites_org_idx on public.websites (organization_id);
create index websites_client_idx on public.websites (client_id);

create table public.cms_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null unique,
  connection_type text not null default 'wordpress_application_password'
    check (connection_type in ('wordpress_application_password')),
  -- AES-256-GCM envelope produced by lib/security/crypto.ts. Never plaintext.
  encrypted_credentials text not null check (encrypted_credentials like 'v1:%'),
  -- Non-secret descriptive data (username, detected capabilities, SEO plugins).
  metadata jsonb not null default '{}'::jsonb,
  connection_status public.connection_status not null default 'pending',
  last_tested_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  title text not null default '' check (char_length(title) <= 500),
  slug text not null default '' check (slug = '' or slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  body text not null default '' check (char_length(body) <= 500000),
  body_format text not null default 'markdown' check (body_format in ('markdown', 'html')),
  excerpt text not null default '' check (char_length(excerpt) <= 2000),
  meta_title text not null default '' check (char_length(meta_title) <= 300),
  meta_description text not null default '' check (char_length(meta_description) <= 1000),
  canonical_url text not null default '' check (char_length(canonical_url) <= 2048),
  target_keyword text not null default '' check (char_length(target_keyword) <= 200),
  categories integer[] not null default '{}',
  tags integer[] not null default '{}',
  featured_media_id integer,
  status public.content_status not null default 'DRAFT',
  validation_status public.validation_status not null default 'NOT_RUN',
  content_hash text not null default '',
  validated_hash text,
  approved_hash text,
  scheduled_at timestamptz,
  published_url text,
  external_post_id text,
  -- Per-field SEO metadata sync state: stored / sent / confirmed / verified.
  seo_sync jsonb not null default '{}'::jsonb,
  assigned_to uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index content_org_status_idx on public.content_items (organization_id, status);
create index content_website_slug_idx on public.content_items (website_id, slug);
create index content_website_title_idx on public.content_items (website_id, lower(title));
create index content_updated_idx on public.content_items (organization_id, updated_at desc);

create table public.content_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  content_item_id uuid,
  job_type public.job_type not null,
  status public.job_status not null default 'QUEUED',
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 300),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  scheduled_at timestamptz,               -- requested publish time (UTC)
  run_at timestamptz not null default now(), -- next eligible execution (UTC)
  started_at timestamptz,
  completed_at timestamptz,
  lease_expires_at timestamptz,
  locked_by text,
  needs_reconciliation boolean not null default false,
  error_code text,
  error_message text,
  retryable boolean,
  result jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade,
  foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade
);
create index jobs_claim_idx on public.content_jobs (status, run_at) where status in ('QUEUED', 'RETRY_SCHEDULED');
create index jobs_org_created_idx on public.content_jobs (organization_id, created_at desc);
create index jobs_website_running_idx on public.content_jobs (website_id, status);
create index jobs_content_idx on public.content_jobs (content_item_id);
-- Duplicate publication prevention: at most one active publish job per content item.
create unique index jobs_one_active_publish_per_content on public.content_jobs (content_item_id)
  where job_type = 'PUBLISH' and status in ('QUEUED', 'VALIDATING', 'PUBLISHING', 'VERIFYING', 'RETRY_SCHEDULED');
create unique index jobs_one_active_draft_per_content on public.content_jobs (content_item_id)
  where job_type = 'CREATE_DRAFT' and status in ('QUEUED', 'VALIDATING', 'PUBLISHING', 'VERIFYING', 'RETRY_SCHEDULED');

create table public.qa_results (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid not null,
  content_item_id uuid not null,
  job_id uuid references public.content_jobs (id) on delete set null,
  phase text not null default 'pre_publish' check (phase in ('pre_publish', 'post_publish')),
  check_name text not null,
  status text not null check (status in ('pass', 'fail', 'skipped')),
  severity text not null check (severity in ('error', 'warning', 'info')),
  kind text not null default 'technical' check (kind in ('technical', 'recommendation')),
  message text not null,
  field text,
  url text,
  remediation text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (organization_id, content_item_id) references public.content_items (organization_id, id) on delete cascade,
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create index qa_content_idx on public.qa_results (content_item_id, created_at desc);
create index qa_org_idx on public.qa_results (organization_id, created_at desc);

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  website_id uuid,                       -- null = workspace default
  name text not null default 'Default rules',
  enabled boolean not null default true,
  rules_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, website_id) references public.websites (organization_id, id) on delete cascade
);
create unique index automation_rules_scope_uniq on public.automation_rules
  (organization_id, coalesce(website_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_org_idx on public.audit_logs (organization_id, created_at desc);

-- Fixed-window counters for persistent, cross-instance rate limiting.
create table public.rate_limits (
  key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (key, window_start)
);

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so policies don't recurse on memberships)
-- ---------------------------------------------------------------------------
create or replace function public.current_role_in(org uuid)
returns public.org_role
language sql stable security definer set search_path = public
as $$
  select role from public.memberships where organization_id = org and user_id = auth.uid()
$$;

create or replace function public.is_org_member(org uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.memberships where organization_id = org and user_id = auth.uid())
$$;

create or replace function public.has_org_role(org uuid, roles public.org_role[])
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where organization_id = org and user_id = auth.uid() and role = any (roles)
  )
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger trg_profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger trg_orgs_touch before update on public.organizations for each row execute function public.touch_updated_at();
create trigger trg_clients_touch before update on public.clients for each row execute function public.touch_updated_at();
create trigger trg_websites_touch before update on public.websites for each row execute function public.touch_updated_at();
create trigger trg_cms_touch before update on public.cms_connections for each row execute function public.touch_updated_at();
create trigger trg_content_touch before update on public.content_items for each row execute function public.touch_updated_at();
create trigger trg_jobs_touch before update on public.content_jobs for each row execute function public.touch_updated_at();
create trigger trg_rules_touch before update on public.automation_rules for each row execute function public.touch_updated_at();

-- Profile row for every auth user.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, coalesce(new.email, ''), new.raw_user_meta_data ->> 'full_name')
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Content state machine, hashing and approval invalidation
-- ---------------------------------------------------------------------------
create or replace function public.content_transition_allowed(from_s public.content_status, to_s public.content_status)
returns boolean language sql immutable as $$
  select from_s = to_s or (from_s, to_s) in (
    ('DRAFT', 'VALIDATING'), ('DRAFT', 'CANCELLED'),
    ('VALIDATING', 'READY_FOR_REVIEW'), ('VALIDATING', 'VALIDATION_FAILED'), ('VALIDATING', 'DRAFT'),
    ('VALIDATION_FAILED', 'DRAFT'), ('VALIDATION_FAILED', 'VALIDATING'), ('VALIDATION_FAILED', 'CANCELLED'),
    ('READY_FOR_REVIEW', 'APPROVED'), ('READY_FOR_REVIEW', 'DRAFT'), ('READY_FOR_REVIEW', 'VALIDATING'), ('READY_FOR_REVIEW', 'CANCELLED'),
    ('APPROVED', 'QUEUED'), ('APPROVED', 'DRAFT'), ('APPROVED', 'VALIDATING'), ('APPROVED', 'CANCELLED'),
    ('QUEUED', 'PUBLISHING'), ('QUEUED', 'APPROVED'), ('QUEUED', 'VALIDATION_FAILED'), ('QUEUED', 'PUBLISH_FAILED'), ('QUEUED', 'VERIFYING'), ('QUEUED', 'CANCELLED'),
    ('PUBLISHING', 'VERIFYING'), ('PUBLISHING', 'PUBLISH_FAILED'), ('PUBLISHING', 'QUEUED'),
    ('PUBLISH_FAILED', 'QUEUED'), ('PUBLISH_FAILED', 'APPROVED'), ('PUBLISH_FAILED', 'DRAFT'), ('PUBLISH_FAILED', 'CANCELLED'),
    ('VERIFYING', 'PUBLISHED'), ('VERIFYING', 'VERIFICATION_FAILED'), ('VERIFYING', 'QUEUED'),
    ('VERIFICATION_FAILED', 'VERIFYING'), ('VERIFICATION_FAILED', 'QUEUED'), ('VERIFICATION_FAILED', 'DRAFT'),
    ('PUBLISHED', 'VERIFYING'), ('PUBLISHED', 'QUEUED'), ('PUBLISHED', 'DRAFT'),
    ('CANCELLED', 'DRAFT')
  )
$$;

create or replace function public.compute_content_hash(c public.content_items)
returns text language sql immutable as $$
  select md5(concat_ws(chr(31),
    c.website_id::text, c.title, c.slug, c.body, c.body_format, c.excerpt, c.meta_title,
    c.meta_description, c.canonical_url, c.target_keyword,
    array_to_string(c.categories, ','), array_to_string(c.tags, ','),
    coalesce(c.featured_media_id::text, '')))
$$;

create or replace function public.content_before_write()
returns trigger language plpgsql as $$
begin
  new.content_hash := public.compute_content_hash(new);

  if tg_op = 'INSERT' then
    return new;
  end if;

  if not public.content_transition_allowed(old.status, new.status) then
    raise exception 'Invalid content status transition % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;

  if new.content_hash <> old.content_hash then
    if old.status in ('QUEUED', 'PUBLISHING', 'VERIFYING') then
      raise exception 'Content is locked while a publishing job is active. Cancel the job first.'
        using errcode = 'check_violation';
    end if;
    -- Material change: previous validation and approval no longer apply.
    if old.validation_status <> 'NOT_RUN' then
      new.validation_status := 'STALE';
    end if;
    if old.approved_at is not null then
      new.approved_by := null;
      new.approved_at := null;
      new.approved_hash := null;
    end if;
    if new.status in ('APPROVED', 'READY_FOR_REVIEW', 'VALIDATION_FAILED', 'PUBLISH_FAILED', 'VERIFICATION_FAILED', 'PUBLISHED', 'CANCELLED') then
      new.status := 'DRAFT';
    end if;
  end if;
  return new;
end $$;

create trigger trg_content_before_write before insert or update on public.content_items
  for each row execute function public.content_before_write();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.clients enable row level security;
alter table public.websites enable row level security;
alter table public.cms_connections enable row level security;
alter table public.content_items enable row level security;
alter table public.content_jobs enable row level security;
alter table public.qa_results enable row level security;
alter table public.automation_rules enable row level security;
alter table public.audit_logs enable row level security;
alter table public.rate_limits enable row level security; -- no policies: service role only

-- profiles: self, and co-members of any shared organization
create policy profiles_select on public.profiles for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.memberships m1 join public.memberships m2 on m1.organization_id = m2.organization_id
    where m1.user_id = auth.uid() and m2.user_id = profiles.id
  )
);
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- organizations
create policy orgs_select on public.organizations for select to authenticated using (public.is_org_member(id));
create policy orgs_update on public.organizations for update to authenticated
  using (public.has_org_role(id, '{owner}')) with check (public.has_org_role(id, '{owner}'));

-- memberships: members can see co-members; changes go through RPCs below
create policy memberships_select on public.memberships for select to authenticated using (public.is_org_member(organization_id));

-- clients
create policy clients_select on public.clients for select to authenticated using (public.is_org_member(organization_id));
create policy clients_insert on public.clients for insert to authenticated with check (public.has_org_role(organization_id, '{owner,admin}'));
create policy clients_update on public.clients for update to authenticated
  using (public.has_org_role(organization_id, '{owner,admin}')) with check (public.has_org_role(organization_id, '{owner,admin}'));
create policy clients_delete on public.clients for delete to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));

-- websites
create policy websites_select on public.websites for select to authenticated using (public.is_org_member(organization_id));
create policy websites_insert on public.websites for insert to authenticated with check (public.has_org_role(organization_id, '{owner,admin}'));
create policy websites_update on public.websites for update to authenticated
  using (public.has_org_role(organization_id, '{owner,admin}')) with check (public.has_org_role(organization_id, '{owner,admin}'));
create policy websites_delete on public.websites for delete to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));

-- cms_connections: owner/admin only. Ciphertext column is never selectable by clients (see grants).
create policy cms_select on public.cms_connections for select to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));
create policy cms_delete on public.cms_connections for delete to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));

-- content_items
create policy content_select on public.content_items for select to authenticated using (public.is_org_member(organization_id));
create policy content_insert on public.content_items for insert to authenticated with check (
  public.has_org_role(organization_id, '{owner,admin,member}') and created_by = auth.uid()
);
create policy content_update on public.content_items for update to authenticated
  using (
    public.has_org_role(organization_id, '{owner,admin}')
    or (public.has_org_role(organization_id, '{member}') and (created_by = auth.uid() or assigned_to = auth.uid()))
  )
  with check (
    public.has_org_role(organization_id, '{owner,admin}')
    or (public.has_org_role(organization_id, '{member}') and (created_by = auth.uid() or assigned_to = auth.uid()))
  );
create policy content_delete on public.content_items for delete to authenticated using (
  status not in ('QUEUED', 'PUBLISHING', 'VERIFYING') and (
    public.has_org_role(organization_id, '{owner,admin}')
    or (public.has_org_role(organization_id, '{member}') and created_by = auth.uid())
  )
);

-- jobs, QA results: read-only for members; written by RPCs and the server-side worker
create policy jobs_select on public.content_jobs for select to authenticated using (public.is_org_member(organization_id));
create policy qa_select on public.qa_results for select to authenticated using (public.is_org_member(organization_id));

-- automation rules
create policy rules_select on public.automation_rules for select to authenticated using (public.is_org_member(organization_id));
create policy rules_insert on public.automation_rules for insert to authenticated with check (public.has_org_role(organization_id, '{owner,admin}'));
create policy rules_update on public.automation_rules for update to authenticated
  using (public.has_org_role(organization_id, '{owner,admin}')) with check (public.has_org_role(organization_id, '{owner,admin}'));
create policy rules_delete on public.automation_rules for delete to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));

-- audit logs: owner/admin read; inserts only for own user in own org
create policy audit_select on public.audit_logs for select to authenticated using (public.has_org_role(organization_id, '{owner,admin}'));
create policy audit_insert on public.audit_logs for insert to authenticated with check (
  user_id = auth.uid() and public.is_org_member(organization_id)
);

-- ---------------------------------------------------------------------------
-- Column-level privileges (defence in depth on top of RLS)
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on public.cms_connections from authenticated;
grant select (id, organization_id, website_id, connection_type, metadata, connection_status, last_tested_at, last_error, created_at, updated_at)
  on public.cms_connections to authenticated;
grant delete on public.cms_connections to authenticated;

-- Workflow columns (status, approval, hashes, publish results) are not client-writable.
revoke insert, update on public.content_items from authenticated;
grant insert (organization_id, website_id, title, slug, body, body_format, excerpt, meta_title, meta_description,
  canonical_url, target_keyword, categories, tags, featured_media_id, scheduled_at, assigned_to, created_by)
  on public.content_items to authenticated;
grant update (website_id, title, slug, body, body_format, excerpt, meta_title, meta_description,
  canonical_url, target_keyword, categories, tags, featured_media_id, scheduled_at, assigned_to)
  on public.content_items to authenticated;

revoke insert, update, delete on public.content_jobs from authenticated;
revoke insert, update, delete on public.qa_results from authenticated;
revoke insert, update, delete on public.memberships from authenticated;
revoke insert, delete on public.organizations from authenticated;
revoke update on public.organizations from authenticated;
grant update (name, settings) on public.organizations to authenticated;
revoke update, delete on public.audit_logs from authenticated;
revoke update (connection_status) on public.websites from authenticated;
revoke all on public.rate_limits from authenticated;
