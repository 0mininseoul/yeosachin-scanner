BEGIN;

SET LOCAL lock_timeout = '5s';

DO $budget_clock$
DECLARE
    target_schema text;
    target record;
    definition text;
    old_assignment constant text := 'updated_at = pg_catalog.clock_timestamp()';
    new_assignment constant text :=
        'updated_at = GREATEST(reservation.updated_at, reservation.created_at, pg_catalog.clock_timestamp())';
BEGIN
    FOR target_schema IN
        SELECT 'public'
        UNION ALL
        SELECT 'dev_cloud_six'
        WHERE to_regclass('dev_cloud_six.simulated_vertex_reservations') IS NOT NULL
    LOOP
        FOR target IN SELECT * FROM (VALUES
            ('settle_vertex_ai_budget(text,uuid,numeric)', 2),
            ('cancel_vertex_ai_budget(text,uuid)', 1)
        ) AS roots(signature, expected_assignments)
        LOOP
            definition := pg_get_functiondef((target_schema || '.' || target.signature)::regprocedure);
            IF cardinality(string_to_array(definition, old_assignment)) - 1 <> target.expected_assignments THEN
                RAISE EXCEPTION 'VERTEX_AI_BUDGET_CLOCK_SOURCE_DRIFT: %.%', target_schema, target.signature;
            END IF;
            EXECUTE replace(definition, old_assignment, new_assignment);
        END LOOP;
    END LOOP;
END;
$budget_clock$;

COMMIT;
