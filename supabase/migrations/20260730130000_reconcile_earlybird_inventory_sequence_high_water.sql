-- Keep the allocation counter as a high-water mark for the immutable
-- earlybird_orders.plan_sequence values. A past interrupted deployment left
-- the counter below an already allocated sequence, causing the next payment
-- finalization to collide with earlybird_orders_plan_sequence_unique.
--
-- Take the inventory lock before inspecting sequences. Canonical payment
-- finalization allocates a sequence by updating this table, so a finalizer
-- already in flight either commits before this snapshot is read or waits for
-- the repaired high-water mark before allocating its next sequence.
BEGIN;

LOCK TABLE public.earlybird_plan_inventory IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.earlybird_orders IN SHARE MODE;

DO $$
DECLARE
    v_inventory public.earlybird_plan_inventory%ROWTYPE;
    v_allocated_high_water INTEGER;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.earlybird_orders AS earlybird_order
        WHERE earlybird_order.plan_sequence IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_plan_inventory AS inventory
              WHERE inventory.plan_id = earlybird_order.plan_id
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_INVENTORY_SEQUENCE_PLAN_MISSING',
            ERRCODE = 'P0001';
    END IF;

    FOR v_inventory IN
        SELECT inventory.*
        FROM public.earlybird_plan_inventory AS inventory
        ORDER BY inventory.plan_id
        FOR UPDATE OF inventory
    LOOP
        SELECT COALESCE(MAX(earlybird_order.plan_sequence), 0)
        INTO v_allocated_high_water
        FROM public.earlybird_orders AS earlybird_order
        WHERE earlybird_order.plan_id = v_inventory.plan_id
          AND earlybird_order.plan_sequence IS NOT NULL;

        IF v_allocated_high_water > v_inventory.sale_limit THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_INVENTORY_SEQUENCE_EXCEEDS_SALE_LIMIT',
                ERRCODE = 'P0001';
        END IF;

        -- Never decrement sold_count: a larger existing counter represents a
        -- consumed sequence that is not recoverable without changing orders.
        IF v_allocated_high_water > v_inventory.sold_count THEN
            UPDATE public.earlybird_plan_inventory AS inventory
            SET sold_count = v_allocated_high_water,
                updated_at = pg_catalog.clock_timestamp()
            WHERE inventory.plan_id = v_inventory.plan_id;
        END IF;
    END LOOP;
END;
$$;

COMMIT;
