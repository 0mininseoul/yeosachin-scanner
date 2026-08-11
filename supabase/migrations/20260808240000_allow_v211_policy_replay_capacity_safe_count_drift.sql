-- MIGRATION_PREDECESSOR=20260808230000
-- A successful fresh admission can observe a different relationship count
-- from the earlier paid-order lineage. Keep every immutable plan witness exact,
-- but authorize the r8 incident replay when the old, paid, and fresh
-- observations all fit the selected Basic card.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260808230000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_POLICY_COUNT_DRIFT_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

DO $count_drift_patch$
DECLARE
    v_signature TEXT :=
        'public.earlybird_v211_policy_identity_replay_ready('
        || 'uuid,uuid,uuid,uuid)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_expected_old_hash CONSTANT TEXT := 'a40dd46d8412398967f2ce71a57cf8af';
    v_old_counts TEXT := $old$          AND current_preflight.target_followers_count =
                source_preflight.admission_target_followers_count
          AND current_preflight.target_following_count =
                source_preflight.admission_target_following_count$old$;
    v_new_counts TEXT := $new$          AND source_preflight.admission_target_followers_count IS NOT NULL
          AND source_preflight.admission_target_followers_count >= 0
          AND source_preflight.admission_target_following_count IS NOT NULL
          AND source_preflight.admission_target_following_count >= 0
          AND earlybird_order.target_followers_count IS NOT NULL
          AND earlybird_order.target_followers_count >= 0
          AND earlybird_order.target_following_count IS NOT NULL
          AND earlybird_order.target_following_count >= 0
          AND current_preflight.target_followers_count IS NOT NULL
          AND current_preflight.target_followers_count >= 0
          AND current_preflight.target_following_count IS NOT NULL
          AND current_preflight.target_following_count >= 0$new$;
    v_old_card_guard TEXT := $old$          AND current_preflight.policy_versions_snapshot =
                failed_preflight.policy_versions_snapshot
          AND 1 = ($old$;
    v_new_card_guard TEXT := $new$          AND current_preflight.policy_versions_snapshot =
                failed_preflight.policy_versions_snapshot
          AND current_preflight.plan_cards_snapshot =
                failed_preflight.plan_cards_snapshot
          AND current_preflight.admission_plan_cards_snapshot =
                current_preflight.plan_cards_snapshot
          AND current_preflight.admission_capacity_required_plan_id
                IS NOT DISTINCT FROM current_preflight.capacity_required_plan_id
          AND current_preflight.admission_required_plan_id
                IS NOT DISTINCT FROM current_preflight.required_plan_id
          AND public.analysis_v2_valid_plan_cards_snapshot(
                current_preflight.plan_cards_snapshot
          )
          AND current_preflight.plan_cards_snapshot
                -> 'basic' ->> 'launchStatus' = 'production'
          AND current_preflight.plan_cards_snapshot
                -> 'basic' ->> 'selectionState'
                IN ('required', 'available_upgrade')
          AND COALESCE(
                current_preflight.plan_cards_snapshot
                    -> 'basic' -> 'relationshipCapacity' ->> 'followers',
                ''
          ) ~ '^[0-9]+$'
          AND COALESCE(
                current_preflight.plan_cards_snapshot
                    -> 'basic' -> 'relationshipCapacity' ->> 'following',
                ''
          ) ~ '^[0-9]+$'
          AND source_preflight.admission_target_followers_count <= CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers'
                )::INTEGER
                ELSE -1
          END
          AND earlybird_order.target_followers_count <= CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers'
                )::INTEGER
                ELSE -1
          END
          AND current_preflight.target_followers_count <= CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'followers'
                )::INTEGER
                ELSE -1
          END
          AND source_preflight.admission_target_following_count <= CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following'
                )::INTEGER
                ELSE -1
          END
          AND earlybird_order.target_following_count <= CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following'
                )::INTEGER
                ELSE -1
          END
          AND current_preflight.target_following_count <= CASE
                WHEN COALESCE(
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following',
                    ''
                ) ~ '^[0-9]+$' THEN (
                    current_preflight.plan_cards_snapshot
                        -> 'basic' -> 'relationshipCapacity' ->> 'following'
                )::INTEGER
                ELSE -1
          END
          AND 1 = ($new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.md5(v_definition) <> v_expected_old_hash
       OR pg_catalog.strpos(v_definition, v_old_counts) = 0
       OR pg_catalog.strpos(v_definition, v_old_card_guard) = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_POLICY_COUNT_DRIFT_OLD_SHAPE_MISMATCH';
    END IF;

    v_rewritten := pg_catalog.replace(
        v_definition, v_old_counts, v_new_counts
    );
    v_rewritten := pg_catalog.replace(
        v_rewritten, v_old_card_guard, v_new_card_guard
    );
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, v_old_counts) <> 0
       OR pg_catalog.strpos(
            v_rewritten,
            'current_preflight.admission_plan_cards_snapshot'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'source_preflight.admission_target_followers_count <= CASE'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'earlybird_order.target_followers_count <= CASE'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'current_preflight.target_followers_count <= CASE'
       ) = 0 THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_POLICY_COUNT_DRIFT_REWRITE_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$count_drift_patch$;

REVOKE ALL ON FUNCTION public.earlybird_v211_policy_identity_replay_ready(
    UUID, UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

DO $final_guard$
DECLARE
    v_helper TEXT :=
        'public.earlybird_v211_policy_identity_replay_ready('
        || 'uuid,uuid,uuid,uuid)';
    v_definition TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_helper::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(
            v_definition,
            'current_preflight.target_followers_count ='
            || pg_catalog.chr(10)
            || '                source_preflight.admission_target_followers_count'
       ) <> 0
       OR pg_catalog.strpos(
            v_definition,
            'current_preflight.plan_cards_snapshot ='
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'source_preflight.admission_target_followers_count <= CASE'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'earlybird_order.target_followers_count <= CASE'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'current_preflight.target_followers_count <= CASE'
       ) = 0
       OR pg_catalog.has_function_privilege('anon', v_helper, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_helper, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_helper, 'EXECUTE') THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_POLICY_COUNT_DRIFT_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
