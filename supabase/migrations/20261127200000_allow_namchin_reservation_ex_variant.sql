-- Meta ad arm C (전남친, landing /ex?v=ex). Widens the check only; existing rows and grants are unchanged.
alter table public.namchin_launch_reservations
    drop constraint namchin_launch_reservations_variant_check,
    add constraint namchin_launch_reservations_variant_check check (variant in ('bf', 'crush', 'ex'));
