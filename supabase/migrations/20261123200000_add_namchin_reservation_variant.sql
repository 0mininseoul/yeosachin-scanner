-- Meta A/B test arm (landing ?v=bf|crush) for each pre-reservation; null when the visitor came without one.
-- The existing table-level grant (select, insert to service_role) covers the new column.
alter table public.namchin_launch_reservations
    add column variant text check (variant in ('bf', 'crush'));
