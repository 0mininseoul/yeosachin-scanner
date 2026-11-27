create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Runs as the scheduling role. The endpoint and scoped bearer are set through Vault.
create function public.cherry_threads_dispatch_tick()
returns void language plpgsql set search_path = '' as $$
declare
    local_now timestamp := now() at time zone 'Asia/Seoul';
    endpoint text;
    bearer text;
begin
    if not (
        exists (select 1 from public.cherry_threads_batches where state = 'queued'
            or (state = 'generating' and started_at < now() - interval '5 minutes'))
        or exists (
            select 1 from public.cherry_threads_preferences prefs where prefs.automatic_drafts
              and local_now::time >= make_time(prefs.draft_hour, prefs.draft_minute, 0)
              and not exists (select 1 from public.cherry_threads_batches where run_date = local_now::date)
        )
        or exists (
            select 1 from public.cherry_threads_connection c where expires_at > now()
            and (
                c.refresh_after <= now()
                or exists (select 1 from public.cherry_threads_posts p where
                    (p.state = 'scheduled' and p.scheduled_at <= now())
                    or p.state = 'publishing'
                    or (p.state = 'published' and p.reply_state in ('pending', 'sending'))
                    or (p.state = 'published' and p.media_id is not null and p.measured_at is null
                        and p.published_at <= now() - interval '24 hours'
                        and (p.insight_retry_at is null or p.insight_retry_at <= now()))
                )
            )
        )
    ) then return; end if;

    select decrypted_secret into endpoint from vault.decrypted_secrets where name = 'cherry_threads_worker_url';
    select decrypted_secret into bearer from vault.decrypted_secrets where name = 'cherry_threads_worker_secret';
    if endpoint is null or bearer is null then return; end if;
    perform net.http_post(
        url := endpoint,
        headers := jsonb_build_object('Authorization', 'Bearer ' || bearer, 'Content-Type', 'application/json'),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000
    );
end
$$;

revoke all on function public.cherry_threads_dispatch_tick() from public, anon, authenticated, service_role;

select cron.schedule('cherry-threads-20m', '*/20 * * * *', 'select public.cherry_threads_dispatch_tick()');
