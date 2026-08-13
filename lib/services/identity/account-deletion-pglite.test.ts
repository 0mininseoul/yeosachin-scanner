import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260812140423_add_account_deletion_lifecycle.sql',
    import.meta.url,
), 'utf8');
const hotfixMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260812153818_fix_account_deletion_preflight_scrub.sql',
    import.meta.url,
), 'utf8');
const bliteMigrationName = readdirSync(new URL('../../../supabase/migrations/', import.meta.url))
    .find(name => name.endsWith('_precheckout_blite_single_collection.sql'));
if (!bliteMigrationName) throw new Error('PRECHECKOUT_BLITE_MIGRATION_MISSING');
const bliteMigration = readFileSync(new URL(
    `../../../supabase/migrations/${bliteMigrationName}`,
    import.meta.url,
), 'utf8');
const db = await PGlite.create({ extensions: { pgcrypto } });

const owner = '6d809496-1cb8-4e4f-a081-8efc14a7a64c';
const other = '7d809496-1cb8-4e4f-a081-8efc14a7a64c';
const ownerRequest = '8d809496-1cb8-4e4f-a081-8efc14a7a64c';
const otherRequest = '9d809496-1cb8-4e4f-a081-8efc14a7a64c';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE OR REPLACE FUNCTION extensions.gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$
    SELECT '40000000-0000-4000-8000-000000000001'::uuid
$$;
CREATE TABLE public.users (
 id uuid primary key, email text not null unique, provider text not null, analysis_count int default 0,
 is_paid_user boolean default false, is_unlimited boolean default false, created_at timestamptz default now(),
 updated_at timestamptz default now(), name text, nickname text, profile_image text, phone_number text,
 phone_number_normalized text, phone_number_verification_source text, phone_number_verified_at timestamptz,
 gender text, birthyear text, account_class text not null, traffic_class text not null, lifecycle text not null
);
CREATE TABLE public.account_classification_audit (
 id bigint generated always as identity primary key, account_id uuid not null references public.users(id),
 command_version text not null, reason_code text not null, previous_account_class text not null,
 previous_traffic_class text not null, previous_lifecycle text not null, next_account_class text not null,
 next_traffic_class text not null, next_lifecycle text not null
);
CREATE TABLE public.analysis_requests (
 id uuid primary key, user_id uuid not null references public.users(id), target_instagram_id text not null,
 share_enabled boolean default false, share_token text, step_data jsonb default '{}', gender_stats jsonb default '{}',
 error_message text, progress_step text
);
CREATE TABLE public.analysis_results (id uuid primary key, request_id uuid not null references public.analysis_requests(id), suspect_instagram_id text);
CREATE TABLE public.private_accounts (id uuid primary key, request_id uuid not null references public.analysis_requests(id), instagram_id text);
CREATE TABLE public.analysis_v2_result_summaries (request_id uuid primary key references public.analysis_requests(id), target_instagram_id text);
CREATE TABLE public.analysis_v2_ai_result_checkpoints (request_id uuid references public.analysis_requests(id), operation_key text, primary key(request_id, operation_key));
CREATE TABLE public.analysis_v2_private_name_manifests (request_id uuid references public.analysis_requests(id), batch int, primary key(request_id,batch));
CREATE TABLE public.analysis_v2_narrative_manifests (request_id uuid primary key references public.analysis_requests(id));
CREATE TABLE public.analysis_v2_score_audit_intents (request_id uuid primary key references public.analysis_requests(id));
CREATE TABLE public.analysis_v2_score_audit_sources (request_id uuid references public.analysis_requests(id), source_result_hash text, primary key(request_id,source_result_hash));
CREATE TABLE public.analysis_v2_score_audit_scan_locators (request_id uuid primary key references public.analysis_requests(id));
CREATE TABLE public.analysis_v2_result_coverage_telemetry (request_id uuid primary key references public.analysis_requests(id));
CREATE TABLE public.analysis_v2_result_image_manifests (request_id uuid primary key references public.analysis_requests(id));
CREATE TABLE public.analysis_v2_result_image_objects (request_id uuid references public.analysis_requests(id), object_key text, primary key(request_id, object_key));
CREATE TABLE public.analysis_result_share_observations (id uuid primary key, request_id uuid references public.analysis_requests(id));
CREATE TABLE public.analysis_preflights (
 id uuid primary key, user_id uuid references public.users(id), target_instagram_id text not null,
 target_full_name text, target_bio text, target_profile_image_url text, excluded_instagram_id text,
 exclusion_decision text, status text not null, created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(), claimed_at timestamptz, dispatch_reserved_at timestamptz,
 dispatched_at timestamptz, exclusion_decided_at timestamptz, ready_at timestamptz, blocked_at timestamptz,
 consumed_at timestamptz, pii_scrubbed_at timestamptz, expires_at timestamptz not null default now() + interval '30 minutes',
 target_input_hash varchar(64), lease_token uuid, lease_expires_at timestamptz,
 target_followers_count integer, target_following_count integer, target_is_private boolean,
 capacity_required_plan_id text, required_plan_id text, plan_cards_snapshot jsonb,
 CONSTRAINT analysis_preflights_timestamp_order_check CHECK (
  pii_scrubbed_at IS NULL OR status IN ('expired', 'consumed')
 )
);
CREATE TABLE public.analysis_preflight_provider_runs (
 preflight_id uuid not null references public.analysis_preflights(id) on delete cascade,
 operation_key text not null default 'target-profile-fallback',
 input_hash varchar(64) not null, logical_provider text not null, status text not null, run_id varchar(64),
 primary key(preflight_id, operation_key)
);
CREATE TABLE public.precheckout_blite_cache (
 preflight_id uuid primary key references public.analysis_preflights(id) on delete cascade,
 state text not null default 'pending' check (state in ('pending', 'complete')),
 lease_token uuid not null, lease_expires_at timestamptz not null, dto jsonb,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), completed_at timestamptz,
 constraint precheckout_blite_cache_payload_check check (
  (state = 'pending' and dto is null and completed_at is null)
  or (state = 'complete' and dto is not null and completed_at is not null)
 ),
 constraint precheckout_blite_cache_timestamp_check check (
  updated_at >= created_at and lease_expires_at >= created_at
  and (completed_at is null or completed_at >= created_at)
 )
);
CREATE FUNCTION public.claim_precheckout_blite_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$
 SELECT '{"disposition":"pending"}'::jsonb
$$;
CREATE FUNCTION public.complete_precheckout_blite_v1(uuid,uuid,jsonb) RETURNS boolean LANGUAGE sql AS $$
 SELECT FALSE
$$;
CREATE FUNCTION public.release_precheckout_blite_v1(uuid,uuid) RETURNS boolean LANGUAGE sql AS $$
 SELECT FALSE
$$;
CREATE FUNCTION public.complete_analysis_v2_preflight(
 p_preflight_id uuid,p_user_id uuid,p_claim_token uuid,p_target_full_name text,p_target_bio text,
 p_target_profile_image_url text,p_target_followers_count integer,p_target_following_count integer,
 p_target_is_private boolean,p_capacity_required_plan_id text,p_required_plan_id text,p_plan_cards_snapshot jsonb
) RETURNS boolean LANGUAGE sql AS $$ SELECT TRUE $$;
CREATE FUNCTION public.complete_anonymous_analysis_v2_preflight(
 p_preflight_id uuid,p_claim_token uuid,p_target_full_name text,p_target_bio text,
 p_target_profile_image_url text,p_target_followers_count integer,p_target_following_count integer,
 p_target_is_private boolean,p_capacity_required_plan_id text,p_required_plan_id text,p_plan_cards_snapshot jsonb
) RETURNS boolean LANGUAGE sql AS $$ SELECT TRUE $$;
CREATE TABLE public.earlybird_orders (
 id uuid primary key, user_id uuid references public.users(id), target_instagram_id text not null,
 target_followers_count int not null, target_following_count int not null, exclusion_decision text not null,
 excluded_instagram_id text, expected_buyer_phone_number_normalized text,
 expected_buyer_phone_verification_source text, expected_buyer_phone_verified_at timestamptz,
 buyer_match_policy text, groble_buyer_email text, groble_buyer_phone_number text,
 groble_buyer_display_name text, disclosure_text text not null, result_request_id uuid, status text not null,
 updated_at timestamptz default now()
);
CREATE TABLE public.earlybird_waitlist (id uuid primary key, user_id uuid references public.users(id));
`);
await db.exec(migration);
await db.exec(hotfixMigration);
await db.exec(bliteMigration);

describe('account deletion migration', () => {
    afterAll(async () => db.close());

    it('retires, purges results/shares and anonymizes orders without changing payment status', async () => {
        await db.query(`INSERT INTO public.users(id,email,provider,name,phone_number,account_class,traffic_class,lifecycle)
            VALUES ($1,'owner@example.test','kakao','Owner','01012345678','production','external','active'),
                   ($2,'other@example.test','kakao','Other','01087654321','production','external','active')`, [owner, other]);
        await db.query(`INSERT INTO public.analysis_requests(id,user_id,target_instagram_id,share_enabled,share_token)
            VALUES ($1,$2,'target_owner',true,'secret'),($3,$4,'target_other',true,'other-secret')`, [ownerRequest, owner, otherRequest, other]);
        await db.query(`INSERT INTO public.analysis_results(id,request_id,suspect_instagram_id) VALUES
            ('1d809496-1cb8-4e4f-a081-8efc14a7a64c',$1,'candidate_owner'),
            ('2d809496-1cb8-4e4f-a081-8efc14a7a64c',$2,'candidate_other')`, [ownerRequest, otherRequest]);
        await db.query(`INSERT INTO public.earlybird_orders(id,user_id,target_instagram_id,target_followers_count,target_following_count,
            exclusion_decision,buyer_match_policy,groble_buyer_email,disclosure_text,status,result_request_id)
            VALUES ('3d809496-1cb8-4e4f-a081-8efc14a7a64c',$1,'target_owner',10,11,'skip','legacy_email','owner@example.test','accepted','payment_pending',$2)`, [owner, ownerRequest]);
        await db.query(`INSERT INTO public.analysis_preflights(
            id,user_id,target_instagram_id,target_full_name,target_bio,target_profile_image_url,
            exclusion_decision,status
        ) VALUES (
            '4d809496-1cb8-4e4f-a081-8efc14a7a64c',$1,'target_owner','Target','private bio',
            'https://example.test/profile.jpg','skip','pending'
        )`, [owner]);
        await db.query(`INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,input_hash,logical_provider,status,run_id
        ) VALUES (
            '4d809496-1cb8-4e4f-a081-8efc14a7a64c','target-profile-fallback',repeat('a',64),'apify','succeeded','ApifyRun123456'
        )`);
        await db.query(`INSERT INTO public.precheckout_blite_sources(
            preflight_id,schema_version,target_input_hash,provider_run_id,provider_operation_key,provider_run_reference,
            payload,payload_bytes,payload_hash,collected_at,expires_at
        ) VALUES (
            '4d809496-1cb8-4e4f-a081-8efc14a7a64c',1,repeat('a',64),
            '4d809496-1cb8-4e4f-a081-8efc14a7a64c','target-profile-fallback','ApifyRun123456','{}'::jsonb,2,$1,
            clock_timestamp(),clock_timestamp() + interval '10 minutes'
        )`, [createHash('sha256').update('{}', 'utf8').digest('hex')]);
        await db.query(`INSERT INTO public.precheckout_blite_cache(
            preflight_id,state,lease_token,lease_expires_at,attempt_count,created_at,updated_at
        ) VALUES (
            '4d809496-1cb8-4e4f-a081-8efc14a7a64c','pending',
            '40000000-0000-4000-8000-000000000002',clock_timestamp() + interval '2 minutes',
            0,clock_timestamp(),clock_timestamp()
        )`);

        await db.query(`SELECT public.begin_account_deletion_v1($1)`, [owner]);
        await db.query(`SELECT public.finalize_account_deletion_database_v1($1, '[]'::jsonb)`, [owner]);

        const account = (await db.query<{ lifecycle: string; name: string | null; phone_number: string | null }>(
            `SELECT lifecycle,name,phone_number FROM public.users WHERE id=$1`, [owner],
        )).rows[0];
        const order = (await db.query<{ status: string; target_instagram_id: string; groble_buyer_email: string | null }>(
            `SELECT status,target_instagram_id,groble_buyer_email FROM public.earlybird_orders WHERE user_id=$1`, [owner],
        )).rows[0];
        expect(account).toEqual({ lifecycle: 'retired', name: null, phone_number: null });
        expect(order).toEqual({ status: 'payment_pending', target_instagram_id: 'deleted', groble_buyer_email: null });
        expect((await db.query(`SELECT 1 FROM public.analysis_results WHERE request_id=$1`, [ownerRequest])).rows).toHaveLength(0);
        expect((await db.query(`SELECT share_token FROM public.analysis_requests WHERE id=$1`, [ownerRequest])).rows[0]).toEqual({ share_token: null });
        expect((await db.query(`SELECT suspect_instagram_id FROM public.analysis_results WHERE request_id=$1`, [otherRequest])).rows[0]).toEqual({ suspect_instagram_id: 'candidate_other' });
        expect((await db.query(`SELECT target_instagram_id,target_full_name,target_bio,target_profile_image_url,pii_scrubbed_at
            FROM public.analysis_preflights WHERE user_id=$1`, [owner])).rows[0]).toEqual({
            target_instagram_id: 'deleted',
            target_full_name: null,
            target_bio: null,
            target_profile_image_url: null,
            pii_scrubbed_at: expect.any(Date),
        });
        expect((await db.query(`SELECT
            (SELECT count(*)::int FROM public.precheckout_blite_sources
             WHERE preflight_id='4d809496-1cb8-4e4f-a081-8efc14a7a64c') AS sources,
            (SELECT count(*)::int FROM public.precheckout_blite_cache
             WHERE preflight_id='4d809496-1cb8-4e4f-a081-8efc14a7a64c') AS caches`)).rows[0])
            .toEqual({ sources: 0, caches: 0 });
    });

    it('rejects operator self-deletion', async () => {
        await db.query(`UPDATE public.users SET traffic_class='operator', lifecycle='active' WHERE id=$1`, [other]);
        await expect(db.query(`SELECT public.begin_account_deletion_v1($1)`, [other])).rejects.toThrow('ACCOUNT_DELETION_NOT_ALLOWED');
    });

    it('does not allow an active preflight to be marked scrubbed while PII remains', async () => {
        await db.query(`INSERT INTO public.analysis_preflights(
            id,user_id,target_instagram_id,target_full_name,exclusion_decision,status
        ) VALUES (
            '5d809496-1cb8-4e4f-a081-8efc14a7a64c',$1,'target_other','Other Target','skip','pending'
        )`, [other]);

        await expect(db.query(`UPDATE public.analysis_preflights
            SET pii_scrubbed_at = now() WHERE id = '5d809496-1cb8-4e4f-a081-8efc14a7a64c'`))
            .rejects.toThrow('analysis_preflights_timestamp_order_check');
    });
});
