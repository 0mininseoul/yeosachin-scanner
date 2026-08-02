SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_v2_provider_execution_policies
    VALIDATE CONSTRAINT analysis_v2_provider_execution_policies_branch_check;
