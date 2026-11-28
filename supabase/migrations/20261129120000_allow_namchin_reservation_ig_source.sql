-- Instagram link-in-bio visits (utm_source=ig) as a reservation source. Widens the check only.
alter table public.namchin_launch_reservations
    drop constraint namchin_launch_reservations_source_check,
    add constraint namchin_launch_reservations_source_check check (source in ('threads', 'everytime', 'x', 'ig'));
