-- Record only the recognized distribution channel, never the original URL.
alter table public.namchin_launch_reservations
    add column source text check (source in ('threads', 'everytime', 'x'));
