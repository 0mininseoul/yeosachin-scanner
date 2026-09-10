-- Supabase 22 interaction-evidence retirement draft (approval-gated; not a migration).
--
-- This file is intentionally outside supabase/migrations. It is a reversible,
-- report-only approval artifact. Do not execute it until the exact allowlist in
-- the companion manifest has owner approval and a separately reviewed apply
-- window exists. The active section refuses non-empty tables and catalog
-- dependencies before issuing the two exact, non-CASCADE DROP statements.

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

-- The only destructive statements in this draft. No CASCADE is permitted.
DROP TABLE public.comment_details;
DROP TABLE public.interaction_logs;

COMMIT;

/*
-- RESTORE ONLY — this exact SQL is intentionally commented so running the draft
-- cannot drop and recreate the relations in one invocation. If a restore is
-- approved, extract only this block and run it in an isolated reviewed window.

BEGIN;

CREATE TABLE public.comment_details (
    id UUID NOT NULL DEFAULT extensions.uuid_generate_v4(),
    result_id UUID NOT NULL,
    comment_text TEXT NOT NULL,
    author_id VARCHAR(100) NOT NULL,
    target_post_owner VARCHAR(100) NOT NULL,
    intimacy_level VARCHAR(10),
    intimacy_indicators TEXT[],
    confidence FLOAT,
    comment_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT comment_details_pkey PRIMARY KEY (id),
    CONSTRAINT comment_details_result_id_fkey
        FOREIGN KEY (result_id)
        REFERENCES public.analysis_results(id)
        ON DELETE CASCADE,
    CONSTRAINT comment_details_intimacy_level_check
        CHECK (intimacy_level IN ('intimate', 'normal'))
);

CREATE TABLE public.interaction_logs (
    id UUID NOT NULL DEFAULT extensions.uuid_generate_v4(),
    result_id UUID NOT NULL,
    interaction_type VARCHAR(20) NOT NULL,
    post_id VARCHAR(100),
    content TEXT,
    interaction_date TIMESTAMP WITH TIME ZONE,
    score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT interaction_logs_pkey PRIMARY KEY (id),
    CONSTRAINT interaction_logs_result_id_fkey
        FOREIGN KEY (result_id)
        REFERENCES public.analysis_results(id)
        ON DELETE CASCADE,
    CONSTRAINT interaction_logs_interaction_type_check
        CHECK (interaction_type IN ('like', 'comment', 'reply', 'post_tag', 'caption_mention', 'comment_mention'))
);

CREATE INDEX idx_comment_details_result_id
    ON public.comment_details(result_id);
CREATE INDEX idx_interaction_logs_result_id
    ON public.interaction_logs(result_id);

ALTER TABLE public.comment_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.interaction_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own comment details" ON public.comment_details
    FOR SELECT USING (
        EXISTS (
            SELECT 1
            FROM public.analysis_results
            JOIN public.analysis_requests
                ON public.analysis_requests.id = public.analysis_results.request_id
            WHERE public.analysis_results.id = public.comment_details.result_id
              AND public.analysis_requests.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can view own interaction logs" ON public.interaction_logs
    FOR SELECT USING (
        EXISTS (
            SELECT 1
            FROM public.analysis_results
            JOIN public.analysis_requests
                ON public.analysis_requests.id = public.analysis_results.request_id
            WHERE public.analysis_results.id = public.interaction_logs.result_id
              AND public.analysis_requests.user_id = auth.uid()
        )
    );

ALTER TABLE public.comment_details OWNER TO postgres;
ALTER TABLE public.interaction_logs OWNER TO postgres;

REVOKE ALL PRIVILEGES ON TABLE public.comment_details FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.interaction_logs FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.comment_details TO postgres, service_role;
GRANT ALL PRIVILEGES ON TABLE public.interaction_logs TO postgres, service_role;

COMMIT;
*/
