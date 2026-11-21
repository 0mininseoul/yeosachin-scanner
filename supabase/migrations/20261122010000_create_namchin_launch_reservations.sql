create table public.namchin_launch_reservations (
    email text primary key check (
        email = lower(btrim(email)) and char_length(email) between 3 and 254
    ),
    phone text not null unique check (phone ~ '^\+8210[0-9]{8}$'),
    consented_at timestamptz not null default now()
);

create index namchin_launch_reservations_recent_idx
    on public.namchin_launch_reservations (consented_at desc, email);

alter table public.namchin_launch_reservations enable row level security;
revoke all on table public.namchin_launch_reservations from public, anon, authenticated, service_role;
grant select, insert on table public.namchin_launch_reservations to service_role;
