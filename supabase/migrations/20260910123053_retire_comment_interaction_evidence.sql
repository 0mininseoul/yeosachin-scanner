-- Supabase 22 interaction-evidence retirement apply package.
-- Owner-approved exact allowlist; apply remains coordinator-controlled.

BEGIN;

-- Resolve the exact base relations before taking locks. A missing or replaced
-- relation aborts the transaction instead of being silently skipped.
DO $retirement_relation_guard$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'comment_details'
          AND c.relkind = 'r'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.comment_details';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'interaction_logs'
          AND c.relkind = 'r'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.interaction_logs';
    END IF;
END;
$retirement_relation_guard$;

-- Serialize against concurrent writes and dependency creation. The exact
-- qualified names are deliberately repeated so this lock cannot widen scope.
LOCK TABLE public.comment_details, public.interaction_logs IN ACCESS EXCLUSIVE MODE;

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
