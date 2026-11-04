-- Multi-CMS support: Webflow, Shopify and the documented custom REST contract,
-- alongside WordPress.

alter table public.websites drop constraint websites_cms_type_check;
alter table public.websites add constraint websites_cms_type_check
  check (cms_type in ('wordpress', 'webflow', 'shopify', 'custom'));

alter table public.cms_connections drop constraint cms_connections_connection_type_check;
alter table public.cms_connections add constraint cms_connections_connection_type_check
  check (connection_type in ('wordpress_application_password', 'webflow_api_token', 'shopify_admin_token', 'custom_bearer_token'));

-- Owners/admins may choose the platform (RLS still limits who can update websites)...
grant update (cms_type) on public.websites to authenticated;

-- ...but a website's platform cannot change while credentials for the old platform are stored.
create or replace function public.websites_guard_cms_type()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.cms_type is distinct from old.cms_type
     and exists (select 1 from public.cms_connections where website_id = old.id) then
    raise exception 'Disconnect the CMS before changing the platform.' using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_websites_guard_cms_type before update of cms_type on public.websites
  for each row execute function public.websites_guard_cms_type();

-- The connection type must match the website's platform.
create or replace function public.cms_connections_check_type()
returns trigger language plpgsql set search_path = public as $$
declare
  t text;
  expected text;
begin
  select cms_type into t from public.websites where id = new.website_id;
  expected := case t
    when 'wordpress' then 'wordpress_application_password'
    when 'webflow' then 'webflow_api_token'
    when 'shopify' then 'shopify_admin_token'
    when 'custom' then 'custom_bearer_token'
  end;
  if new.connection_type is distinct from expected then
    raise exception 'Connection type % does not match website platform %', new.connection_type, t using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger trg_cms_connections_check_type before insert or update of connection_type, website_id on public.cms_connections
  for each row execute function public.cms_connections_check_type();

-- Manual retry: credential failures from any platform can be retried after reconnecting.
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
     and coalesce(j.error_code, '') not in ('WP_AUTH_FAILED', 'CMS_AUTH_FAILED', 'VERIFICATION_FAILED', 'MAX_ATTEMPTS_EXCEEDED', 'LEASE_EXPIRED') then
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

revoke execute on function public.retry_job(uuid) from public, anon;
grant execute on function public.retry_job(uuid) to authenticated, service_role;
