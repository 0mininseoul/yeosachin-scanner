-- Supabase 22 interaction-evidence retirement apply package.
-- Owner-approved exact allowlist; apply remains coordinator-controlled.

BEGIN;

-- Resolve the exact base relations before taking locks. A missing or replaced
-- relation aborts the transaction instead of being silently skipped. The OIDs
-- are kept in transaction-local custom GUCs so the post-lock check can detect
-- same-name relation replacement without creating a helper object.
DO $retirement_relation_guard$
DECLARE
    v_comment_oid oid;
    v_interaction_oid oid;
BEGIN
    SELECT c.oid
    INTO v_comment_oid
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'comment_details'
      AND c.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.comment_details';
    END IF;
    PERFORM pg_catalog.set_config(
        'retirement.expected_comment_details_oid',
        v_comment_oid::text,
        true
    );

    SELECT c.oid
    INTO v_interaction_oid
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'interaction_logs'
      AND c.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.interaction_logs';
    END IF;
    PERFORM pg_catalog.set_config(
        'retirement.expected_interaction_logs_oid',
        v_interaction_oid::text,
        true
    );
END;
$retirement_relation_guard$;

-- Serialize against concurrent writes and dependency creation. The exact
-- qualified names are deliberately repeated so this lock cannot widen scope.
LOCK TABLE public.comment_details, public.interaction_logs IN ACCESS EXCLUSIVE MODE;

-- Re-resolve after locking. If a same-name relation replaced either reviewed
-- table before the lock, fail closed before reading rows or dependencies.
DO $retirement_relation_revalidation_guard$
DECLARE
    v_comment_oid oid;
    v_comment_relkind "char";
    v_interaction_oid oid;
    v_interaction_relkind "char";
BEGIN
    SELECT c.oid, c.relkind
    INTO v_comment_oid, v_comment_relkind
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'comment_details';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.comment_details';
    END IF;
    IF v_comment_relkind <> 'r'
       OR v_comment_oid::text IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.expected_comment_details_oid',
           true
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.comment_details';
    END IF;

    SELECT c.oid, c.relkind
    INTO v_interaction_oid, v_interaction_relkind
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'interaction_logs';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.interaction_logs';
    END IF;
    IF v_interaction_relkind <> 'r'
       OR v_interaction_oid::text IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.expected_interaction_logs_oid',
           true
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.interaction_logs';
    END IF;
END;
$retirement_relation_revalidation_guard$;

DO $retirement_evidence_guard$
DECLARE
    v_comment_rows bigint;
    v_interaction_rows bigint;
BEGIN
    SELECT count(*) INTO v_comment_rows FROM public.comment_details;
    IF v_comment_rows <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_NONEMPTY: public.comment_details has % rows', v_comment_rows;
    END IF;

    SELECT count(*) INTO v_interaction_rows FROM public.interaction_logs;
    IF v_interaction_rows <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_NONEMPTY: public.interaction_logs has % rows', v_interaction_rows;
    END IF;

    -- Any incoming FK is a newly introduced dependency relative to the
    -- reviewed evidence and blocks retirement. Outgoing FKs to
    -- public.analysis_results are not matched by this predicate.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS child ON child.oid = fk.conrelid
        JOIN pg_catalog.pg_namespace AS child_ns ON child_ns.oid = child.relnamespace
        JOIN pg_catalog.pg_class AS parent ON parent.oid = fk.confrelid
        JOIN pg_catalog.pg_namespace AS parent_ns ON parent_ns.oid = parent.relnamespace
        WHERE fk.contype = 'f'
          AND parent_ns.nspname = 'public'
          AND parent.relname IN ('comment_details', 'interaction_logs')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_INCOMING_DEPENDENCY: an incoming foreign key references public.comment_details or public.interaction_logs';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dep
        JOIN pg_catalog.pg_rewrite AS rw ON rw.oid = dep.objid
        JOIN pg_catalog.pg_class AS dependent_view ON dependent_view.oid = rw.ev_class
        JOIN pg_catalog.pg_namespace AS dependent_ns ON dependent_ns.oid = dependent_view.relnamespace
        JOIN pg_catalog.pg_class AS target ON target.oid = dep.refobjid
        JOIN pg_catalog.pg_namespace AS target_ns ON target_ns.oid = target.relnamespace
        WHERE target_ns.nspname = 'public'
          AND dep.classid = 'pg_catalog.pg_rewrite'::regclass
          AND dep.refclassid = 'pg_catalog.pg_class'::regclass
          AND target.relname IN ('comment_details', 'interaction_logs')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_DEPENDENT_VIEW: a view depends on public.comment_details or public.interaction_logs';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dep
        JOIN pg_catalog.pg_proc AS dependent_routine ON dependent_routine.oid = dep.objid
        JOIN pg_catalog.pg_namespace AS dependent_ns ON dependent_ns.oid = dependent_routine.pronamespace
        JOIN pg_catalog.pg_class AS target ON target.oid = dep.refobjid
        JOIN pg_catalog.pg_namespace AS target_ns ON target_ns.oid = target.relnamespace
        WHERE target_ns.nspname = 'public'
          AND dep.classid = 'pg_catalog.pg_proc'::regclass
          AND dep.refclassid = 'pg_catalog.pg_class'::regclass
          AND target.relname IN ('comment_details', 'interaction_logs')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_DEPENDENCY: a routine depends on public.comment_details or public.interaction_logs';
    END IF;

    -- pg_depend does not capture every PL/pgSQL body or literal dynamic SQL
    -- reference. Scan the current definitions token-by-token and abort on any
    -- mention; false positives are intentionally fail-closed.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS stored_routine
        WHERE stored_routine.prokind IN ('f', 'p')
          AND pg_catalog.pg_get_functiondef(stored_routine.oid) ~* E'\\m(comment_details|interaction_logs)\\M'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_DEFINITION_REFERENCE: a stored function or procedure mentions public.comment_details or public.interaction_logs';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS user_trigger
        JOIN pg_catalog.pg_class AS target ON target.oid = user_trigger.tgrelid
        JOIN pg_catalog.pg_namespace AS target_ns ON target_ns.oid = target.relnamespace
        WHERE NOT user_trigger.tgisinternal
          AND target_ns.nspname = 'public'
          AND target.relname IN ('comment_details', 'interaction_logs')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_USER_TRIGGER: a user trigger exists on public.comment_details or public.interaction_logs';
    END IF;

    -- Publications can include a target without a pg_publication_rel row.
    -- Reject all-table publications and any publication scoped to public in
    -- addition to retaining the explicit-table membership guard below.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication AS publication
        WHERE publication.puballtables
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_ALL_TABLES: a publication includes all tables';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_namespace AS publication_schema
        JOIN pg_catalog.pg_namespace AS target_schema
            ON target_schema.oid = publication_schema.pnnspid
        WHERE target_schema.nspname = 'public'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_SCHEMA: a publication includes schema public';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_rel AS publication_table
        JOIN pg_catalog.pg_class AS target ON target.oid = publication_table.prrelid
        JOIN pg_catalog.pg_namespace AS target_ns ON target_ns.oid = target.relnamespace
        WHERE target_ns.nspname = 'public'
          AND target.relname IN ('comment_details', 'interaction_logs')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_MEMBERSHIP: public.comment_details or public.interaction_logs belongs to a publication';
    END IF;
END;
$retirement_evidence_guard$;

-- The only destructive statements in this migration. No CASCADE is permitted.
DROP TABLE public.comment_details;
DROP TABLE public.interaction_logs;

COMMIT;
