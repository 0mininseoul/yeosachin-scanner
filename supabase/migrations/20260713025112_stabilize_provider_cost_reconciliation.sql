-- Global reconciliation can recover terminal rows even after the original
-- request was deleted or no longer polled. Keep this queue scan bounded.
CREATE INDEX analysis_provider_cost_ledger_unfinalized_terminal
    ON public.analysis_provider_cost_ledger(terminal_at ASC)
    WHERE status <> 'running' AND cost_finalized_at IS NULL;

COMMENT ON COLUMN public.analysis_provider_cost_ledger.cost_finalized_at IS
    'Set only after an authenticated Apify run read at least thirty seconds after terminal state.';
COMMENT ON FUNCTION public.finalize_analysis_provider_cost(
    TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) IS 'Finalizes stable Apify usage after a conservative post-terminal settlement window.';
