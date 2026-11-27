-- Install once on the registered Dev database. The watchdog exists only while an inspection wave is open.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$
BEGIN
    IF to_regclass('dev_ui.runs') IS NULL OR to_regclass('dev_live_budget.standard_owner_policy') IS NULL
        OR to_regnamespace('paid_standard_capacity') IS NOT NULL
        OR to_regprocedure('dev_cloud_six.reclaim_apify_admissions_v1(text)') IS NULL THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_WRONG_DATABASE';
    END IF;
    IF current_database() IS DISTINCT FROM coalesce(nullif(current_setting('cron.database_name',true),''),'postgres')
        OR current_setting('shared_preload_libraries') !~ '(^|,)[[:space:]]*("?\$libdir/)?pg_cron"?[[:space:]]*(,|$)'
        OR coalesce(current_setting('cron.launch_active_jobs',true),'on')='off'
        OR NOT EXISTS(SELECT FROM pg_available_extensions WHERE name='pg_cron') THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_PG_CRON_UNAVAILABLE';
    END IF;
END;
$guard$;
CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION dev_cloud_six.sync_apify_recovery_cron_v1()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $sync$
DECLARE
    job record;
    job_name constant text:='dev-cloud-six-apify-recovery-v1';
    command constant text:=$command$SET statement_timeout='8s'; SET lock_timeout='1s'; SELECT dev_cloud_six.apify_recovery_tick_v1()$command$;
    active_wave boolean;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('dev-cloud-six-registry-v1',0));
    SELECT EXISTS(SELECT FROM dev_cloud_six.waves w WHERE w.closed_at IS NULL
        AND w.expires_at>clock_timestamp()) INTO active_wave;
    SELECT j.* INTO job FROM cron.job j WHERE j.jobname=job_name AND j.username=current_user;
    IF FOUND THEN
        IF job.database IS DISTINCT FROM current_database() OR job.command IS DISTINCT FROM command
            OR job.schedule IS DISTINCT FROM '* * * * *' OR job.active IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'DEV_CLOUD_SIX_CRON_NAME_CONFLICT';
        END IF;
        IF NOT active_wave THEN PERFORM cron.unschedule(job.jobid); END IF;
    ELSIF active_wave THEN
        PERFORM cron.schedule(job_name,'* * * * *',command);
    END IF;
END;
$sync$;

CREATE OR REPLACE FUNCTION dev_cloud_six.apify_recovery_tick_v1()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $tick$
DECLARE wave text; wave_count integer;
BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtextextended('dev-cloud-six-registry-v1',0)) THEN RETURN 0; END IF;
    SELECT min(w.digest),count(*) INTO wave,wave_count FROM dev_cloud_six.waves w
        WHERE w.closed_at IS NULL AND w.expires_at>clock_timestamp();
    IF wave_count=0 THEN
        -- Disarm an abandoned wave when its three-hour registry lifetime expires.
        PERFORM dev_cloud_six.sync_apify_recovery_cron_v1();
        RETURN 0;
    ELSIF wave_count<>1 THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_WAVE_COUNT';
    END IF;
    RETURN dev_cloud_six.reclaim_apify_admissions_v1(wave);
END;
$tick$;

CREATE OR REPLACE FUNCTION dev_cloud_six.on_wave_apify_schedule_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $trigger$
BEGIN
    PERFORM dev_cloud_six.sync_apify_recovery_cron_v1();
    RETURN NULL;
END;
$trigger$;

ALTER FUNCTION dev_cloud_six.sync_apify_recovery_cron_v1() OWNER TO postgres;
ALTER FUNCTION dev_cloud_six.apify_recovery_tick_v1() OWNER TO postgres;
ALTER FUNCTION dev_cloud_six.on_wave_apify_schedule_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION dev_cloud_six.sync_apify_recovery_cron_v1(),dev_cloud_six.apify_recovery_tick_v1(),
    dev_cloud_six.on_wave_apify_schedule_v1() FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE TRIGGER dev_cloud_six_apify_cron AFTER INSERT OR UPDATE OF closed_at
    ON dev_cloud_six.waves FOR EACH ROW EXECUTE FUNCTION dev_cloud_six.on_wave_apify_schedule_v1();
SELECT dev_cloud_six.sync_apify_recovery_cron_v1();
COMMIT;
