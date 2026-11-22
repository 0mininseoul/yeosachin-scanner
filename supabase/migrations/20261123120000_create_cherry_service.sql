-- Cherry (mutual-follow alert). Every table is server-only: RLS is enabled without
-- policies and only service_role holds grants. Nothing here touches analyzer tables.
set local lock_timeout = '5s';
set local statement_timeout = '2min';

create table public.cherry_settings (
    id boolean primary key default true check (id),
    sales_enabled boolean not null default false,
    -- Members who may check out while public sales are closed.
    tester_user_ids uuid[] not null default '{}',
    monitoring_enabled boolean not null default false,
    notifications_enabled boolean not null default false,
    ai_enabled boolean not null default true,
    auto_refund_enabled boolean not null default false,
    payment_provider text not null default 'groble' check (payment_provider in ('groble', 'toss')),
    analyzer_reserve_usd numeric(8, 2) not null default 15 check (analyzer_reserve_usd >= 0),
    max_active_runs smallint not null default 3 check (max_active_runs between 1 and 8),
    max_relationships integer not null default 1500 check (max_relationships between 100 and 5000),
    monthly_item_limit integer not null default 6000 check (monthly_item_limit between 1000 and 100000),
    check_hour_kst smallint not null default 7 check (check_hour_kst between 0 and 23),
    notify_hour_kst smallint not null default 9 check (notify_hour_kst between 8 and 20),
    apify_limit_usd numeric(10, 4),
    apify_usage_usd numeric(10, 4),
    apify_cycle_end_at timestamptz,
    apify_observed_at timestamptz,
    updated_at timestamptz not null default now(),
    updated_by uuid
);
insert into public.cherry_settings (id) values (true);

-- Prices are data so later early-bird benefits need no deploy.
create table public.cherry_offers (
    code text primary key check (code ~ '^[a-z0-9_]{2,40}$'),
    name text not null check (char_length(name) between 1 and 60),
    price_krw integer not null check (price_krw between 100 and 1000000),
    audience text not null check (audience in ('everyone', 'reservation')),
    -- Months the price stays fixed from the first payment; null means it is never locked.
    lock_months smallint check (lock_months between 1 and 24),
    active boolean not null default true,
    starts_at timestamptz,
    ends_at timestamptz,
    groble_product_id text unique,
    groble_payment_address text unique,
    updated_at timestamptz not null default now()
);
insert into public.cherry_offers (code, name, price_krw, audience, lock_months) values
    ('standard', '정가', 9900, 'everyone', null),
    ('reservation', '사전 예약 혜택', 4900, 'reservation', 12);

create table public.cherry_target_blocks (
    id uuid primary key default gen_random_uuid(),
    instagram_id text unique,
    username text not null unique check (username = lower(username)),
    note text check (char_length(note) <= 500),
    created_by uuid,
    created_at timestamptz not null default now()
);

-- Pre-payment account lookups. Public profile counts only, short-lived.
create table public.cherry_target_checks (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references public.users (id) on delete cascade,
    ip_hash text,
    username text not null check (username = lower(username) and char_length(username) between 1 and 30),
    status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
    result_code text check (result_code in
        ('ok', 'private', 'not_found', 'too_large', 'too_small', 'verified', 'blocked', 'unavailable')),
    instagram_id text,
    full_name text,
    followers_count integer,
    following_count integer,
    posts_count integer,
    profile_pic_url text,
    attempts smallint not null default 0,
    lease_token uuid,
    lease_expires_at timestamptz,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    expires_at timestamptz not null default now() + interval '2 hours'
);
create index cherry_target_checks_pending_idx on public.cherry_target_checks (created_at)
    where status in ('queued', 'running');
create index cherry_target_checks_ip_idx on public.cherry_target_checks (ip_hash, created_at);
create index cherry_target_checks_user_idx on public.cherry_target_checks (user_id);

create table public.cherry_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references public.users (id) on delete restrict,
    status text not null default 'awaiting_payment' check (status in
        ('awaiting_payment', 'preparing', 'active', 'paused', 'past_due', 'ended')),
    status_reason text,
    target_instagram_id text not null,
    target_username text not null,
    target_full_name text,
    target_profile_pic_url text,
    recipient_phone text check (recipient_phone ~ '^\+8210[0-9]{8}$'),
    recipient_email text,
    offer_code text not null references public.cherry_offers (code),
    price_krw integer not null check (price_krw > 0),
    price_lock_until timestamptz,
    payment_provider text not null check (payment_provider in ('groble', 'toss', 'grant')),
    terms_version text not null,
    terms_accepted_at timestamptz not null default now(),
    first_paid_at timestamptz,
    current_period_start timestamptz,
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    billing_next_attempt_at timestamptz,
    -- Public counts, read times, and left-out accounts of the last list of each direction.
    followers_count integer,
    following_count integer,
    followers_listed_at timestamptz,
    following_listed_at timestamptz,
    followers_gap integer not null default 0 check (followers_gap >= 0),
    following_gap integer not null default 0 check (following_gap >= 0),
    baseline_at timestamptz,
    last_checked_at timestamptz,
    next_check_at timestamptz,
    unavailable_code text check (unavailable_code in ('private', 'not_found')),
    unavailable_since timestamptz,
    items_period_start timestamptz,
    items_used integer not null default 0,
    failure_streak smallint not null default 0,
    ended_at timestamptz,
    purged_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index cherry_subscriptions_live_user_idx on public.cherry_subscriptions (user_id)
    where status in ('preparing', 'active', 'paused', 'past_due');
create unique index cherry_subscriptions_awaiting_user_idx on public.cherry_subscriptions (user_id)
    where status = 'awaiting_payment';
create index cherry_subscriptions_user_idx on public.cherry_subscriptions (user_id, created_at desc);
create index cherry_subscriptions_due_idx on public.cherry_subscriptions (next_check_at) where status = 'active';
create index cherry_subscriptions_period_idx on public.cherry_subscriptions (current_period_end)
    where status in ('active', 'past_due');
create index cherry_subscriptions_offer_idx on public.cherry_subscriptions (offer_code);

create table public.cherry_payments (
    id uuid primary key default gen_random_uuid(),
    subscription_id uuid not null references public.cherry_subscriptions (id) on delete restrict,
    user_id uuid not null references public.users (id) on delete restrict,
    cycle integer not null check (cycle >= 1),
    provider text not null check (provider in ('groble', 'toss')),
    order_ref text not null unique check (order_ref ~ '^chr_[0-9a-f]{32}$'),
    offer_code text not null references public.cherry_offers (code),
    amount_krw integer not null check (amount_krw > 0),
    status text not null default 'ready' check (status in
        ('ready', 'processing', 'paid', 'failed', 'canceled', 'review', 'partially_refunded', 'refunded')),
    review_reason text,
    provider_payment_id text unique,
    groble_product_id text,
    failure_code text,
    period_start timestamptz,
    period_end timestamptz,
    paid_at timestamptz,
    refunded_krw integer not null default 0 check (refunded_krw >= 0 and refunded_krw <= amount_krw),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create unique index cherry_payments_open_cycle_idx on public.cherry_payments (subscription_id, cycle)
    where status in ('ready', 'processing', 'paid', 'partially_refunded', 'refunded');
create index cherry_payments_user_idx on public.cherry_payments (user_id, created_at desc);
create index cherry_payments_processing_idx on public.cherry_payments (updated_at) where status = 'processing';

create table public.cherry_payment_events (
    event_id text primary key check (char_length(event_id) between 1 and 256),
    provider text not null check (provider in ('groble', 'toss')),
    event_type text not null,
    provider_payment_id text,
    order_ref text,
    amount_krw integer,
    disposition text not null,
    received_at timestamptz not null default now()
);
create index cherry_payment_events_recent_idx on public.cherry_payment_events (received_at desc);

create table public.cherry_refunds (
    id uuid primary key default gen_random_uuid(),
    payment_id uuid not null references public.cherry_payments (id) on delete restrict,
    subscription_id uuid not null references public.cherry_subscriptions (id) on delete restrict,
    amount_krw integer not null check (amount_krw > 0),
    reason text not null check (reason in ('target_private', 'target_not_found', 'target_blocked', 'baseline_failed', 'operator')),
    status text not null check (status in ('pending', 'processing', 'manual_required', 'done', 'failed')),
    failure_code text,
    requested_at timestamptz not null default now(),
    done_at timestamptz,
    updated_at timestamptz not null default now()
);
create unique index cherry_refunds_open_payment_idx on public.cherry_refunds (payment_id)
    where status in ('pending', 'processing', 'manual_required');
create index cherry_refunds_subscription_idx on public.cherry_refunds (subscription_id);

create table public.cherry_billing_keys (
    user_id uuid primary key references public.users (id) on delete cascade,
    customer_key text not null unique check (customer_key ~ '^chr_[0-9a-f]{32}$'),
    -- AES-256-GCM envelope; the plain billing key never reaches the database.
    billing_key_ciphertext text,
    card_label text check (char_length(card_label) <= 60),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- One waitlist reservation benefits one member. Contacts are compared, not copied.
create table public.cherry_reservation_claims (
    reservation_hash text primary key check (reservation_hash ~ '^[0-9a-f]{64}$'),
    user_id uuid not null unique references public.users (id) on delete cascade,
    locked_until timestamptz not null,
    created_at timestamptz not null default now()
);

create table public.cherry_capacity_waitlist (
    user_id uuid primary key references public.users (id) on delete cascade,
    created_at timestamptz not null default now(),
    notified_at timestamptz
);

create table public.cherry_checks (
    id uuid primary key default gen_random_uuid(),
    subscription_id uuid not null references public.cherry_subscriptions (id) on delete cascade,
    kind text not null check (kind in ('baseline', 'daily')),
    check_date date not null,
    status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
    run_after timestamptz not null default now(),
    attempts smallint not null default 0,
    -- Raised by an operator retry so it never reuses the data of earlier paid runs.
    series smallint not null default 0,
    lease_token uuid,
    lease_expires_at timestamptz,
    error_code text,
    items_collected integer not null default 0,
    result jsonb,
    created_at timestamptz not null default now(),
    finished_at timestamptz,
    unique (subscription_id, check_date, kind)
);
create index cherry_checks_pending_idx on public.cherry_checks (run_after) where status in ('queued', 'running');
create unique index cherry_checks_running_idx on public.cherry_checks (subscription_id) where status = 'running';

-- Paid provider starts. A row is written before the POST so a lost response is never retried blindly.
create table public.cherry_provider_runs (
    id uuid primary key default gen_random_uuid(),
    owner_key text not null check (owner_key ~ '^(check|target|report):[0-9a-f-]{36}$'),
    operation text not null check (operation ~ '^[a-z0-9_:]{2,40}$'),
    attempt smallint not null check (attempt between 1 and 5),
    subscription_id uuid references public.cherry_subscriptions (id) on delete set null,
    credential_slot text not null,
    actor_id text not null,
    requested_items integer not null check (requested_items >= 1),
    max_charge_usd numeric(12, 6) not null check (max_charge_usd > 0),
    status text not null default 'reserved' check (status in
        ('reserved', 'started', 'succeeded', 'failed', 'rejected', 'ambiguous')),
    run_id text unique,
    items_returned integer,
    estimated_cost_usd numeric(12, 6),
    error_code text,
    created_at timestamptz not null default now(),
    finished_at timestamptz,
    unique (owner_key, operation, attempt)
);
create index cherry_provider_runs_active_idx on public.cherry_provider_runs (credential_slot, created_at)
    where status in ('reserved', 'started');
create index cherry_provider_runs_recent_idx on public.cherry_provider_runs (created_at desc);
create index cherry_provider_runs_subscription_idx on public.cherry_provider_runs (subscription_id);

create table public.cherry_relations (
    subscription_id uuid not null references public.cherry_subscriptions (id) on delete cascade,
    instagram_id text not null,
    username text not null,
    full_name text,
    is_private boolean not null default false,
    is_verified boolean not null default false,
    is_follower boolean not null default false,
    is_following boolean not null default false,
    -- Set only when the account was first observed after the first list, not found late.
    follower_new_at timestamptz,
    following_new_at timestamptz,
    follower_misses smallint not null default 0,
    following_misses smallint not null default 0,
    follower_missing_since timestamptz,
    following_missing_since timestamptz,
    updated_at timestamptz not null default now(),
    primary key (subscription_id, instagram_id)
);

create table public.cherry_reports (
    id uuid primary key default gen_random_uuid(),
    subscription_id uuid not null references public.cherry_subscriptions (id) on delete cascade,
    check_id uuid not null unique references public.cherry_checks (id) on delete cascade,
    report_date date not null,
    status text not null default 'building' check (status in ('building', 'ready')),
    new_count integer not null default 0,
    attempts smallint not null default 0,
    lease_token uuid,
    lease_expires_at timestamptz,
    created_at timestamptz not null default now(),
    ready_at timestamptz
);
create index cherry_reports_subscription_idx on public.cherry_reports (subscription_id, report_date desc);
create index cherry_reports_building_idx on public.cherry_reports (created_at) where status = 'building';

create table public.cherry_mutual_events (
    id uuid primary key default gen_random_uuid(),
    subscription_id uuid not null references public.cherry_subscriptions (id) on delete cascade,
    check_id uuid not null references public.cherry_checks (id) on delete cascade,
    report_id uuid references public.cherry_reports (id) on delete cascade,
    kind text not null check (kind in ('new', 'supplement')),
    -- 'possible': an earlier list may have left this account out.
    certainty text not null default 'confirmed' check (certainty in ('confirmed', 'possible')),
    position integer not null default 0,
    instagram_id text not null,
    username text not null,
    full_name text,
    is_private boolean not null default false,
    is_verified boolean not null default false,
    detected_at timestamptz not null default now(),
    detail_status text not null default 'pending' check (detail_status in ('pending', 'done', 'failed', 'skipped')),
    profile jsonb,
    images jsonb not null default '[]'::jsonb check (jsonb_typeof(images) = 'array'),
    ai_status text not null default 'pending' check (ai_status in ('pending', 'done', 'failed', 'skipped')),
    summary jsonb,
    unique (check_id, instagram_id)
);
create index cherry_mutual_events_report_idx on public.cherry_mutual_events (report_id, position);
create index cherry_mutual_events_subscription_idx on public.cherry_mutual_events (subscription_id, detected_at desc);

create table public.cherry_notifications (
    id uuid primary key default gen_random_uuid(),
    subscription_id uuid not null references public.cherry_subscriptions (id) on delete cascade,
    kind text not null check (kind in ('new_mutual', 'baseline_ready', 'baseline_delayed', 'target_unavailable',
        'renewal_due', 'subscription_lapsed', 'payment_failed', 'price_change', 'refund_done')),
    dedupe_key text not null unique,
    report_id uuid references public.cherry_reports (id) on delete cascade,
    payload jsonb not null default '{}'::jsonb,
    send_after timestamptz not null default now(),
    status text not null default 'queued' check (status in
        ('queued', 'sending', 'sent', 'failed', 'unconfirmed', 'canceled')),
    channel text check (channel in ('alimtalk', 'sms', 'email')),
    attempts smallint not null default 0,
    lease_token uuid,
    lease_expires_at timestamptz,
    provider_message_id text,
    error_code text,
    created_at timestamptz not null default now(),
    sent_at timestamptz
);
create index cherry_notifications_pending_idx on public.cherry_notifications (send_after)
    where status in ('queued', 'sending');
create index cherry_notifications_subscription_idx on public.cherry_notifications (subscription_id, created_at desc);
create index cherry_notifications_report_idx on public.cherry_notifications (report_id);

create table public.cherry_audit_log (
    id bigint generated always as identity primary key,
    actor_id uuid,
    action text not null check (char_length(action) between 1 and 80),
    subject text check (char_length(subject) <= 200),
    detail jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Time helpers
-- ---------------------------------------------------------------------------
create function public.cherry_kst_date(p_at timestamptz) returns date
language sql immutable set search_path = '' as $$
    select (p_at at time zone 'Asia/Seoul')::date
$$;

-- Messages go out between the notify hour and 21:00 KST.
create function public.cherry_notify_at(p_at timestamptz, p_hour smallint) returns timestamptz
language sql immutable set search_path = '' as $$
    select case
        when (p_at at time zone 'Asia/Seoul')::time >= time '21:00'
            then (public.cherry_kst_date(p_at) + 1 + pg_catalog.make_time(p_hour, 0, 0)) at time zone 'Asia/Seoul'
        when (p_at at time zone 'Asia/Seoul')::time < pg_catalog.make_time(p_hour, 0, 0)
            then (public.cherry_kst_date(p_at) + pg_catalog.make_time(p_hour, 0, 0)) at time zone 'Asia/Seoul'
        else p_at
    end
$$;

-- Next day's check hour, spread over 40 minutes by subscription.
create function public.cherry_next_check_at(p_subscription uuid, p_at timestamptz, p_hour smallint) returns timestamptz
language sql immutable set search_path = '' as $$
    select (public.cherry_kst_date(p_at) + 1 + pg_catalog.make_time(p_hour, 0, 0)) at time zone 'Asia/Seoul'
        + pg_catalog.make_interval(secs => pg_catalog.abs(pg_catalog.hashtext(p_subscription::text)::bigint) % 2400)
$$;

create function public.cherry_queue_notification(
    p_subscription uuid, p_kind text, p_dedupe text, p_payload jsonb, p_report uuid default null
) returns void
language sql security definer set search_path = '' as $$
    insert into public.cherry_notifications (subscription_id, kind, dedupe_key, payload, report_id, send_after)
    select p_subscription, p_kind, p_dedupe, p_payload, p_report,
        public.cherry_notify_at(pg_catalog.now(), settings.notify_hour_kst)
    from public.cherry_settings as settings
    on conflict (dedupe_key) do nothing
$$;

-- ---------------------------------------------------------------------------
-- Offers and checkout
-- ---------------------------------------------------------------------------
create function public.cherry_reservation_hash_for(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
    select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(reservation.email, 'UTF8')), 'hex')
    from public.users as account
    join public.namchin_launch_reservations as reservation
        on reservation.phone = account.phone_number_normalized
        or reservation.email = pg_catalog.lower(pg_catalog.btrim(account.email))
    where account.id = p_user
    order by (reservation.phone = account.phone_number_normalized) desc, reservation.consented_at
    limit 1
$$;

create function public.cherry_resolve_offer(p_user uuid, p_at timestamptz default now())
returns table (code text, name text, price_krw integer, lock_months smallint, groble_product_id text,
    groble_payment_address text, locked_until timestamptz)
language sql stable security definer set search_path = '' as $$
    with mine as (
        select claim.locked_until from public.cherry_reservation_claims as claim where claim.user_id = p_user
    ), available as (
        select public.cherry_reservation_hash_for(p_user) as hash
    ), reserved as (
        select case
            when exists (select 1 from mine) then (select mine.locked_until > p_at from mine)
            when (select available.hash from available) is null then false
            else not exists (
                select 1 from public.cherry_reservation_claims as claim
                join available on claim.reservation_hash = available.hash
            )
        end as eligible
    )
    select offer.code, offer.name, offer.price_krw, offer.lock_months, offer.groble_product_id,
        offer.groble_payment_address, case when offer.audience = 'reservation' then (select mine.locked_until from mine) end
    from public.cherry_offers as offer, reserved
    where offer.active
        and (offer.starts_at is null or offer.starts_at <= p_at)
        and (offer.ends_at is null or offer.ends_at > p_at)
        and (offer.audience = 'everyone' or reserved.eligible)
    order by offer.price_krw, offer.code
    limit 1
$$;

-- Budget left for Cherry after the analyzer reserve and unfinished first lists.
create function public.cherry_available_budget_usd(p_at timestamptz default now()) returns numeric
language sql stable security definer set search_path = '' as $$
    select case
        when settings.apify_observed_at is null or settings.apify_observed_at < p_at - interval '60 minutes' then 0
        else settings.apify_limit_usd - settings.apify_usage_usd - settings.analyzer_reserve_usd
            - coalesce((
                select pg_catalog.sum((coalesce(target.followers_count, 0)
                    + coalesce(target.following_count, 0)) * 0.0007 + 0.01)
                from public.cherry_subscriptions as target
                where target.status = 'preparing'
            ), 0)
            - coalesce((
                select pg_catalog.sum(run.max_charge_usd) from public.cherry_provider_runs as run
                where run.credential_slot = 'secondary' and run.status in ('reserved', 'started')
                    and run.created_at > p_at - interval '30 minutes'
            ), 0)
    end
    from public.cherry_settings as settings
$$;

create function public.cherry_begin_checkout(p_user uuid, p_target_check uuid, p_terms_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_settings public.cherry_settings%rowtype;
    v_account public.users%rowtype;
    v_target public.cherry_target_checks%rowtype;
    v_offer record;
    v_subscription public.cherry_subscriptions%rowtype;
    v_payment public.cherry_payments%rowtype;
begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cherry-checkout:' || p_user::text, 0));
    select * into strict v_settings from public.cherry_settings;
    if not v_settings.sales_enabled and not (p_user = any (v_settings.tester_user_ids)) then
        return pg_catalog.jsonb_build_object('outcome', 'sales_closed');
    end if;
    select * into v_account from public.users where id = p_user;
    if not found or v_account.lifecycle <> 'active' then
        return pg_catalog.jsonb_build_object('outcome', 'account_unavailable');
    end if;
    if v_account.provider <> 'kakao' or v_account.phone_number_normalized is null
        or v_account.phone_number_normalized !~ '^\+8210[0-9]{8}$'
        or v_account.phone_number_verification_source is distinct from 'kakao_rest_api' then
        return pg_catalog.jsonb_build_object('outcome', 'phone_required');
    end if;
    if exists (select 1 from public.cherry_subscriptions as live where live.user_id = p_user
        and live.status in ('preparing', 'active', 'paused', 'past_due')) then
        return pg_catalog.jsonb_build_object('outcome', 'already_subscribed');
    end if;
    select * into v_target from public.cherry_target_checks where id = p_target_check;
    if not found or v_target.status <> 'done' or v_target.result_code <> 'ok' or v_target.expires_at <= v_now
        or (v_target.user_id is not null and v_target.user_id <> p_user) then
        return pg_catalog.jsonb_build_object('outcome', 'target_check_required');
    end if;
    if exists (select 1 from public.cherry_target_blocks as block
        where block.instagram_id = v_target.instagram_id or block.username = v_target.username) then
        return pg_catalog.jsonb_build_object('outcome', 'target_blocked');
    end if;
    if public.cherry_available_budget_usd(v_now)
        < (v_target.followers_count + v_target.following_count) * 0.0007 + 0.01 then
        insert into public.cherry_capacity_waitlist (user_id) values (p_user) on conflict do nothing;
        return pg_catalog.jsonb_build_object('outcome', 'capacity_wait');
    end if;
    select * into v_offer from public.cherry_resolve_offer(p_user, v_now);
    if v_offer.code is null then
        return pg_catalog.jsonb_build_object('outcome', 'sales_closed');
    end if;
    if v_settings.payment_provider = 'groble'
        and (v_offer.groble_product_id is null or v_offer.groble_payment_address is null) then
        return pg_catalog.jsonb_build_object('outcome', 'payment_unavailable');
    end if;

    insert into public.cherry_subscriptions as subscription (user_id, target_instagram_id, target_username,
        target_full_name, target_profile_pic_url, recipient_phone, recipient_email, offer_code, price_krw,
        payment_provider, terms_version, terms_accepted_at, followers_count, following_count)
    values (p_user, v_target.instagram_id, v_target.username, v_target.full_name, v_target.profile_pic_url,
        v_account.phone_number_normalized, v_account.email, v_offer.code, v_offer.price_krw,
        v_settings.payment_provider, p_terms_version, v_now, v_target.followers_count, v_target.following_count)
    on conflict (user_id) where status = 'awaiting_payment' do update set
        target_instagram_id = excluded.target_instagram_id, target_username = excluded.target_username,
        target_full_name = excluded.target_full_name, target_profile_pic_url = excluded.target_profile_pic_url,
        recipient_phone = excluded.recipient_phone, recipient_email = excluded.recipient_email,
        offer_code = excluded.offer_code, price_krw = excluded.price_krw,
        payment_provider = excluded.payment_provider, terms_version = excluded.terms_version,
        terms_accepted_at = excluded.terms_accepted_at, followers_count = excluded.followers_count,
        following_count = excluded.following_count, updated_at = v_now
    returning * into v_subscription;
    update public.cherry_target_checks set user_id = p_user where id = p_target_check;

    -- The order keeps its identity while price, product, and provider are unchanged.
    select * into v_payment from public.cherry_payments as payment
    where payment.subscription_id = v_subscription.id and payment.status in ('ready', 'processing') for update;
    if found and v_payment.status = 'processing' then
        return pg_catalog.jsonb_build_object('outcome', 'payment_in_progress');
    end if;
    if found and (v_payment.amount_krw <> v_offer.price_krw or v_payment.provider <> v_settings.payment_provider
        or v_payment.groble_product_id is distinct from
            case when v_settings.payment_provider = 'groble' then v_offer.groble_product_id end) then
        update public.cherry_payments set status = 'canceled', failure_code = 'superseded', updated_at = v_now
        where id = v_payment.id;
        v_payment := null;
    end if;
    if v_payment.id is null then
        insert into public.cherry_payments (subscription_id, user_id, cycle, provider, order_ref, offer_code,
            amount_krw, groble_product_id)
        values (v_subscription.id, p_user, 1, v_settings.payment_provider,
            'chr_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), v_offer.code, v_offer.price_krw,
            case when v_settings.payment_provider = 'groble' then v_offer.groble_product_id end)
        returning * into v_payment;
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ready', 'subscriptionId', v_subscription.id,
        'paymentId', v_payment.id, 'orderRef', v_payment.order_ref, 'amountKrw', v_payment.amount_krw,
        'provider', v_payment.provider, 'grobleAddress', v_offer.groble_payment_address);
end;
$$;

-- An operator-granted month for verification or support. It ends by itself and is never billed.
create function public.cherry_grant(p_user uuid, p_target_check uuid, p_terms_version text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_account public.users%rowtype;
    v_target public.cherry_target_checks%rowtype;
    v_subscription uuid;
begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cherry-checkout:' || p_user::text, 0));
    select * into v_account from public.users where id = p_user;
    select * into v_target from public.cherry_target_checks where id = p_target_check;
    if v_account.id is null or v_account.lifecycle <> 'active' or v_target.status is distinct from 'done'
        or v_target.result_code is distinct from 'ok' then
        return pg_catalog.jsonb_build_object('outcome', 'invalid');
    end if;
    if exists (select 1 from public.cherry_subscriptions as live where live.user_id = p_user
        and live.status in ('preparing', 'active', 'paused', 'past_due')) then
        return pg_catalog.jsonb_build_object('outcome', 'already_subscribed');
    end if;
    insert into public.cherry_subscriptions (user_id, status, target_instagram_id, target_username, target_full_name,
        target_profile_pic_url, recipient_phone, recipient_email, offer_code, price_krw, payment_provider, terms_version,
        first_paid_at, cancel_at_period_end, followers_count, following_count)
    values (p_user, 'preparing', v_target.instagram_id, v_target.username, v_target.full_name, v_target.profile_pic_url,
        case when v_account.phone_number_normalized ~ '^\+8210[0-9]{8}$' then v_account.phone_number_normalized end,
        v_account.email, 'standard', (select offer.price_krw from public.cherry_offers as offer where offer.code = 'standard'),
        'grant', p_terms_version, v_now, true, v_target.followers_count, v_target.following_count)
    returning id into v_subscription;
    insert into public.cherry_checks (subscription_id, kind, check_date)
    values (v_subscription, 'baseline', public.cherry_kst_date(v_now));
    return pg_catalog.jsonb_build_object('outcome', 'granted', 'subscriptionId', v_subscription);
end;
$$;

-- A renewal order for a one-time pass, a switch to automatic billing, or a retry with another card.
create function public.cherry_begin_renewal(p_user uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_settings public.cherry_settings%rowtype;
    v_subscription public.cherry_subscriptions%rowtype;
    v_offer public.cherry_offers%rowtype;
    v_payment public.cherry_payments%rowtype;
    v_provider text;
    v_product text;
    v_cycle integer;
begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cherry-checkout:' || p_user::text, 0));
    select * into strict v_settings from public.cherry_settings;
    select * into v_subscription from public.cherry_subscriptions
    where user_id = p_user and status in ('active', 'past_due') for update;
    if not found or v_subscription.payment_provider = 'grant' then
        return pg_catalog.jsonb_build_object('outcome', 'not_renewable');
    end if;
    if exists (select 1 from public.cherry_payments where subscription_id = v_subscription.id and status = 'processing') then
        return pg_catalog.jsonb_build_object('outcome', 'payment_in_progress');
    end if;
    -- An active automatic plan only replaces its card; nothing is charged now.
    if v_subscription.payment_provider = 'toss' and v_subscription.status = 'active' then
        return pg_catalog.jsonb_build_object('outcome', 'ready', 'provider', 'toss', 'amountKrw', 0);
    end if;
    if v_subscription.current_period_end > v_now + interval '7 days' then
        return pg_catalog.jsonb_build_object('outcome', 'not_renewable');
    end if;
    v_provider := case when v_subscription.payment_provider = 'toss' then 'toss' else v_settings.payment_provider end;
    if v_subscription.price_lock_until > v_now then
        select * into v_offer from public.cherry_offers where code = v_subscription.offer_code;
    else
        select * into v_offer from public.cherry_offers where code = 'standard';
    end if;
    if v_provider = 'groble' then
        if v_offer.groble_product_id is null or v_offer.groble_payment_address is null then
            return pg_catalog.jsonb_build_object('outcome', 'payment_unavailable');
        end if;
        v_product := v_offer.groble_product_id;
    end if;
    select coalesce(pg_catalog.max(payment.cycle), 0) + 1 into v_cycle
    from public.cherry_payments as payment where payment.subscription_id = v_subscription.id
        and payment.status in ('paid', 'partially_refunded', 'refunded', 'review');
    select * into v_payment from public.cherry_payments
    where subscription_id = v_subscription.id and cycle = v_cycle and status = 'ready' for update;
    if found and (v_payment.provider <> v_provider or v_payment.groble_product_id is distinct from v_product
        or v_payment.amount_krw <> v_offer.price_krw) then
        update public.cherry_payments set status = 'canceled', failure_code = 'superseded', updated_at = v_now
        where id = v_payment.id;
        v_payment := null;
    end if;
    if v_payment.id is null then
        insert into public.cherry_payments (subscription_id, user_id, cycle, provider, order_ref, offer_code,
            amount_krw, groble_product_id)
        values (v_subscription.id, p_user, v_cycle, v_provider,
            'chr_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), v_offer.code,
            v_offer.price_krw, v_product)
        returning * into v_payment;
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ready', 'subscriptionId', v_subscription.id,
        'paymentId', v_payment.id, 'orderRef', v_payment.order_ref, 'amountKrw', v_payment.amount_krw,
        'provider', v_provider, 'grobleAddress', v_offer.groble_payment_address);
end;
$$;

create function public.cherry_apply_paid(p_payment uuid, p_provider_payment_id text, p_paid_at timestamptz) returns text
language plpgsql security definer set search_path = '' as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_payment public.cherry_payments%rowtype;
    v_subscription public.cherry_subscriptions%rowtype;
    v_offer public.cherry_offers%rowtype;
    v_hash text;
    v_start timestamptz;
    v_review text;
begin
    select * into strict v_payment from public.cherry_payments where id = p_payment for update;
    select * into strict v_subscription from public.cherry_subscriptions where id = v_payment.subscription_id for update;
    select * into strict v_offer from public.cherry_offers where code = v_payment.offer_code;
    if v_payment.status not in ('ready', 'processing') then
        v_review := 'order_closed';
    elsif v_subscription.status = 'ended' then
        v_review := 'subscription_ended';
    elsif v_subscription.status = 'awaiting_payment' and exists (
        select 1 from public.cherry_subscriptions as live where live.user_id = v_subscription.user_id
            and live.status in ('preparing', 'active', 'paused', 'past_due')) then
        v_review := 'already_subscribed';
    end if;
    if v_review is not null then
        update public.cherry_payments set status = 'review', review_reason = v_review,
            provider_payment_id = p_provider_payment_id, paid_at = p_paid_at, updated_at = v_now
        where id = v_payment.id;
        return 'review';
    end if;

    if v_subscription.status = 'awaiting_payment' then
        update public.cherry_payments set status = 'paid', provider_payment_id = p_provider_payment_id,
            paid_at = p_paid_at, updated_at = v_now where id = v_payment.id;
        if v_offer.audience = 'reservation' then
            v_hash := public.cherry_reservation_hash_for(v_subscription.user_id);
            if v_hash is not null then
                insert into public.cherry_reservation_claims (reservation_hash, user_id, locked_until)
                values (v_hash, v_subscription.user_id,
                    p_paid_at + pg_catalog.make_interval(months => coalesce(v_offer.lock_months, 0)))
                on conflict do nothing;
            end if;
        end if;
        update public.cherry_subscriptions set status = 'preparing', status_reason = null, first_paid_at = p_paid_at,
            offer_code = v_payment.offer_code, price_krw = v_payment.amount_krw,
            payment_provider = v_payment.provider,
            price_lock_until = case when v_offer.lock_months is not null then coalesce(
                (select claim.locked_until from public.cherry_reservation_claims as claim
                    where v_offer.audience = 'reservation' and claim.user_id = v_subscription.user_id),
                p_paid_at + pg_catalog.make_interval(months => v_offer.lock_months)) end,
            updated_at = v_now
        where id = v_subscription.id;
        insert into public.cherry_checks (subscription_id, kind, check_date)
        values (v_subscription.id, 'baseline', public.cherry_kst_date(v_now))
        on conflict (subscription_id, check_date, kind) do update set status = 'queued', run_after = v_now, error_code = null
        where public.cherry_checks.status = 'failed';
        return 'activated';
    end if;

    v_start := greatest(coalesce(v_subscription.current_period_end, v_now), v_now);
    update public.cherry_payments set status = 'paid', provider_payment_id = p_provider_payment_id, paid_at = p_paid_at,
        period_start = v_start, period_end = v_start + interval '1 month', updated_at = v_now
    where id = v_payment.id;
    update public.cherry_subscriptions set status = case when status = 'past_due' then 'active' else status end,
        status_reason = null, current_period_start = v_start, current_period_end = v_start + interval '1 month',
        offer_code = v_payment.offer_code, price_krw = v_payment.amount_krw, payment_provider = v_payment.provider,
        cancel_at_period_end = false, billing_next_attempt_at = null,
        -- A lapsed pass missed days, so the next check reads both lists again.
        followers_listed_at = case when status = 'past_due' then null else followers_listed_at end,
        following_listed_at = case when status = 'past_due' then null else following_listed_at end,
        next_check_at = case when status = 'past_due' then v_now else next_check_at end, updated_at = v_now
    where id = v_subscription.id;
    return 'renewed';
end;
$$;

create function public.cherry_record_payment(
    p_event_id text, p_provider text, p_order_ref text, p_provider_payment_id text, p_product_id text,
    p_amount_krw integer, p_paid_at timestamptz, p_buyer_phone text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_payment public.cherry_payments%rowtype;
    v_disposition text;
    v_candidates integer;
begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cherry-payment:' || p_provider_payment_id, 0));
    if exists (select 1 from public.cherry_payment_events where event_id = p_event_id) then
        return pg_catalog.jsonb_build_object('disposition', 'duplicate_event');
    end if;
    select * into v_payment from public.cherry_payments where provider_payment_id = p_provider_payment_id;
    if found then
        v_disposition := 'duplicate_payment';
    else
        if p_order_ref is not null then
            select * into v_payment from public.cherry_payments where order_ref = p_order_ref and provider = p_provider for update;
        else
            -- Fallback for a checkout that lost its reference: exactly one open order for this phone and product.
            select pg_catalog.count(*) into v_candidates from public.cherry_payments as payment
            join public.cherry_subscriptions as subscription on subscription.id = payment.subscription_id
            where payment.provider = p_provider and payment.status = 'ready'
                and payment.groble_product_id = p_product_id and subscription.recipient_phone = p_buyer_phone
                and payment.created_at > pg_catalog.now() - interval '3 days';
            if v_candidates = 1 then
                select payment.* into v_payment from public.cherry_payments as payment
                join public.cherry_subscriptions as subscription on subscription.id = payment.subscription_id
                where payment.provider = p_provider and payment.status = 'ready'
                    and payment.groble_product_id = p_product_id and subscription.recipient_phone = p_buyer_phone
                    and payment.created_at > pg_catalog.now() - interval '3 days'
                for update of payment;
            end if;
        end if;
        if v_payment.id is null then
            v_disposition := 'unmatched';
        elsif v_payment.provider_payment_id is not null then
            -- A second charge for an order that already has one.
            v_disposition := 'unmatched';
        elsif v_payment.amount_krw <> p_amount_krw
            or (p_provider = 'groble' and v_payment.groble_product_id is distinct from p_product_id) then
            update public.cherry_payments set status = 'review', review_reason = 'amount_or_product_mismatch',
                provider_payment_id = p_provider_payment_id, paid_at = p_paid_at, updated_at = pg_catalog.now()
            where id = v_payment.id;
            v_disposition := 'review';
        else
            v_disposition := public.cherry_apply_paid(v_payment.id, p_provider_payment_id, p_paid_at);
        end if;
    end if;
    insert into public.cherry_payment_events (event_id, provider, event_type, provider_payment_id, order_ref, amount_krw, disposition)
    values (p_event_id, p_provider, 'payment.completed', p_provider_payment_id, p_order_ref, p_amount_krw, v_disposition);
    return pg_catalog.jsonb_build_object('disposition', v_disposition, 'subscriptionId', v_payment.subscription_id);
end;
$$;

create function public.cherry_record_refund(
    p_event_id text, p_provider text, p_provider_payment_id text, p_amount_krw integer, p_partial boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_payment public.cherry_payments%rowtype;
    v_refunded integer;
    v_disposition text;
    v_latest integer;
begin
    if exists (select 1 from public.cherry_payment_events where event_id = p_event_id) then
        return pg_catalog.jsonb_build_object('disposition', 'duplicate_event');
    end if;
    select * into v_payment from public.cherry_payments
    where provider = p_provider and provider_payment_id = p_provider_payment_id for update;
    if not found then
        v_disposition := 'unmatched';
    else
        v_refunded := case when p_partial
            then least(v_payment.amount_krw, v_payment.refunded_krw + p_amount_krw) else v_payment.amount_krw end;
        update public.cherry_payments set refunded_krw = v_refunded,
            status = case when v_refunded >= amount_krw then 'refunded' else 'partially_refunded' end,
            updated_at = pg_catalog.now()
        where id = v_payment.id;
        update public.cherry_refunds set status = 'done', done_at = pg_catalog.now(), updated_at = pg_catalog.now()
        where payment_id = v_payment.id and status in ('pending', 'processing', 'manual_required');
        -- A full refund of the newest cycle ends the service it paid for.
        select pg_catalog.max(payment.cycle) into v_latest from public.cherry_payments as payment
        where payment.subscription_id = v_payment.subscription_id and payment.paid_at is not null;
        if v_refunded >= v_payment.amount_krw and v_payment.cycle = v_latest then
            update public.cherry_subscriptions set status = 'ended', status_reason = 'refunded',
                ended_at = pg_catalog.now(), updated_at = pg_catalog.now()
            where id = v_payment.subscription_id and status <> 'ended';
        end if;
        v_disposition := case when v_refunded >= v_payment.amount_krw then 'refunded' else 'partially_refunded' end;
    end if;
    insert into public.cherry_payment_events (event_id, provider, event_type, provider_payment_id, amount_krw, disposition)
    values (p_event_id, p_provider, 'payment.refunded', p_provider_payment_id, p_amount_krw, v_disposition);
    return pg_catalog.jsonb_build_object('disposition', v_disposition, 'subscriptionId', v_payment.subscription_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Service end and refunds
-- ---------------------------------------------------------------------------
create function public.cherry_end_with_refund(p_subscription uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_subscription public.cherry_subscriptions%rowtype;
    v_payment public.cherry_payments%rowtype;
    v_amount integer;
    v_total integer := 0;
    v_total_seconds numeric;
begin
    select * into strict v_subscription from public.cherry_subscriptions where id = p_subscription for update;
    if v_subscription.status not in ('preparing', 'active', 'paused', 'past_due') then
        return pg_catalog.jsonb_build_object('ended', false);
    end if;
    update public.cherry_subscriptions set status = 'ended', status_reason = p_reason, ended_at = v_now,
        next_check_at = null, updated_at = v_now where id = p_subscription;
    update public.cherry_checks set status = 'failed', error_code = 'subscription_ended', finished_at = v_now,
        lease_token = null, lease_expires_at = null
    where subscription_id = p_subscription and status = 'queued';
    update public.cherry_payments set status = 'canceled', failure_code = 'subscription_ended', updated_at = v_now
    where subscription_id = p_subscription and status = 'ready';

    -- An early renewal leaves two paid periods open, so each one is refunded for its own unused part.
    for v_payment in
        select * from public.cherry_payments where subscription_id = p_subscription
            and status in ('paid', 'partially_refunded') and paid_at is not null order by cycle for update
    loop
        v_amount := 0;
        if v_subscription.baseline_at is null then
            v_amount := v_payment.amount_krw - v_payment.refunded_krw;
        elsif v_payment.period_end > v_now then
            v_total_seconds := extract(epoch from v_payment.period_end - v_payment.period_start);
            v_amount := least(v_payment.amount_krw - v_payment.refunded_krw, pg_catalog.floor(v_payment.amount_krw
                * extract(epoch from v_payment.period_end - greatest(v_now, v_payment.period_start)) / v_total_seconds)::integer);
        end if;
        if v_amount > 0 then
            insert into public.cherry_refunds (payment_id, subscription_id, amount_krw, reason, status)
            values (v_payment.id, p_subscription, v_amount, p_reason,
                case when v_payment.provider = 'groble' then 'manual_required' else 'pending' end)
            on conflict do nothing;
            v_total := v_total + v_amount;
        end if;
    end loop;
    return pg_catalog.jsonb_build_object('ended', true, 'refundKrw', v_total);
end;
$$;

-- A member stops or resumes the next charge, or cancels a service that never started.
create function public.cherry_member_action(p_user uuid, p_action text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_subscription public.cherry_subscriptions%rowtype;
begin
    select * into v_subscription from public.cherry_subscriptions
    where user_id = p_user and status in ('preparing', 'active', 'past_due') for update;
    if not found then return pg_catalog.jsonb_build_object('outcome', 'not_found'); end if;
    if p_action = 'cancel' and v_subscription.status in ('active', 'past_due') then
        update public.cherry_subscriptions set cancel_at_period_end = true, updated_at = pg_catalog.now()
        where id = v_subscription.id;
        return pg_catalog.jsonb_build_object('outcome', 'done');
    elsif p_action = 'resume' and v_subscription.status = 'active' and v_subscription.payment_provider <> 'grant'
        and v_subscription.current_period_end > pg_catalog.now() then
        update public.cherry_subscriptions set cancel_at_period_end = false, updated_at = pg_catalog.now()
        where id = v_subscription.id;
        return pg_catalog.jsonb_build_object('outcome', 'done');
    elsif p_action = 'cancel_preparing' and v_subscription.status = 'preparing'
        and v_subscription.first_paid_at <= pg_catalog.now() - interval '24 hours' then
        return public.cherry_end_with_refund(v_subscription.id, 'baseline_failed') || pg_catalog.jsonb_build_object('outcome', 'done');
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'not_allowed');
end;
$$;

-- ---------------------------------------------------------------------------
-- Pre-payment account lookup
-- ---------------------------------------------------------------------------
create function public.cherry_request_target_check(
    p_username text, p_user uuid, p_ip_hash text, p_ip_daily_limit integer, p_total_daily_limit integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_row public.cherry_target_checks%rowtype;
begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cherry-target-checks', 0));
    -- A recent public lookup is reused instead of paying for the same profile again.
    select * into v_row from public.cherry_target_checks as recent
    where recent.username = p_username and recent.created_at > pg_catalog.now() - interval '30 minutes'
        and (recent.status in ('queued', 'running') or (recent.status = 'done' and recent.result_code = 'ok'))
        and ((p_user is not null and recent.user_id = p_user) or (recent.user_id is null and recent.ip_hash = p_ip_hash))
    order by recent.created_at desc limit 1;
    if found then
        return pg_catalog.jsonb_build_object('outcome', 'accepted', 'id', v_row.id, 'created', false);
    end if;
    if (select pg_catalog.count(*) from public.cherry_target_checks
        where ip_hash = p_ip_hash and created_at > pg_catalog.now() - interval '1 day') >= p_ip_daily_limit
        or (select pg_catalog.count(*) from public.cherry_target_checks
            where created_at > pg_catalog.now() - interval '1 day') >= p_total_daily_limit then
        return pg_catalog.jsonb_build_object('outcome', 'limited');
    end if;
    insert into public.cherry_target_checks (username, user_id, ip_hash) values (p_username, p_user, p_ip_hash)
    returning * into v_row;
    return pg_catalog.jsonb_build_object('outcome', 'accepted', 'id', v_row.id, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Checks
-- ---------------------------------------------------------------------------
create function public.cherry_enqueue_due(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_settings public.cherry_settings%rowtype;
    v_checks integer := 0;
    v_row record;
begin
    select * into strict v_settings from public.cherry_settings;
    -- Period ends are processed even while monitoring is off.
    for v_row in
        select subscription.* from public.cherry_subscriptions as subscription
        where subscription.status = 'active' and subscription.current_period_end <= p_now
            and (subscription.payment_provider = 'groble' or subscription.cancel_at_period_end)
        for update skip locked limit 200
    loop
        if v_row.cancel_at_period_end then
            update public.cherry_subscriptions set status = 'ended', status_reason = 'canceled', ended_at = p_now,
                next_check_at = null, updated_at = p_now where id = v_row.id;
        else
            update public.cherry_subscriptions set status = 'past_due', status_reason = 'renewal_required',
                updated_at = p_now where id = v_row.id;
            perform public.cherry_queue_notification(v_row.id, 'subscription_lapsed',
                'lapsed:' || v_row.id::text || ':' || v_row.current_period_end::date::text, '{}'::jsonb);
        end if;
    end loop;
    update public.cherry_subscriptions set status = 'ended', status_reason = 'payment_lapsed', ended_at = p_now,
        next_check_at = null, updated_at = p_now
    where status = 'past_due' and current_period_end <= p_now - interval '4 days'
        -- A charge with an unknown outcome must be settled before the service ends.
        and not exists (select 1 from public.cherry_payments as payment
            where payment.subscription_id = public.cherry_subscriptions.id and payment.status = 'processing');
    for v_row in
        select subscription.id, subscription.current_period_end, subscription.price_lock_until
        from public.cherry_subscriptions as subscription
        where subscription.status = 'active' and subscription.payment_provider = 'groble'
            and not subscription.cancel_at_period_end
            and subscription.current_period_end between p_now and p_now + interval '3 days'
    loop
        perform public.cherry_queue_notification(v_row.id, 'renewal_due',
            'renewal:' || v_row.id::text || ':' || v_row.current_period_end::date::text,
            pg_catalog.jsonb_build_object('periodEnd', v_row.current_period_end));
    end loop;
    -- The locked price ends with this period: tell the member before the next charge.
    for v_row in
        select subscription.id, subscription.current_period_end, offer.price_krw
        from public.cherry_subscriptions as subscription
        join public.cherry_offers as offer on offer.code = 'standard'
        where subscription.status = 'active' and not subscription.cancel_at_period_end
            and subscription.price_lock_until <= subscription.current_period_end
            and subscription.price_krw <> offer.price_krw
            and subscription.current_period_end between p_now and p_now + interval '7 days'
    loop
        perform public.cherry_queue_notification(v_row.id, 'price_change',
            'price:' || v_row.id::text || ':' || v_row.current_period_end::date::text,
            pg_catalog.jsonb_build_object('periodEnd', v_row.current_period_end, 'priceKrw', v_row.price_krw));
    end loop;
    for v_row in
        select subscription.id from public.cherry_subscriptions as subscription
        where subscription.status = 'preparing' and subscription.first_paid_at <= p_now - interval '24 hours'
    loop
        perform public.cherry_queue_notification(v_row.id, 'baseline_delayed', 'baseline-delayed:' || v_row.id::text, '{}'::jsonb);
    end loop;

    if v_settings.monitoring_enabled then
        for v_row in
            select subscription.id from public.cherry_subscriptions as subscription
            where subscription.status = 'active' and subscription.next_check_at <= p_now
                and subscription.current_period_end > p_now
            order by subscription.next_check_at
            for update skip locked limit 500
        loop
            insert into public.cherry_checks (subscription_id, kind, check_date)
            values (v_row.id, 'daily', public.cherry_kst_date(p_now))
            on conflict do nothing;
            update public.cherry_subscriptions set updated_at = p_now,
                next_check_at = public.cherry_next_check_at(v_row.id, p_now, v_settings.check_hour_kst)
            where id = v_row.id;
            v_checks := v_checks + 1;
        end loop;
    end if;
    return pg_catalog.jsonb_build_object('checks', v_checks);
end;
$$;

create function public.cherry_claim_checks(p_limit integer, p_lease_seconds integer)
returns setof public.cherry_checks
language plpgsql security definer set search_path = '' as $$
declare
    v_candidate uuid;
    v_check public.cherry_checks%rowtype;
begin
    if not (select settings.monitoring_enabled from public.cherry_settings as settings) then return; end if;
    update public.cherry_checks set status = 'failed', error_code = coalesce(error_code, 'attempts_exhausted'),
        finished_at = pg_catalog.now(), lease_token = null, lease_expires_at = null
    where attempts >= 12 and (status = 'queued' or (status = 'running' and lease_expires_at < pg_catalog.now()));
    -- Yesterday's check says nothing new; a change it missed is found by today's.
    update public.cherry_checks set status = 'failed', error_code = coalesce(error_code, 'expired'),
        finished_at = pg_catalog.now(), lease_token = null, lease_expires_at = null
    where kind = 'daily' and created_at < pg_catalog.now() - interval '20 hours'
        and (status = 'queued' or (status = 'running' and lease_expires_at < pg_catalog.now()));
    for v_candidate in
        select candidate.id from public.cherry_checks as candidate
        join public.cherry_subscriptions as subscription on subscription.id = candidate.subscription_id
        where ((candidate.status = 'queued' and candidate.run_after <= pg_catalog.now())
                or (candidate.status = 'running' and candidate.lease_expires_at < pg_catalog.now()))
            and subscription.status in ('preparing', 'active')
            and not exists (select 1 from public.cherry_checks as busy
                where busy.subscription_id = candidate.subscription_id and busy.status = 'running' and busy.id <> candidate.id)
        order by (candidate.kind = 'baseline') desc, candidate.run_after
        limit p_limit
        for update of candidate skip locked
    loop
        begin
            update public.cherry_checks set status = 'running', attempts = attempts + 1,
                lease_token = pg_catalog.gen_random_uuid(),
                lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds)
            where id = v_candidate returning * into v_check;
            return next v_check;
        exception when unique_violation then
            -- Another check of this subscription started first.
            null;
        end;
    end loop;
end;
$$;

create function public.cherry_defer_check(
    p_check uuid, p_lease uuid, p_error text, p_delay_seconds integer, p_terminal boolean, p_count_attempt boolean default true
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
    v_subscription uuid;
begin
    update public.cherry_checks set status = case when p_terminal then 'failed' else 'queued' end, error_code = p_error,
        run_after = pg_catalog.now() + pg_catalog.make_interval(secs => p_delay_seconds),
        attempts = case when p_count_attempt then attempts else greatest(attempts - 1, 0) end,
        finished_at = case when p_terminal then pg_catalog.now() end, lease_token = null, lease_expires_at = null
    where id = p_check and status = 'running' and lease_token = p_lease
    returning subscription_id into v_subscription;
    if v_subscription is null then return false; end if;
    if p_terminal then
        update public.cherry_subscriptions set failure_streak = least(failure_streak + 1, 1000), updated_at = pg_catalog.now()
        where id = v_subscription;
    end if;
    return true;
end;
$$;

-- An operator looks again now: the unfinished first list, or today's check.
create function public.cherry_operator_requeue(p_subscription uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_subscription public.cherry_subscriptions%rowtype;
    v_check uuid;
begin
    select * into v_subscription from public.cherry_subscriptions where id = p_subscription for update;
    if not found or v_subscription.status not in ('preparing', 'active') then
        return pg_catalog.jsonb_build_object('outcome', 'not_allowed');
    end if;
    if exists (select 1 from public.cherry_checks where subscription_id = p_subscription
        and status = 'running' and lease_expires_at >= pg_catalog.now()) then
        return pg_catalog.jsonb_build_object('outcome', 'running');
    end if;
    if v_subscription.status = 'preparing' then
        select id into v_check from public.cherry_checks where subscription_id = p_subscription and kind = 'baseline'
        order by created_at desc limit 1;
    else
        insert into public.cherry_checks (subscription_id, kind, check_date)
        values (p_subscription, 'daily', public.cherry_kst_date(pg_catalog.now())) on conflict do nothing;
        select id into v_check from public.cherry_checks where subscription_id = p_subscription and kind = 'daily'
            and check_date = public.cherry_kst_date(pg_catalog.now());
    end if;
    update public.cherry_checks set status = 'queued', run_after = pg_catalog.now(), attempts = 0, series = series + 1,
        error_code = null, finished_at = null, lease_token = null, lease_expires_at = null, created_at = pg_catalog.now()
    where id = v_check;
    return pg_catalog.jsonb_build_object('outcome', case when v_check is null then 'not_allowed' else 'queued' end);
end;
$$;

-- Applies one finished collection in a single transaction: lists, events, report, notice, schedule.
create function public.cherry_apply_check(p_check uuid, p_lease uuid, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_check public.cherry_checks%rowtype;
    v_subscription public.cherry_subscriptions%rowtype;
    v_settings public.cherry_settings%rowtype;
    v_report uuid;
    v_new integer := 0;
    v_items integer := coalesce((p_payload ->> 'items')::integer, 0);
begin
    select * into v_check from public.cherry_checks where id = p_check for update;
    if not found or v_check.status <> 'running' or v_check.lease_token is distinct from p_lease then
        raise exception 'CHERRY_CHECK_FENCE';
    end if;
    select * into strict v_subscription from public.cherry_subscriptions where id = v_check.subscription_id for update;
    if v_subscription.status not in ('preparing', 'active') then raise exception 'CHERRY_CHECK_FENCE'; end if;
    select * into strict v_settings from public.cherry_settings;

    insert into public.cherry_relations as relation (subscription_id, instagram_id, username, full_name, is_private, is_verified,
        is_follower, is_following, follower_new_at, following_new_at, follower_misses, following_misses,
        follower_missing_since, following_missing_since, updated_at)
    select v_subscription.id, entry.id, entry.username, entry.full_name, entry.is_private, entry.is_verified,
        entry.follower, entry.following, case when entry.follower_new then v_now end,
        case when entry.following_new then v_now end, entry.follower_misses, entry.following_misses,
        entry.follower_missing_since, entry.following_missing_since, v_now
    from pg_catalog.jsonb_to_recordset(coalesce(p_payload -> 'relations', '[]'::jsonb)) as entry(
        id text, username text, full_name text, is_private boolean, is_verified boolean, follower boolean, following boolean,
        follower_new boolean, following_new boolean, follower_misses smallint, following_misses smallint,
        follower_missing_since timestamptz, following_missing_since timestamptz)
    on conflict (subscription_id, instagram_id) do update set username = excluded.username, full_name = excluded.full_name,
        is_private = excluded.is_private, is_verified = excluded.is_verified,
        is_follower = excluded.is_follower, is_following = excluded.is_following,
        follower_new_at = case when not excluded.is_follower then null
            else coalesce(relation.follower_new_at, excluded.follower_new_at) end,
        following_new_at = case when not excluded.is_following then null
            else coalesce(relation.following_new_at, excluded.following_new_at) end,
        follower_misses = excluded.follower_misses, following_misses = excluded.following_misses,
        follower_missing_since = excluded.follower_missing_since,
        following_missing_since = excluded.following_missing_since, updated_at = v_now;
    delete from public.cherry_relations where subscription_id = v_subscription.id and not is_follower and not is_following;

    select pg_catalog.count(*) into v_new
    from pg_catalog.jsonb_to_recordset(coalesce(p_payload -> 'events', '[]'::jsonb)) as entry(kind text)
    where entry.kind = 'new';
    if v_new > 0 then
        insert into public.cherry_reports (subscription_id, check_id, report_date, new_count)
        values (v_subscription.id, v_check.id, public.cherry_kst_date(v_now), v_new)
        on conflict (check_id) do update set new_count = public.cherry_reports.new_count + excluded.new_count,
            status = 'building', attempts = 0, lease_token = null, lease_expires_at = null
        returning id into v_report;
    end if;
    insert into public.cherry_mutual_events (subscription_id, check_id, report_id, kind, certainty, position, instagram_id,
        username, full_name, is_private, is_verified, detected_at, detail_status, ai_status)
    select v_subscription.id, v_check.id, case when entry.kind = 'new' then v_report end, entry.kind, entry.certainty,
        entry.position, entry.id, entry.username, entry.full_name, entry.is_private, entry.is_verified, v_now,
        case when entry.kind = 'new' then 'pending' else 'skipped' end,
        case when entry.kind = 'new' then 'pending' else 'skipped' end
    from pg_catalog.jsonb_to_recordset(coalesce(p_payload -> 'events', '[]'::jsonb)) as entry(
        id text, username text, full_name text, is_private boolean, is_verified boolean, kind text, certainty text, position integer)
    on conflict (check_id, instagram_id) do nothing;

    if v_check.kind = 'baseline' then
        update public.cherry_subscriptions set status = 'active', baseline_at = v_now, current_period_start = v_now,
            current_period_end = v_now + interval '1 month',
            items_period_start = v_now, items_used = 0,
            next_check_at = public.cherry_next_check_at(v_subscription.id, v_now, v_settings.check_hour_kst)
        where id = v_subscription.id and status = 'preparing';
        update public.cherry_payments set period_start = v_now, period_end = v_now + interval '1 month', updated_at = v_now
        where subscription_id = v_subscription.id and cycle = 1 and status = 'paid';
        perform public.cherry_queue_notification(v_subscription.id, 'baseline_ready', 'baseline:' || v_subscription.id::text,
            pg_catalog.jsonb_build_object('mutuals', coalesce((p_payload ->> 'mutuals')::integer, 0)));
    end if;
    update public.cherry_subscriptions set last_checked_at = v_now, failure_streak = 0,
        -- A direction that was not read keeps its old count, so its change stays pending.
        followers_count = coalesce((p_payload #>> '{followers,count}')::integer, followers_count),
        followers_gap = coalesce((p_payload #>> '{followers,gap}')::integer, followers_gap),
        followers_listed_at = case when p_payload ? 'followers' then v_now else followers_listed_at end,
        following_count = coalesce((p_payload #>> '{following,count}')::integer, following_count),
        following_gap = coalesce((p_payload #>> '{following,gap}')::integer, following_gap),
        following_listed_at = case when p_payload ? 'following' then v_now else following_listed_at end,
        unavailable_code = null, unavailable_since = null, updated_at = v_now,
        items_used = case
            when v_check.kind = 'baseline' then items_used
            when items_period_start is null or items_period_start <= v_now - interval '1 month' then v_items
            else items_used + v_items end,
        items_period_start = case
            when items_period_start is null or items_period_start <= v_now - interval '1 month' then v_now
            else items_period_start end
    where id = v_subscription.id;
    update public.cherry_checks set status = 'succeeded', finished_at = v_now, error_code = null, items_collected = v_items,
        result = p_payload -> 'result', lease_token = null, lease_expires_at = null
    where id = v_check.id;
    return pg_catalog.jsonb_build_object('newEvents', v_new, 'reportId', v_report);
end;
$$;

-- A private or missing target is confirmed by a second look before the service ends.
create function public.cherry_mark_unavailable(p_check uuid, p_lease uuid, p_code text, p_confirm_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_check public.cherry_checks%rowtype;
    v_subscription public.cherry_subscriptions%rowtype;
    v_refund jsonb;
    v_reason text := case when p_code = 'private' then 'target_private' else 'target_not_found' end;
begin
    if p_code not in ('private', 'not_found') then raise exception 'CHERRY_UNAVAILABLE_INVALID'; end if;
    select * into v_check from public.cherry_checks where id = p_check for update;
    if not found or v_check.status <> 'running' or v_check.lease_token is distinct from p_lease then
        raise exception 'CHERRY_CHECK_FENCE';
    end if;
    select * into strict v_subscription from public.cherry_subscriptions where id = v_check.subscription_id for update;
    if v_subscription.unavailable_code is distinct from p_code
        or v_subscription.unavailable_since > v_now - pg_catalog.make_interval(secs => p_confirm_seconds - 60) then
        update public.cherry_subscriptions set unavailable_code = p_code,
            unavailable_since = case when unavailable_code = p_code then unavailable_since else v_now end, updated_at = v_now
        where id = v_subscription.id;
        update public.cherry_checks set status = 'queued', run_after = v_now + pg_catalog.make_interval(secs => p_confirm_seconds),
            error_code = 'target_' || p_code, lease_token = null, lease_expires_at = null where id = v_check.id;
        return pg_catalog.jsonb_build_object('confirmed', false);
    end if;
    update public.cherry_checks set status = 'succeeded', finished_at = v_now, error_code = 'target_' || p_code,
        lease_token = null, lease_expires_at = null where id = v_check.id;
    v_refund := public.cherry_end_with_refund(v_subscription.id, v_reason);
    perform public.cherry_queue_notification(v_subscription.id, 'target_unavailable', 'unavailable:' || v_subscription.id::text,
        pg_catalog.jsonb_build_object('code', p_code, 'refundKrw', coalesce((v_refund ->> 'refundKrw')::integer, 0)));
    return pg_catalog.jsonb_build_object('confirmed', true) || v_refund;
end;
$$;

-- ---------------------------------------------------------------------------
-- Paid provider run ledger
-- ---------------------------------------------------------------------------
create function public.cherry_reserve_run(
    p_owner_key text, p_operation text, p_subscription uuid, p_slot text, p_actor text, p_items integer, p_max_charge numeric
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_settings public.cherry_settings%rowtype;
    v_last public.cherry_provider_runs%rowtype;
    v_active integer;
    v_row public.cherry_provider_runs%rowtype;
begin
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('cherry-provider-runs', 0));
    select * into strict v_settings from public.cherry_settings;
    select * into v_last from public.cherry_provider_runs
    where owner_key = p_owner_key and operation = p_operation order by attempt desc limit 1;
    if found and v_last.status in ('started', 'succeeded') then
        return pg_catalog.jsonb_build_object('outcome', 'resume', 'id', v_last.id, 'runId', v_last.run_id,
            'slot', v_last.credential_slot, 'maxChargeUsd', v_last.max_charge_usd, 'status', v_last.status,
            'attempt', v_last.attempt);
    end if;
    if found and v_last.status = 'reserved' then
        -- The worker stopped between the reservation and the provider response.
        if v_last.created_at > pg_catalog.now() - interval '10 minutes' then
            return pg_catalog.jsonb_build_object('outcome', 'busy');
        end if;
        update public.cherry_provider_runs set status = 'ambiguous', error_code = 'start_unconfirmed', finished_at = pg_catalog.now()
        where id = v_last.id;
        v_last.status := 'ambiguous';
    end if;
    -- One ambiguous start is tolerated; a second needs an operator.
    if (select pg_catalog.count(*) from public.cherry_provider_runs
        where owner_key = p_owner_key and operation = p_operation and status = 'ambiguous') >= 2 then
        return pg_catalog.jsonb_build_object('outcome', 'ambiguous');
    end if;
    if coalesce(v_last.attempt, 0) >= 5 then
        return pg_catalog.jsonb_build_object('outcome', 'exhausted');
    end if;
    if p_slot = 'secondary' then
        select pg_catalog.count(*) into v_active from public.cherry_provider_runs
        where credential_slot = 'secondary' and status in ('reserved', 'started')
            and created_at > pg_catalog.now() - interval '30 minutes';
        if v_active >= v_settings.max_active_runs then
            return pg_catalog.jsonb_build_object('outcome', 'capacity');
        end if;
        if v_settings.apify_observed_at is null
            or v_settings.apify_observed_at < pg_catalog.now() - interval '60 minutes'
            or v_settings.apify_limit_usd - v_settings.apify_usage_usd - v_settings.analyzer_reserve_usd
                - coalesce((select pg_catalog.sum(max_charge_usd) from public.cherry_provider_runs
                    where credential_slot = 'secondary' and status in ('reserved', 'started')
                        and created_at > pg_catalog.now() - interval '30 minutes'), 0) < p_max_charge then
            return pg_catalog.jsonb_build_object('outcome', 'budget');
        end if;
    end if;
    insert into public.cherry_provider_runs (owner_key, operation, attempt, subscription_id, credential_slot, actor_id,
        requested_items, max_charge_usd)
    values (p_owner_key, p_operation, coalesce(v_last.attempt, 0) + 1, p_subscription, p_slot, p_actor, p_items, p_max_charge)
    returning * into v_row;
    return pg_catalog.jsonb_build_object('outcome', 'reserved', 'id', v_row.id, 'slot', p_slot, 'maxChargeUsd', p_max_charge,
        'attempt', v_row.attempt);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reports, notifications, billing, refunds
-- ---------------------------------------------------------------------------
create function public.cherry_claim_reports(p_limit integer, p_lease_seconds integer) returns setof public.cherry_reports
language sql security definer set search_path = '' as $$
    update public.cherry_reports as report set attempts = report.attempts + 1, lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds)
    where report.id in (
        select candidate.id from public.cherry_reports as candidate
        where candidate.status = 'building' and (candidate.lease_expires_at is null or candidate.lease_expires_at < pg_catalog.now())
        order by candidate.created_at limit p_limit for update skip locked
    )
    returning report.*
$$;

create function public.cherry_finish_report(p_report uuid, p_lease uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
    v_report public.cherry_reports%rowtype;
begin
    update public.cherry_reports set status = 'ready', ready_at = pg_catalog.now(), lease_token = null, lease_expires_at = null
    where id = p_report and status = 'building' and lease_token = p_lease returning * into v_report;
    if not found then return false; end if;
    perform public.cherry_queue_notification(v_report.subscription_id, 'new_mutual', 'report:' || v_report.id::text,
        pg_catalog.jsonb_build_object('count', v_report.new_count, 'confirmed', (select pg_catalog.count(*)
            from public.cherry_mutual_events as event where event.report_id = v_report.id and event.certainty = 'confirmed')),
        v_report.id);
    return true;
end;
$$;

create function public.cherry_claim_notifications(p_limit integer, p_lease_seconds integer)
returns setof public.cherry_notifications
language plpgsql security definer set search_path = '' as $$
begin
    if not (select settings.notifications_enabled from public.cherry_settings as settings) then return; end if;
    -- The worker stopped after the provider call may have happened: never send it twice.
    update public.cherry_notifications set status = 'unconfirmed', error_code = 'lease_expired', lease_token = null
    where status = 'sending' and lease_expires_at < pg_catalog.now();
    update public.cherry_notifications set status = 'canceled', error_code = 'expired'
    where status = 'queued' and send_after < pg_catalog.now() - interval '36 hours';
    return query
    update public.cherry_notifications as message set status = 'sending', attempts = message.attempts + 1,
        lease_token = pg_catalog.gen_random_uuid(),
        lease_expires_at = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds)
    where message.id in (
        select candidate.id from public.cherry_notifications as candidate
        where candidate.status = 'queued' and candidate.send_after <= pg_catalog.now()
        order by candidate.send_after limit p_limit for update skip locked
    )
    returning message.*;
end;
$$;

create function public.cherry_claim_billing(p_limit integer) returns setof public.cherry_payments
language plpgsql security definer set search_path = '' as $$
declare
    v_row record;
    v_payment public.cherry_payments%rowtype;
    v_cycle integer;
    v_offer public.cherry_offers%rowtype;
begin
    for v_row in
        select subscription.* from public.cherry_subscriptions as subscription
        where subscription.payment_provider = 'toss' and subscription.status in ('active', 'past_due')
            and not subscription.cancel_at_period_end and subscription.current_period_end <= pg_catalog.now()
            and subscription.current_period_end > pg_catalog.now() - interval '4 days'
            and (subscription.billing_next_attempt_at is null or subscription.billing_next_attempt_at <= pg_catalog.now())
            and not exists (select 1 from public.cherry_payments as open_payment
                where open_payment.subscription_id = subscription.id and open_payment.status = 'processing')
        order by subscription.current_period_end for update skip locked limit p_limit
    loop
        -- An abandoned card change must not block the scheduled charge.
        update public.cherry_payments set status = 'canceled', failure_code = 'superseded', updated_at = pg_catalog.now()
        where subscription_id = v_row.id and status = 'ready';
        select coalesce(pg_catalog.max(payment.cycle), 0) + 1 into v_cycle from public.cherry_payments as payment
        where payment.subscription_id = v_row.id and payment.status in ('paid', 'partially_refunded', 'refunded', 'review');
        if v_row.price_lock_until > v_row.current_period_end then
            select * into strict v_offer from public.cherry_offers where code = v_row.offer_code;
            v_offer.price_krw := v_row.price_krw;
        else
            select * into strict v_offer from public.cherry_offers where code = 'standard';
        end if;
        insert into public.cherry_payments (subscription_id, user_id, cycle, provider, order_ref, offer_code, amount_krw, status)
        values (v_row.id, v_row.user_id, v_cycle, 'toss',
            'chr_' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), v_offer.code, v_offer.price_krw, 'processing')
        returning * into v_payment;
        return next v_payment;
    end loop;
end;
$$;

create function public.cherry_fail_payment(p_payment uuid, p_code text) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_payment public.cherry_payments%rowtype;
    v_failures integer;
begin
    update public.cherry_payments set status = 'failed', failure_code = p_code, updated_at = pg_catalog.now()
    where id = p_payment and status in ('ready', 'processing') returning * into v_payment;
    if not found or v_payment.cycle = 1 then return; end if;
    select pg_catalog.count(*) into v_failures from public.cherry_payments
    where subscription_id = v_payment.subscription_id and cycle = v_payment.cycle and status = 'failed';
    update public.cherry_subscriptions set status = 'past_due', status_reason = 'payment_failed',
        billing_next_attempt_at = pg_catalog.now()
            + case when v_failures = 1 then interval '1 day' else interval '2 days' end,
        updated_at = pg_catalog.now()
    where id = v_payment.subscription_id and status in ('active', 'past_due');
    perform public.cherry_queue_notification(v_payment.subscription_id, 'payment_failed',
        'payment-failed:' || v_payment.subscription_id::text || ':' || v_payment.cycle::text, '{}'::jsonb);
end;
$$;

create function public.cherry_claim_refunds(p_limit integer) returns setof public.cherry_refunds
language plpgsql security definer set search_path = '' as $$
begin
    if not (select settings.auto_refund_enabled from public.cherry_settings as settings) then return; end if;
    return query
    update public.cherry_refunds as refund set status = 'processing', updated_at = pg_catalog.now()
    where refund.id in (
        select candidate.id from public.cherry_refunds as candidate
        where candidate.status = 'pending'
            or (candidate.status = 'processing' and candidate.updated_at < pg_catalog.now() - interval '15 minutes')
        order by candidate.requested_at limit p_limit for update skip locked
    )
    returning refund.*;
end;
$$;

-- ---------------------------------------------------------------------------
-- Account deletion and retention
-- ---------------------------------------------------------------------------
create function public.cherry_account_image_keys(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
    select coalesce(pg_catalog.jsonb_agg(image ->> 'key'), '[]'::jsonb)
    from public.cherry_subscriptions as subscription
    join public.cherry_mutual_events as event on event.subscription_id = subscription.id
    cross join lateral pg_catalog.jsonb_array_elements(event.images) as image
    where subscription.user_id = p_user and image ? 'key'
$$;

-- Payment and refund records stay for bookkeeping; everything observed is removed.
create function public.cherry_purge_subscription(p_subscription uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
    delete from public.cherry_notifications where subscription_id = p_subscription;
    delete from public.cherry_mutual_events where subscription_id = p_subscription;
    delete from public.cherry_reports where subscription_id = p_subscription;
    delete from public.cherry_relations where subscription_id = p_subscription;
    delete from public.cherry_checks where subscription_id = p_subscription;
    update public.cherry_subscriptions set target_instagram_id = 'purged', target_username = 'purged', target_full_name = null,
        target_profile_pic_url = null, recipient_phone = null, recipient_email = null, followers_count = null,
        following_count = null, next_check_at = null, purged_at = pg_catalog.now(), updated_at = pg_catalog.now()
    where id = p_subscription;
end;
$$;

create function public.cherry_purge_account(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
    v_subscription uuid;
begin
    update public.cherry_payments set status = 'canceled', failure_code = 'account_deleted', updated_at = pg_catalog.now()
    where user_id = p_user and status = 'ready';
    for v_subscription in select id from public.cherry_subscriptions where user_id = p_user for update loop
        update public.cherry_subscriptions set status = 'ended', ended_at = coalesce(ended_at, pg_catalog.now()),
            status_reason = case when status = 'ended' then status_reason else 'account_deleted' end
        where id = v_subscription;
        perform public.cherry_purge_subscription(v_subscription);
    end loop;
    delete from public.cherry_billing_keys where user_id = p_user;
    delete from public.cherry_target_checks where user_id = p_user;
    delete from public.cherry_capacity_waitlist where user_id = p_user;
    delete from public.cherry_reservation_claims where user_id = p_user;
end;
$$;

create function public.cherry_retention_batch(p_limit integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
    v_events jsonb;
    v_subscription uuid;
    v_purged integer := 0;
begin
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', expired.id, 'images', expired.images)), '[]'::jsonb)
    into v_events from (
        select event.id, event.images from public.cherry_mutual_events as event
        where event.images <> '[]'::jsonb and event.detected_at < pg_catalog.now() - interval '30 days'
        order by event.detected_at limit p_limit
    ) as expired;
    for v_subscription in
        select subscription.id from public.cherry_subscriptions as subscription
        where subscription.status = 'ended' and subscription.purged_at is null
            and subscription.ended_at < pg_catalog.now() - interval '30 days'
            and not exists (select 1 from public.cherry_mutual_events as event
                where event.subscription_id = subscription.id and event.images <> '[]'::jsonb)
        limit p_limit for update skip locked
    loop
        perform public.cherry_purge_subscription(v_subscription);
        v_purged := v_purged + 1;
    end loop;
    delete from public.cherry_target_checks where created_at < pg_catalog.now() - interval '7 days';
    update public.cherry_payments set status = 'canceled', failure_code = 'abandoned', updated_at = pg_catalog.now()
    where status = 'ready' and cycle = 1 and created_at < pg_catalog.now() - interval '7 days';
    return pg_catalog.jsonb_build_object('events', v_events, 'purged', v_purged);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
do $$
declare
    v_name text;
    v_function regprocedure;
begin
    for v_name in select tablename from pg_catalog.pg_tables where schemaname = 'public' and tablename like 'cherry\_%' loop
        execute pg_catalog.format('alter table public.%I enable row level security', v_name);
        execute pg_catalog.format('revoke all on table public.%I from public, anon, authenticated, service_role', v_name);
        execute pg_catalog.format('grant select, insert, update, delete on table public.%I to service_role', v_name);
    end loop;
    for v_function in select proc.oid::regprocedure from pg_catalog.pg_proc as proc
        join pg_catalog.pg_namespace as space on space.oid = proc.pronamespace
        where space.nspname = 'public' and proc.proname like 'cherry\_%' loop
        execute pg_catalog.format('revoke all on function %s from public, anon, authenticated, service_role', v_function);
        execute pg_catalog.format('grant execute on function %s to service_role', v_function);
    end loop;
end;
$$;
-- Audit rows are append-only for the application.
revoke update, delete on table public.cherry_audit_log from service_role;
