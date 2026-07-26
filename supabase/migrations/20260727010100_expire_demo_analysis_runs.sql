-- Reject only stale unstarted demo preflights; an already-started run remains replayable.
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
    and (
      started_at IS NOT NULL
      OR created_at + interval '30 minutes' > clock_timestamp()
    )
  returning id, user_id, target_instagram_id, fixture_version, idempotency_key,
    duration_seconds, created_at, started_at;
$$;
