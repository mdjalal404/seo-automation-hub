-- Workflow RPCs. Every user-callable function re-checks auth.uid() membership
-- and role, so authorization does not depend on the UI or on the API layer.

-- Websites: connection_status is maintained by the server, not by clients.
revoke update on public.websites from authenticated;
grant update (client_id, name, base_url, timezone, publishing_settings) on public.websites to authenticated;

create or replace function public.write_audit(
  p_org uuid, p_action text, p_resource_type text, p_resource_id text, p_metadata jsonb default '{}'::jsonb
) returns void language sql security definer set search_path = public as $$
  insert into public.audit_logs (organization_id, user_id, action, resource_type, resource_id, metadata)
  values (p_org, auth.uid(), p_action, p_resource_type, p_resource_id, coalesce(p_metadata, '{}'::jsonb))
$$;
revoke execute on function public.write_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Workspaces and members
-- ---------------------------------------------------------------------------
create or replace function public.create_organization(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated' using errcode = '42501';
  end if;
  if (select count(*) from public.memberships where user_id = auth.uid() and role = 'owner') >= 10 then
    raise exception 'Workspace limit reached' using errcode = 'check_violation';
  end if;
  insert into public.organizations (name, slug, settings)
  values (trim(p_name), lower(trim(p_slug)), jsonb_build_object('minutes_saved_per_publish', 20, 'minutes_saved_per_validation', 5))
  returning id into v_org;
  insert into public.memberships (organization_id, user_id, role) values (v_org, auth.uid(), 'owner');
  insert into public.automation_rules (organization_id, name, rules_json) values (v_org, 'Workspace defaults', '{}'::jsonb);
  perform public.write_audit(v_org, 'organization.created', 'organization', v_org::text, jsonb_build_object('name', p_name));
  return v_org;
end $$;

create or replace function public.add_member_by_email(p_org uuid, p_email text, p_role public.org_role)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_id uuid;
begin
  if not public.has_org_role(p_org, '{owner}') then
    raise exception 'Only owners can manage members' using errcode = '42501';
  end if;
  select id into v_user from public.profiles where lower(email) = lower(trim(p_email));
  if v_user is null then
    raise exception 'No user with that email has signed up yet' using errcode = 'no_data_found';
  end if;
  insert into public.memberships (organization_id, user_id, role) values (p_org, v_user, p_role)
  on conflict (organization_id, user_id) do update set role = excluded.role
  returning id into v_id;
  perform public.write_audit(p_org, 'member.added', 'membership', v_id::text, jsonb_build_object('role', p_role));
  return v_id;
end $$;

create or replace function public.set_member_role(p_membership uuid, p_role public.org_role)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.memberships;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null or not public.has_org_role(m.organization_id, '{owner}') then
    raise exception 'Only owners can manage members' using errcode = '42501';
  end if;
  if m.role = 'owner' and p_role <> 'owner'
     and (select count(*) from public.memberships where organization_id = m.organization_id and role = 'owner') <= 1 then
    raise exception 'A workspace must keep at least one owner' using errcode = 'check_violation';
  end if;
  update public.memberships set role = p_role where id = p_membership;
  perform public.write_audit(m.organization_id, 'member.role_changed', 'membership', p_membership::text,
    jsonb_build_object('from', m.role, 'to', p_role));
end $$;

create or replace function public.remove_member(p_membership uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.memberships;
begin
  select * into m from public.memberships where id = p_membership;
  if m.id is null or not public.has_org_role(m.organization_id, '{owner}') then
    raise exception 'Only owners can manage members' using errcode = '42501';
  end if;
  if m.role = 'owner'
     and (select count(*) from public.memberships where organization_id = m.organization_id and role = 'owner') <= 1 then
    raise exception 'A workspace must keep at least one owner' using errcode = 'check_violation';
  end if;
  delete from public.memberships where id = p_membership;
  perform public.write_audit(m.organization_id, 'member.removed', 'membership', p_membership::text, '{}'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- Approval
-- ---------------------------------------------------------------------------
create or replace function public.approve_content(p_content uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  c public.content_items;
begin
  select * into c from public.content_items where id = p_content for update;
  if c.id is null or not public.has_org_role(c.organization_id, '{owner,admin}') then
    raise exception 'Not allowed to approve this content' using errcode = '42501';
  end if;
  if c.status <> 'READY_FOR_REVIEW' then
    raise exception 'Content must be validated and ready for review before approval (current: %)', c.status
      using errcode = 'check_violation';
  end if;
  if c.validation_status not in ('PASSED', 'PASSED_WITH_WARNINGS') or c.validated_hash is distinct from c.content_hash then
    raise exception 'Validation results are missing or out of date. Run validation again.' using errcode = 'check_violation';
  end if;
  update public.content_items
     set status = 'APPROVED', approved_by = auth.uid(), approved_at = now(), approved_hash = c.content_hash
   where id = p_content;
  perform public.write_audit(c.organization_id, 'content.approved', 'content_item', p_content::text,
    jsonb_build_object('content_hash', c.content_hash, 'validation_status', c.validation_status));
end $$;

create or replace function public.revoke_approval(p_content uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  c public.content_items;
begin
  select * into c from public.content_items where id = p_content for update;
  if c.id is null or not public.has_org_role(c.organization_id, '{owner,admin}') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if c.status <> 'APPROVED' then
    raise exception 'Only approved content that is not queued can be un-approved' using errcode = 'check_violation';
  end if;
  update public.content_items set status = 'READY_FOR_REVIEW', approved_by = null, approved_at = null, approved_hash = null
   where id = p_content;
  perform public.write_audit(c.organization_id, 'content.approval_revoked', 'content_item', p_content::text, '{}'::jsonb);
end $$;

create or replace function public.cancel_content(p_content uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  c public.content_items;
begin
  select * into c from public.content_items where id = p_content for update;
  if c.id is null or not public.has_org_role(c.organization_id, '{owner,admin}') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if c.status in ('QUEUED', 'PUBLISHING', 'VERIFYING', 'PUBLISHED') then
    raise exception 'Cancel the active job first (current: %)', c.status using errcode = 'check_violation';
  end if;
  update public.content_items set status = 'CANCELLED' where id = p_content;
  perform public.write_audit(c.organization_id, 'content.cancelled', 'content_item', p_content::text, '{}'::jsonb);
end $$;

create or replace function public.reopen_content(p_content uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  c public.content_items;
begin
  select * into c from public.content_items where id = p_content for update;
  if c.id is null or not (
    public.has_org_role(c.organization_id, '{owner,admin}')
    or (public.has_org_role(c.organization_id, '{member}') and (c.created_by = auth.uid() or c.assigned_to = auth.uid()))
  ) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if c.status not in ('CANCELLED', 'VALIDATION_FAILED', 'PUBLISH_FAILED', 'VERIFICATION_FAILED', 'PUBLISHED', 'READY_FOR_REVIEW', 'APPROVED') then
    raise exception 'Content cannot be returned to draft from %', c.status using errcode = 'check_violation';
  end if;
  update public.content_items set status = 'DRAFT', approved_by = null, approved_at = null, approved_hash = null
   where id = p_content;
  perform public.write_audit(c.organization_id, 'content.reopened', 'content_item', p_content::text,
    jsonb_build_object('from', c.status));
end $$;

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_content_job(
  p_content uuid, p_job_type public.job_type, p_request_key text, p_run_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  c public.content_items;
  w public.websites;
  v_key text;
  v_job uuid;
  v_run_at timestamptz;
begin
  if p_request_key is null or char_length(p_request_key) < 8 or char_length(p_request_key) > 200 then
    raise exception 'A request key is required for idempotency' using errcode = 'check_violation';
  end if;
  select * into c from public.content_items where id = p_content for update;
  if c.id is null or not public.is_org_member(c.organization_id) then
    raise exception 'Content not found' using errcode = '42501';
  end if;

  v_key := lower(p_job_type::text) || ':' || p_content::text || ':' || p_request_key;
  select id into v_job from public.content_jobs where organization_id = c.organization_id and idempotency_key = v_key;
  if v_job is not null then
    return v_job; -- duplicate submission: return the original job
  end if;

  select * into w from public.websites where id = c.website_id;

  if p_job_type = 'PUBLISH' then
    if not public.has_org_role(c.organization_id, '{owner,admin}') then
      raise exception 'Only owners and admins can publish' using errcode = '42501';
    end if;
    if c.status <> 'APPROVED' or c.approved_hash is distinct from c.content_hash then
      raise exception 'Content must be approved (and unchanged since approval) before publishing' using errcode = 'check_violation';
    end if;
  elsif p_job_type = 'VERIFY' then
    if not public.has_org_role(c.organization_id, '{owner,admin}') then
      raise exception 'Only owners and admins can re-verify' using errcode = '42501';
    end if;
    if c.status not in ('PUBLISHED', 'VERIFICATION_FAILED') or c.published_url is null then
      raise exception 'Only published content can be verified' using errcode = 'check_violation';
    end if;
  elsif p_job_type = 'CREATE_DRAFT' then
    if not (public.has_org_role(c.organization_id, '{owner,admin}')
            or (public.has_org_role(c.organization_id, '{member}') and (c.created_by = auth.uid() or c.assigned_to = auth.uid()))) then
      raise exception 'Not allowed to push drafts for this content' using errcode = '42501';
    end if;
    if c.status in ('QUEUED', 'PUBLISHING', 'VERIFYING', 'PUBLISHED', 'CANCELLED') then
      raise exception 'Drafts cannot be pushed while content is %', c.status using errcode = 'check_violation';
    end if;
  elsif p_job_type = 'VALIDATE' then
    if not public.has_org_role(c.organization_id, '{owner,admin,member}') then
      raise exception 'Viewers cannot run validation' using errcode = '42501';
    end if;
    if c.status in ('QUEUED', 'PUBLISHING', 'VERIFYING') then
      raise exception 'Content is locked by an active publishing job' using errcode = 'check_violation';
    end if;
  end if;

  if p_job_type in ('PUBLISH', 'CREATE_DRAFT', 'VERIFY') and w.connection_status <> 'connected' then
    raise exception 'The website connection is not healthy (%). Test or reconnect it first.', w.connection_status
      using errcode = 'check_violation';
  end if;

  v_run_at := greatest(coalesce(p_run_at, case when p_job_type = 'PUBLISH' then c.scheduled_at end, now()), now());

  insert into public.content_jobs (organization_id, website_id, content_item_id, job_type, status, idempotency_key,
    scheduled_at, run_at, max_attempts, created_by)
  values (c.organization_id, c.website_id, c.id, p_job_type, 'QUEUED', v_key,
    case when p_job_type = 'PUBLISH' then c.scheduled_at end, v_run_at,
    case when p_job_type = 'VALIDATE' then 2 else 5 end, auth.uid())
  returning id into v_job;

  if p_job_type = 'PUBLISH' then
    update public.content_items set status = 'QUEUED' where id = c.id;
  end if;

  perform public.write_audit(c.organization_id, 'job.enqueued', 'content_job', v_job::text,
    jsonb_build_object('job_type', p_job_type, 'content_item_id', c.id, 'run_at', v_run_at));
  return v_job;
end $$;

create or replace function public.cancel_job(p_job uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  j public.content_jobs;
  c public.content_items;
begin
  select * into j from public.content_jobs where id = p_job for update;
  if j.id is null or not (
    public.has_org_role(j.organization_id, '{owner,admin}')
    or (j.job_type in ('VALIDATE', 'CREATE_DRAFT') and j.created_by = auth.uid() and public.is_org_member(j.organization_id))
  ) then
    raise exception 'Not allowed to cancel this job' using errcode = '42501';
  end if;
  if j.status not in ('QUEUED', 'RETRY_SCHEDULED') then
    raise exception 'Only pending jobs can be cancelled (current: %)', j.status using errcode = 'check_violation';
  end if;
  update public.content_jobs set status = 'CANCELLED', completed_at = now(), lease_expires_at = null where id = p_job;
  if j.job_type = 'PUBLISH' then
    select * into c from public.content_items where id = j.content_item_id for update;
    if c.status = 'QUEUED' then
      update public.content_items
         set status = case when approved_hash = content_hash then 'APPROVED'::public.content_status else 'DRAFT'::public.content_status end
       where id = c.id;
    end if;
  end if;
  perform public.write_audit(j.organization_id, 'job.cancelled', 'content_job', p_job::text, jsonb_build_object('job_type', j.job_type));
end $$;

create or replace function public.retry_job(p_job uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  j public.content_jobs;
  c public.content_items;
begin
  select * into j from public.content_jobs where id = p_job for update;
  if j.id is null or not public.has_org_role(j.organization_id, '{owner,admin}') then
    raise exception 'Not allowed to retry this job' using errcode = '42501';
  end if;
  if j.status <> 'FAILED' then
    raise exception 'Only failed jobs can be retried' using errcode = 'check_violation';
  end if;
  -- Permanent content/validation problems must be fixed and re-approved, not retried.
  if coalesce(j.retryable, false) = false
     and coalesce(j.error_code, '') not in ('WP_AUTH_FAILED', 'VERIFICATION_FAILED', 'MAX_ATTEMPTS_EXCEEDED', 'LEASE_EXPIRED') then
    raise exception 'This failure (%) is not retryable. Fix the underlying problem and start a new job.', j.error_code
      using errcode = 'check_violation';
  end if;
  if j.job_type = 'PUBLISH' then
    select * into c from public.content_items where id = j.content_item_id for update;
    if c.approved_hash is distinct from c.content_hash then
      raise exception 'Content changed since approval. Re-validate and approve it again.' using errcode = 'check_violation';
    end if;
    if c.status in ('PUBLISH_FAILED', 'VERIFICATION_FAILED') then
      update public.content_items set status = 'QUEUED' where id = c.id;
    elsif c.status not in ('QUEUED') then
      raise exception 'Content is in state % and cannot be retried', c.status using errcode = 'check_violation';
    end if;
  end if;
  update public.content_jobs
     set status = 'QUEUED', run_at = now(), attempts = 0, needs_reconciliation = true,
         error_code = null, error_message = null, retryable = null, completed_at = null, lease_expires_at = null, locked_by = null
   where id = p_job;
  perform public.write_audit(j.organization_id, 'job.retried', 'content_job', p_job::text,
    jsonb_build_object('job_type', j.job_type, 'previous_error', j.error_code));
end $$;

-- ---------------------------------------------------------------------------
-- Worker-only functions (service role)
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_job(p_worker text, p_lease_seconds integer default 300, p_org uuid default null)
returns setof public.content_jobs language plpgsql security definer set search_path = public as $$
declare
  cand record;
  v_max integer;
  v_running integer;
begin
  for cand in
    select j.id, j.website_id, j.job_type
      from public.content_jobs j
     where j.status in ('QUEUED', 'RETRY_SCHEDULED') and j.run_at <= now()
       and (p_org is null or j.organization_id = p_org)
     order by j.run_at, j.created_at
     limit 25
  loop
    -- Serialize claims per website so concurrency limits hold across workers.
    if not pg_try_advisory_xact_lock(hashtextextended(cand.website_id::text, 0)) then
      continue;
    end if;
    select greatest(1, least(5, coalesce((publishing_settings ->> 'max_concurrency')::int, 1))) into v_max
      from public.websites where id = cand.website_id;
    select count(*) into v_running from public.content_jobs
     where website_id = cand.website_id and status in ('VALIDATING', 'PUBLISHING', 'VERIFYING')
       and lease_expires_at > now();
    if v_running >= coalesce(v_max, 1) then
      continue;
    end if;
    return query
      update public.content_jobs
         set status = case when job_type = 'VERIFY' then 'VERIFYING'::public.job_status else 'VALIDATING'::public.job_status end,
             attempts = attempts + 1,
             started_at = now(),
             locked_by = p_worker,
             lease_expires_at = now() + make_interval(secs => p_lease_seconds)
       where id = cand.id and status in ('QUEUED', 'RETRY_SCHEDULED')
       returning *;
    if found then
      return;
    end if;
  end loop;
  return;
end $$;

create or replace function public.reap_expired_leases()
returns integer language plpgsql security definer set search_path = public as $$
declare
  j public.content_jobs;
  n integer := 0;
begin
  for j in
    select * from public.content_jobs
     where status in ('VALIDATING', 'PUBLISHING', 'VERIFYING') and lease_expires_at < now()
     for update skip locked
  loop
    n := n + 1;
    if j.attempts >= j.max_attempts then
      update public.content_jobs
         set status = 'FAILED', completed_at = now(), error_code = 'LEASE_EXPIRED', retryable = false,
             error_message = 'The worker stopped responding while processing this job. Check WordPress before retrying.',
             lease_expires_at = null
       where id = j.id;
      if j.job_type = 'PUBLISH' then
        update public.content_items set status = 'PUBLISH_FAILED'
         where id = j.content_item_id and status in ('QUEUED', 'PUBLISHING', 'VERIFYING');
      end if;
    else
      -- Ambiguous outcome: the next attempt must reconcile with WordPress first.
      update public.content_jobs
         set status = 'RETRY_SCHEDULED', run_at = now() + interval '30 seconds', needs_reconciliation = true,
             error_code = 'LEASE_EXPIRED', error_message = 'Worker lease expired; will reconcile and retry.',
             lease_expires_at = null, locked_by = null
       where id = j.id;
      if j.job_type = 'PUBLISH' then
        update public.content_items set status = 'QUEUED'
         where id = j.content_item_id and status in ('PUBLISHING', 'VERIFYING');
      end if;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.check_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits (key, window_start, count) values (p_key, v_window, 1)
  on conflict (key, window_start) do update set count = public.rate_limits.count + 1
  returning count into v_count;
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;
  return v_count <= p_limit;
end $$;

revoke execute on function public.claim_next_job(text, integer, uuid) from public, anon, authenticated;
revoke execute on function public.reap_expired_leases() from public, anon, authenticated;
revoke execute on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_next_job(text, integer, uuid) to service_role;
grant execute on function public.reap_expired_leases() to service_role;
grant execute on function public.check_rate_limit(text, integer, integer) to service_role;

-- User RPCs: authenticated only (never anon).
do $$
declare f text;
begin
  foreach f in array array[
    'public.create_organization(text, text)',
    'public.add_member_by_email(uuid, text, public.org_role)',
    'public.set_member_role(uuid, public.org_role)',
    'public.remove_member(uuid)',
    'public.approve_content(uuid)',
    'public.revoke_approval(uuid)',
    'public.cancel_content(uuid)',
    'public.reopen_content(uuid)',
    'public.enqueue_content_job(uuid, public.job_type, text, timestamptz)',
    'public.cancel_job(uuid)',
    'public.retry_job(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
