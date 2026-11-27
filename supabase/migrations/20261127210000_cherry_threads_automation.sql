create table public.cherry_threads_batches (
    id uuid primary key default gen_random_uuid(),
    run_date date not null,
    theme text not null check (theme in ('ex', 'partner', 'crush', 'situationship')),
    requested_count integer not null check (requested_count between 1 and 20),
    state text not null default 'queued' check (state in ('queued', 'generating', 'ready', 'failed')),
    correction_ids uuid[] not null default '{}',
    error_code text,
    started_at timestamptz,
    created_at timestamptz not null default now(),
    unique (run_date)
);

create table public.cherry_threads_posts (
    id uuid primary key default gen_random_uuid(),
    batch_id uuid references public.cherry_threads_batches(id),
    observed_theme text check (observed_theme in ('ex', 'partner', 'crush', 'situationship')),
    ordinal integer not null,
    body text not null check (char_length(body) between 1 and 500),
    reply text check (char_length(reply) between 1 and 500),
    version integer not null default 1,
    approved_version integer,
    state text not null default 'draft' check (state in ('draft', 'scheduled', 'publishing', 'published', 'review', 'cancelled')),
    scheduled_at timestamptz,
    publish_slot timestamptz,
    container_id text,
    media_id text unique,
    permalink text,
    published_at timestamptz,
    reply_container_id text,
    reply_media_id text,
    reply_state text not null default 'none' check (reply_state in ('none', 'pending', 'sending', 'published', 'review')),
    touched_at timestamptz not null default now(),
    views bigint,
    reader_replies integer,
    measured_at timestamptz,
    insight_retry_at timestamptz,
    reader_examples text[] not null default '{}',
    error_code text,
    unique (batch_id, ordinal)
);

create unique index cherry_threads_scheduled_slot
    on public.cherry_threads_posts (scheduled_at) where state = 'scheduled';
create unique index cherry_threads_one_attempt_per_slot
    on public.cherry_threads_posts (publish_slot) where publish_slot is not null;
create index cherry_threads_pending_insights
    on public.cherry_threads_posts (published_at) where media_id is not null and measured_at is null;
create index cherry_threads_observed_theme
    on public.cherry_threads_posts (observed_theme, published_at desc) where batch_id is null;

create table public.cherry_threads_corrections (
    id uuid primary key default gen_random_uuid(),
    post_id uuid references public.cherry_threads_posts(id),
    theme text not null check (theme in ('ex', 'partner', 'crush', 'situationship')),
    before_text text not null,
    after_text text not null,
    reason text not null check (char_length(reason) between 1 and 1000),
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create index cherry_threads_active_corrections
    on public.cherry_threads_corrections (theme, created_at desc) where active;

create table public.cherry_threads_connection (
    id boolean primary key default true check (id),
    account_id text not null,
    token_ciphertext text not null,
    expires_at timestamptz not null,
    refresh_after timestamptz not null default now()
);

create table public.cherry_threads_preferences (
    id boolean primary key default true check (id),
    automatic_drafts boolean not null default false,
    draft_hour integer not null default 14 check (draft_hour between 0 and 23),
    draft_minute integer not null default 0 check (draft_minute in (0, 20, 40)),
    draft_count integer not null default 8 check (draft_count between 1 and 20)
);
insert into public.cherry_threads_preferences default values;

alter table public.cherry_threads_batches enable row level security;
alter table public.cherry_threads_posts enable row level security;
alter table public.cherry_threads_corrections enable row level security;
alter table public.cherry_threads_connection enable row level security;
alter table public.cherry_threads_preferences enable row level security;
revoke all on public.cherry_threads_batches, public.cherry_threads_posts, public.cherry_threads_corrections,
    public.cherry_threads_connection, public.cherry_threads_preferences from public, anon, authenticated;
grant select, insert, update on public.cherry_threads_batches, public.cherry_threads_posts, public.cherry_threads_corrections,
    public.cherry_threads_connection, public.cherry_threads_preferences to service_role;

-- Historical edits are reference cases. A correction is an allowlisted source for generation.
insert into public.cherry_threads_corrections (theme, before_text, after_text, reason) values
    ('crush', '나도 갈래. 그냥 보내도 되지?', '같이 가자고 먼저 말해줬으면 좋겠다...', '짝남이 먼저 제안해주길 기다리는 마음으로 쓴다.'),
    ('crush', '짝남이 내 스토리에 하트 눌렀어', '짝남이 내 셀카 스토리에 하트 눌렀어', '무슨 스토리였는지 구체적인 장면을 짚는다.'),
    ('ex', '사진첩 정리하다가 전남친이 찍어준 내 사진 봤어', '갤러리 정리하다가 전남친이 찍어준 내 사진 봄..', '친구한테 짧게 털어놓는 말투가 자연스럽다.'),
    ('ex', '혼자 가도 되는데 막상 저장 지우려니까 아까워', '혼자 가면 마음이 너무 힘들 것 같아 ㅠㅠ', '장소는 구글맵처럼 구체적으로 짚고 마음을 직접 말한다.'),
    ('partner', '팔로잉이 231에서 232가 됐어', '남친 팔로잉 숫자 올라간 것 같으면 들어가보는 사람들 있어?', '외워 둔 수치보다 실제로 확인하는 행동에 초점을 둔다.');

create function public.cherry_threads_correct(
    p_id uuid, p_version integer, p_body text, p_reply text, p_reason text, p_removed boolean default false
) returns boolean language plpgsql set search_path = '' as $$
declare old public.cherry_threads_posts%rowtype; related_theme text;
begin
    select * into old from public.cherry_threads_posts where id = p_id and version = p_version for update;
    if not found or old.batch_id is null then return false; end if;
    if (p_removed and old.state <> 'published') or (not p_removed and old.state not in ('draft', 'scheduled')) then return false; end if;
    select theme into related_theme from public.cherry_threads_batches where id = old.batch_id;
    if p_removed then
        insert into public.cherry_threads_corrections (post_id, theme, before_text, after_text, reason)
        values (old.id, related_theme, old.body, '', p_reason);
        update public.cherry_threads_posts set version = version + 1, state = 'cancelled',
            reply_state = case when reply_state = 'pending' then 'none' else reply_state end where id = old.id;
        return true;
    end if;
    if old.body = p_body and old.reply is not distinct from p_reply then return false; end if;
    if old.body <> p_body then
        insert into public.cherry_threads_corrections (post_id, theme, before_text, after_text, reason)
        values (old.id, related_theme, old.body, p_body, p_reason);
    end if;
    if old.reply is distinct from p_reply then
        insert into public.cherry_threads_corrections (post_id, theme, before_text, after_text, reason)
        values (old.id, related_theme, coalesce(old.reply, ''), coalesce(p_reply, ''), p_reason);
    end if;
    update public.cherry_threads_posts set body = p_body, reply = p_reply, state = 'draft',
        version = version + 1, approved_version = null, scheduled_at = null,
        container_id = null, reply_container_id = null, error_code = null, touched_at = now()
        where id = old.id;
    return true;
end
$$;

create function public.cherry_threads_save_drafts(p_batch uuid, p_started timestamptz, p_posts jsonb, p_corrections uuid[])
returns boolean language plpgsql set search_path = '' as $$
begin
    update public.cherry_threads_batches set state = 'ready', correction_ids = p_corrections, error_code = null
        where id = p_batch and state = 'generating' and started_at = p_started;
    if not found then return false; end if;
    insert into public.cherry_threads_posts (batch_id, ordinal, body)
    select p_batch, ordinality::integer, entry->>'body'
        from jsonb_array_elements(p_posts) with ordinality as item(entry, ordinality);
    return true;
end
$$;

create function public.cherry_threads_approve(p_batch uuid, p_schedule jsonb)
returns boolean language plpgsql set search_path = '' as $$
declare n integer; updated integer;
begin
    n := jsonb_array_length(p_schedule);
    if n = 0 or n > 20 then return false; end if;
    begin
        update public.cherry_threads_posts as post
        set state = 'scheduled', approved_version = post.version, scheduled_at = item.slot, touched_at = now()
        from jsonb_to_recordset(p_schedule) as item(id uuid, version integer, slot timestamptz)
        where post.id = item.id and post.batch_id = p_batch and post.state = 'draft' and post.version = item.version
          and item.slot > now() and date_bin('20 minutes', item.slot, '2000-01-01 UTC'::timestamptz) = item.slot
          and (item.slot at time zone 'Asia/Seoul')::date in (
              select run_date from public.cherry_threads_batches where id = p_batch
              union all select run_date + 1 from public.cherry_threads_batches
              where id = p_batch and (item.slot at time zone 'Asia/Seoul')::time <= '03:00'::time
          );
        get diagnostics updated = row_count;
        if updated <> n then raise exception using errcode = 'PTH01'; end if;
    exception when unique_violation or sqlstate 'PTH01' then return false;
    end;
    return true;
end
$$;

create function public.cherry_threads_claim_post()
returns setof public.cherry_threads_posts language plpgsql set search_path = '' as $$
declare slot timestamptz := date_bin('20 minutes', now(), '2000-01-01 UTC'::timestamptz); target uuid;
begin
    perform pg_advisory_xact_lock(hashtext('cherry_threads_publish'));
    update public.cherry_threads_posts p set state = 'review', error_code = 'schedule_expired'
        from public.cherry_threads_batches b where p.batch_id = b.id and p.state = 'scheduled'
        and now() >= ((b.run_date + 1) + time '03:20') at time zone 'Asia/Seoul';
    if exists (select 1 from public.cherry_threads_posts where publish_slot = slot) then return; end if;
    select p.id into target from public.cherry_threads_posts p
        where p.state = 'scheduled' and p.scheduled_at <= now() and p.approved_version = p.version
        order by p.scheduled_at limit 1 for update skip locked;
    if target is null then return; end if;
    return query update public.cherry_threads_posts set state = 'publishing', publish_slot = slot, touched_at = now()
        where id = target returning *;
end
$$;

create function public.cherry_threads_import(p_items jsonb)
returns integer language plpgsql set search_path = '' as $$
declare item record; affected integer; imported integer := 0;
begin
    for item in select * from jsonb_to_recordset(p_items)
        as x(media_id text, body text, observed_theme text, published_at timestamptz, permalink text)
        order by media_id
    loop
        perform pg_advisory_xact_lock(hashtextextended(item.media_id, 371));
        insert into public.cherry_threads_posts (ordinal, media_id, body, observed_theme, published_at, permalink, state)
        values (0, item.media_id, item.body, item.observed_theme, item.published_at, item.permalink, 'published')
        on conflict (media_id) do nothing;
        get diagnostics affected = row_count;
        imported := imported + affected;
    end loop;
    return imported;
end
$$;

create function public.cherry_threads_confirm_published(p_id uuid, p_media text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare post public.cherry_threads_posts%rowtype; observed public.cherry_threads_posts%rowtype;
begin
    perform pg_advisory_xact_lock(hashtextextended(p_media, 371));
    select * into post from public.cherry_threads_posts where id = p_id for update;
    if not found or post.state not in ('publishing', 'review') or post.batch_id is null then return false; end if;
    if exists (select 1 from public.cherry_threads_posts p where p.media_id = p_media and p.batch_id is not null) then
        return false;
    end if;
    delete from public.cherry_threads_posts where media_id = p_media and batch_id is null returning * into observed;
    update public.cherry_threads_posts set media_id = p_media, state = 'published', error_code = null,
        reply_state = case when post.reply is null then 'none' else 'pending' end, touched_at = now(),
        published_at = coalesce(observed.published_at, now()), permalink = observed.permalink,
        views = observed.views, reader_replies = observed.reader_replies, measured_at = observed.measured_at,
        reader_examples = coalesce(observed.reader_examples, '{}')
    where id = p_id;
    return true;
end
$$;

revoke all on function public.cherry_threads_correct(uuid,integer,text,text,text,boolean),
    public.cherry_threads_save_drafts(uuid,timestamptz,jsonb,uuid[]), public.cherry_threads_approve(uuid,jsonb),
    public.cherry_threads_claim_post(), public.cherry_threads_import(jsonb),
    public.cherry_threads_confirm_published(uuid,text) from public, anon, authenticated;
grant execute on function public.cherry_threads_correct(uuid,integer,text,text,text,boolean),
    public.cherry_threads_save_drafts(uuid,timestamptz,jsonb,uuid[]), public.cherry_threads_approve(uuid,jsonb),
    public.cherry_threads_claim_post(), public.cherry_threads_import(jsonb),
    public.cherry_threads_confirm_published(uuid,text) to service_role;
