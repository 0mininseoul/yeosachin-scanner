-- Forward-only repair for the isolated demo RPC.  The explicit unique constraint
-- target avoids PL/pgSQL output-column ambiguity on idempotent replays.
create or replace function public.create_demo_analysis_preflight(
  p_user_id uuid,
  p_target_instagram_id text,
  p_idempotency_key text,
  p_duration_seconds integer
) returns table (
  id uuid, user_id uuid, target_instagram_id text, fixture_version text,
  idempotency_key text, duration_seconds integer, created_at timestamptz,
  started_at timestamptz, created boolean
)
language plpgsql security definer set search_path = '' as $$
declare inserted_count integer := 0;
begin
  if p_target_instagram_id !~ '^[A-Za-z0-9._]{1,30}$'
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or p_duration_seconds not between 60 and 90 then
    raise exception 'invalid demo run input';
  end if;

  insert into public.demo_analysis_runs (
    user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds
  ) values (
    p_user_id, p_target_instagram_id, 'synthetic-fixture-v1', 'standard',
    p_idempotency_key, p_duration_seconds
  ) on conflict on constraint demo_analysis_runs_user_id_idempotency_key_key do nothing;
  get diagnostics inserted_count = row_count;

  return query
    select run.id, run.user_id, run.target_instagram_id, run.fixture_version,
      run.idempotency_key, run.duration_seconds, run.created_at, run.started_at,
      inserted_count > 0
    from public.demo_analysis_runs as run
    where run.user_id = p_user_id
      and run.idempotency_key = p_idempotency_key;
end;
$$;

revoke all on function public.create_demo_analysis_preflight(uuid, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_demo_analysis_preflight(uuid, text, text, integer)
  to service_role;
