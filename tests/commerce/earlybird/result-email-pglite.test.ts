import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const OWNER = '10000000-0000-4000-8000-000000000001';
const ORDER = '10000000-0000-4000-8000-000000000002';
const REQUEST = '10000000-0000-4000-8000-000000000003';
const TOKEN = '10000000-0000-4000-8000-000000000004';
const REFERENCE = 'ord.' + 'a'.repeat(32);

it('keeps the first signed checkout recipient through result publication and deletes it after sending', async () => {
    const db = new PGlite();
    try {
        await db.exec(`
            CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
            CREATE SCHEMA auth;
            CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, deleted_at timestamptz, email_confirmed_at timestamptz);
            CREATE TABLE auth.identities(user_id uuid, provider text, identity_data jsonb);
            CREATE TABLE public.users(id uuid PRIMARY KEY, email text, account_class text, traffic_class text, lifecycle text);
            CREATE TABLE public.earlybird_orders(
                id uuid PRIMARY KEY, user_id uuid, status text, payment_id text, paid_at timestamptz,
                seller_reference_confirmed_at timestamptz, actual_amount_krw integer, expected_amount_krw integer,
                actual_groble_product_id text, expected_groble_product_id text, groble_seller_reference text,
                result_request_id uuid, target_instagram_id text
            );
            CREATE TABLE public.earlybird_webhook_events(
                event_id text PRIMARY KEY, idempotency_key text, payment_id text, order_id uuid,
                event_type text, disposition text, amount_krw integer, product_id text
            );
            CREATE TABLE public.analysis_requests(
                id uuid PRIMARY KEY, user_id uuid, pipeline_version text, published boolean,
                status text, target_instagram_id text, completed_at timestamptz
            );
            CREATE TABLE public.earlybird_fulfillments(order_id uuid, request_id uuid, status text, completed_at timestamptz);
            CREATE TABLE public.analysis_v2_result_summaries(request_id uuid, target_instagram_id text);
            CREATE FUNCTION public.analysis_result_publication_authorized(uuid) RETURNS boolean LANGUAGE sql AS
                'SELECT published FROM public.analysis_requests WHERE id=$1';
            CREATE FUNCTION public.finalize_automatic_paid_analysis_v1(
                text,text,text,timestamptz,text,text,text,text,text,text,integer,timestamptz,text
            ) RETURNS TABLE(disposition text,order_id uuid,status text,plan_sequence smallint)
            LANGUAGE plpgsql AS $fn$
            DECLARE matching uuid;
            BEGIN
                SELECT o.id INTO matching FROM public.earlybird_orders o WHERE o.groble_seller_reference=$13;
                IF EXISTS (SELECT FROM public.earlybird_webhook_events WHERE event_id=$1) THEN
                    RETURN QUERY SELECT 'duplicate_event'::text, matching, 'paid'::text,1::smallint;
                    RETURN;
                END IF;
                INSERT INTO public.earlybird_webhook_events VALUES($1,$2,$5,matching,$3,'accepted',$11,$10);
                RETURN QUERY SELECT 'accepted'::text, matching, 'paid'::text,1::smallint;
            END; $fn$;
        `);
        for (const name of [
            '20261126100001_add_paid_result_email_outbox.sql',
            '20261128104500_use_checkout_address_for_paid_result_email.sql',
        ]) {
            await db.exec(readFileSync(`supabase/migrations/${name}`, 'utf8'));
        }
        await db.exec(`
            INSERT INTO auth.users VALUES ('${OWNER}','login@example.test',NULL,now());
            INSERT INTO public.users VALUES ('${OWNER}','login@example.test','production','external','active');
            INSERT INTO public.earlybird_orders VALUES ('${ORDER}','${OWNER}','paid','fixture-payment',now(),now(),10900,10900,
                'fixture-plus','fixture-plus','${REFERENCE}','${REQUEST}','sample_target');
            INSERT INTO public.analysis_requests VALUES ('${REQUEST}','${OWNER}','v2',false,'completed','sample_target',now());
            INSERT INTO public.earlybird_fulfillments VALUES ('${ORDER}','${REQUEST}','completed',now());
            INSERT INTO public.analysis_v2_result_summaries VALUES ('${REQUEST}','sample_target');
        `);
        const capture = (sealed: string) => db.query(`SELECT disposition FROM public.finalize_paid_analysis_with_result_email_v1(
            'event','delivery','payment.completed',now(),'fixture-payment','checkout@example.test',NULL,NULL,NULL,
            'fixture-plus',10900,now(),$1,$2)`, [REFERENCE, sealed]);
        const available = (user: string) => db.query('SELECT public.paid_result_email_available($1,$2) AS ok', [ORDER, user]);
        const claim = () => db.query('SELECT recipient, target FROM public.claim_paid_result_email($1)', [TOKEN]);
        const sendDeadline = () => db.query('SELECT public.paid_result_email_send_deadline_v1($1,$2) AS deadline', [ORDER, TOKEN]);
        const firstSealed = 'c'.repeat(260);
        expect((await available(OWNER)).rows).toEqual([{ ok: false }]);
        expect((await capture(firstSealed)).rows).toEqual([{ disposition: 'accepted' }]);
        expect((await capture('d'.repeat(60))).rows).toEqual([{ disposition: 'duplicate_event' }]);
        expect((await available(OWNER)).rows).toEqual([{ ok: true }]);
        expect((await available(TOKEN)).rows).toEqual([{ ok: false }]);
        await db.exec("UPDATE public.earlybird_orders SET status='completed'");
        expect((await claim()).rows).toEqual([]);
        await db.exec('UPDATE public.analysis_requests SET published=true');
        expect((await claim()).rows).toEqual([{ recipient: `${REFERENCE}:${firstSealed}`, target: 'sample_target' }]);
        expect((await claim()).rows).toEqual([]);
        expect((await sendDeadline()).rows).toEqual([{ deadline: expect.any(Date) }]);
        await db.exec("UPDATE public.earlybird_orders SET status='cancelled'");
        expect((await sendDeadline()).rows).toEqual([{ deadline: null }]);
        await db.exec("UPDATE public.earlybird_orders SET status='completed'");
        await db.exec('UPDATE public.paid_result_email_recipients SET expires_at=now()');
        expect((await sendDeadline()).rows).toEqual([{ deadline: null }]);
        await db.exec("UPDATE public.paid_result_email_recipients SET expires_at=now()+interval '1 hour'");
        expect((await db.query('SELECT public.finish_paid_result_email($1,$2,true) AS ok', [ORDER, TOKEN])).rows)
            .toEqual([{ ok: true }]);
        expect((await capture('e'.repeat(60))).rows).toEqual([{ disposition: 'duplicate_event' }]);
        expect((await available(OWNER)).rows).toEqual([{ ok: false }]);
        expect((await db.query<{ count: number }>('SELECT count(*)::int AS count FROM public.paid_result_email_recipients')).rows)
            .toEqual([{ count: 0 }]);
    } finally {
        await db.close();
    }
});
