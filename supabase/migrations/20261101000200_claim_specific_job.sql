-- Claim one specific queued job (used to run a user's single validation inline,
-- through the same persistent job record and processor as background jobs).
create or replace function public.claim_job(p_job uuid, p_worker text, p_lease_seconds integer default 120)
returns setof public.content_jobs language plpgsql security definer set search_path = public as $$
begin
  return query
    update public.content_jobs
       set status = case when job_type = 'VERIFY' then 'VERIFYING'::public.job_status else 'VALIDATING'::public.job_status end,
           attempts = attempts + 1,
           started_at = now(),
           locked_by = p_worker,
           lease_expires_at = now() + make_interval(secs => p_lease_seconds)
     where id = p_job and status in ('QUEUED', 'RETRY_SCHEDULED') and run_at <= now()
     returning *;
end $$;
revoke execute on function public.claim_job(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.claim_job(uuid, text, integer) to service_role;
