-- A verification shortlist is not a risk finding. Keep the historical provisional event
-- readable, but add a neutral confirmed event for new V2 screening checkpoints.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_progress_event(p_event JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_event IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_event) = 'object'
       AND p_event ?& ARRAY['state', 'eventCode', 'copyCode', 'aggregateCount']
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_event) AS event_key(value)
            WHERE event_key.value <> ALL (
                ARRAY['state', 'eventCode', 'copyCode', 'aggregateCount']
            )
       )
       AND p_event->>'state' IN ('provisional', 'confirmed', 'corrected')
       AND p_event->>'eventCode' IN (
            'TARGET_PROFILE_READY',
            'RELATIONSHIP_PROGRESS',
            'PROFILE_SCREENED',
            'SHORTLIST_READY',
            'POTENTIAL_HIGH_RISK_FOUND',
            'FINDING_CORRECTED',
            'FINDING_CONFIRMED',
            'ANALYSIS_COMPLETED'
       )
       AND p_event->>'copyCode' ~ '^[A-Z][A-Z0-9_]{0,63}$'
       AND (
            pg_catalog.jsonb_typeof(p_event->'aggregateCount') = 'null'
            OR (
                pg_catalog.jsonb_typeof(p_event->'aggregateCount') = 'number'
                AND p_event->>'aggregateCount' ~ '^(0|[1-9][0-9]{0,4})$'
                AND (p_event->>'aggregateCount')::INTEGER BETWEEN 0 AND 10000
            )
       )
       AND (
            p_event->>'eventCode' <> 'POTENTIAL_HIGH_RISK_FOUND'
            OR p_event->>'state' = 'provisional'
       )
       AND (
            p_event->>'eventCode' <> 'FINDING_CORRECTED'
            OR p_event->>'state' = 'corrected'
       )
       AND (
            p_event->>'eventCode' NOT IN (
                'SHORTLIST_READY', 'FINDING_CONFIRMED', 'ANALYSIS_COMPLETED'
            )
            OR p_event->>'state' = 'confirmed'
       );
$$;

ALTER TABLE public.analysis_progress_events
    DROP CONSTRAINT analysis_progress_events_code_check,
    ADD CONSTRAINT analysis_progress_events_code_check CHECK (
        event_code IN (
            'TARGET_PROFILE_READY',
            'RELATIONSHIP_PROGRESS',
            'PROFILE_SCREENED',
            'SHORTLIST_READY',
            'POTENTIAL_HIGH_RISK_FOUND',
            'FINDING_CORRECTED',
            'FINDING_CONFIRMED',
            'ANALYSIS_COMPLETED'
        )
    );

COMMENT ON FUNCTION public.analysis_v2_valid_progress_event(JSONB) IS
    'Validates sanitized V2 progress events; SHORTLIST_READY is neutral and confirmed.';
