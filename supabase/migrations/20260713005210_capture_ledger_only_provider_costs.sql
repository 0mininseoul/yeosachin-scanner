-- Keep the summary conservative even if a ledger insert occurs outside the
-- normal provider-run reservation path. This also closes the brief deployment
-- window between expectation backfill and the provider-run trigger creation.
INSERT INTO public.analysis_provider_usage_expectations (
    request_id,
    operation_key,
    logical_provider,
    actor_id,
    max_charge_usd,
    created_at
)
SELECT
    request_id,
    operation_key,
    logical_provider,
    actor_id,
    max_charge_usd,
    created_at
FROM public.analysis_provider_cost_ledger
WHERE request_id IS NOT NULL
ON CONFLICT (request_id, operation_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.capture_analysis_provider_cost_expectation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.request_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.analysis_provider_usage_expectations (
        request_id,
        operation_key,
        logical_provider,
        actor_id,
        max_charge_usd,
        created_at
    ) VALUES (
        NEW.request_id,
        NEW.operation_key,
        NEW.logical_provider,
        NEW.actor_id,
        NEW.max_charge_usd,
        NEW.created_at
    )
    ON CONFLICT (request_id, operation_key) DO UPDATE
    SET logical_provider = EXCLUDED.logical_provider,
        actor_id = EXCLUDED.actor_id,
        max_charge_usd = EXCLUDED.max_charge_usd
    WHERE public.analysis_provider_usage_expectations.logical_provider = EXCLUDED.logical_provider
      AND public.analysis_provider_usage_expectations.actor_id = EXCLUDED.actor_id
      AND public.analysis_provider_usage_expectations.max_charge_usd = EXCLUDED.max_charge_usd;

    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_COST_EXPECTATION_MISMATCH',
            ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS capture_analysis_provider_cost_expectation
    ON public.analysis_provider_cost_ledger;
CREATE TRIGGER capture_analysis_provider_cost_expectation
    AFTER INSERT ON public.analysis_provider_cost_ledger
    FOR EACH ROW
    EXECUTE FUNCTION public.capture_analysis_provider_cost_expectation();

REVOKE ALL ON FUNCTION public.capture_analysis_provider_cost_expectation()
    FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.capture_analysis_provider_cost_expectation() IS
    'Ensures every correlated provider cost ledger row participates in the expectation-anchored operational summary.';
