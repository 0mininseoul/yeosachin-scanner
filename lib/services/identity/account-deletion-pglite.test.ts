import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260812140423_add_account_deletion_lifecycle.sql',
    import.meta.url,
), 'utf8');
const hotfixMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260812153818_fix_account_deletion_preflight_scrub.sql',
    import.meta.url,
), 'utf8');
const db = await PGlite.create();

const owner = '6d809496-1cb8-4e4f-a081-8efc14a7a64c';
const other = '7d809496-1cb8-4e4f-a081-8efc14a7a64c';
const ownerRequest = '8d809496-1cb8-4e4f-a081-8efc14a7a64c';
const otherRequest = '9d809496-1cb8-4e4f-a081-8efc14a7a64c';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
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
 consumed_at timestamptz, pii_scrubbed_at timestamptz,
 CONSTRAINT analysis_preflights_timestamp_order_check CHECK (
  pii_scrubbed_at IS NULL OR status IN ('expired', 'consumed')
 )
);
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
