-- Synthetic operator demonstrations are deliberately isolated from every production
-- preflight, order, provider, cost, and pipeline table.
create table public.demo_analysis_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  target_instagram_id text not null check (target_instagram_id = 'junho_dem'),
  fixture_version text not null check (fixture_version = 'synthetic-fixture-v1'),
  plan_id text not null check (plan_id = 'standard'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
  duration_seconds integer not null check (duration_seconds between 30 and 90),
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  unique (user_id, idempotency_key)
);

alter table public.demo_analysis_runs enable row level security;
revoke all on table public.demo_analysis_runs from anon, authenticated;

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
  if p_target_instagram_id <> 'junho_dem'
    or p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
    or p_duration_seconds not between 30 and 90 then
    raise exception 'invalid demo run input';
  end if;
  insert into public.demo_analysis_runs (user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds)
  values (p_user_id, p_target_instagram_id, 'synthetic-fixture-v1', 'standard', p_idempotency_key, p_duration_seconds)
  on conflict (user_id, idempotency_key) do nothing;
  get diagnostics inserted_count = row_count;
  return query
    select r.id, r.user_id, r.target_instagram_id, r.fixture_version, r.idempotency_key,
      r.duration_seconds, r.created_at, r.started_at, inserted_count > 0
    from public.demo_analysis_runs r
    where r.user_id = p_user_id and r.idempotency_key = p_idempotency_key;
end;
$$;

create or replace function public.start_demo_analysis_run(p_run_id uuid, p_user_id uuid)
returns table (
  id uuid, user_id uuid, target_instagram_id text, fixture_version text,
  idempotency_key text, duration_seconds integer, created_at timestamptz,
  started_at timestamptz
)
language sql security definer set search_path = '' as $$
  update public.demo_analysis_runs
  set started_at = coalesce(started_at, clock_timestamp())
  where id = p_run_id and user_id = p_user_id
  returning id, user_id, target_instagram_id, fixture_version, idempotency_key,
    duration_seconds, created_at, started_at;
$$;

revoke all on function public.create_demo_analysis_preflight(uuid, text, text, integer) from public, anon, authenticated;
revoke all on function public.start_demo_analysis_run(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_demo_analysis_preflight(uuid, text, text, integer) to service_role;
grant execute on function public.start_demo_analysis_run(uuid, uuid) to service_role;
