import type { StandardConnection } from './standard-database';
import { readSharedResolverLedger, type SharedResolverObservation } from './standard-shared-resolver-observation';

export async function sharedStandardMeasurements(db: StandardConnection, requestIds: string[]) {
    // Ordinals keep per-owner latencies auditable without exporting identifiers.
    const times = await db.query<{ owner: number; admissionMs: number; paymentMs: number; ownerReadyMs: number; publishedWithinHour: boolean; withinHour: boolean }>(`
        SELECT n::int AS owner,
            round(1000 * extract(epoch FROM (e.occurred_at - r.created_at)))::int AS "admissionMs",
            round(1000 * extract(epoch FROM (e.occurred_at - o.paid_at)))::int AS "paymentMs",
            round(1000 * extract(epoch FROM (greatest(e.occurred_at, f.completed_at) - o.paid_at)))::int AS "ownerReadyMs",
            e.occurred_at <= o.paid_at + interval '1 hour' AS "publishedWithinHour",
            greatest(e.occurred_at, f.completed_at) <= o.paid_at + interval '1 hour' AS "withinHour"
        FROM unnest($1::uuid[]) WITH ORDINALITY owner(id,n)
        JOIN analysis_requests r USING (id)
        JOIN earlybird_orders o ON o.result_request_id = r.id
        JOIN earlybird_fulfillments f ON f.order_id=o.id AND f.completed_at IS NOT NULL
        JOIN analysis_progress_events e ON e.request_id = r.id AND e.event_code = 'ANALYSIS_COMPLETED'
        ORDER BY n
    `, [requestIds]);
    const stages = await db.query(`
        SELECT regexp_replace(job_key, ':[0-9]+$', ':*') AS stage, count(*)::int AS jobs,
            round(avg(1000 * extract(epoch FROM first_started_at - created_at)))::int AS "meanWaitMs",
            round(max(1000 * extract(epoch FROM completed_at - first_started_at)))::int AS "maxElapsedMs",
            sum(ai_capacity_deferral_count)::int AS deferrals
        FROM analysis_pipeline_jobs WHERE request_id = ANY($1::uuid[]) GROUP BY stage ORDER BY stage
    `, [requestIds]);
    const capacity = await db.query(`
        WITH leases AS (
            SELECT acquired_at,released_at FROM analysis_provider_admission_leases
            WHERE request_id=ANY($1::uuid[]) AND logical_provider='gemini' AND workload_role='paid'
        ), changes AS (
            SELECT acquired_at AS t,1 AS delta FROM leases UNION ALL SELECT released_at,-1 FROM leases WHERE released_at IS NOT NULL
        ), levels AS (SELECT sum(sum(delta)) OVER(ORDER BY t) AS level FROM changes GROUP BY t)
        SELECT count(*)::int AS "admissionReceipts",
            (SELECT coalesce(max(level),0)::int FROM levels) AS "peakReserved",
            round(sum(1000 * extract(epoch FROM released_at - acquired_at)))::bigint::text AS "slotMilliseconds",
            (SELECT coalesce(sum(capacity_skipped_count),0)::int FROM analysis_v2_gender_resolution_metrics
                WHERE request_id=ANY($1::uuid[])) AS "capacitySkippedResolver"
        FROM leases
    `, [requestIds]);
    const resolution = await db.query(`
        SELECT coalesce(sum(resolver_eligible_count),0)::int AS eligible,
            coalesce(sum(resolver_attempt_count),0)::int AS attempts,
            coalesce(sum(ready_count),0)::int AS ready,
            coalesce(sum(cutoff_count),0)::int AS cutoffs,
            coalesce(sum(capacity_skipped_count),0)::int AS skipped,
            coalesce(sum(terminal_unavailable_count),0)::int AS unavailable
        FROM analysis_v2_gender_resolution_metrics WHERE request_id=ANY($1::uuid[])
    `, [requestIds]);
    const resolutionByOwner = await db.query(`
        SELECT n::int AS owner, m.request_id IS NOT NULL AS recorded, m.metrics_finalized_at IS NOT NULL AS finalized,
            m.screened_count AS screened, m.resolver_eligible_count AS eligible, m.baseline_unknown_count AS "baselineUnknown",
            m.final_unknown_count AS "finalUnknown", m.ready_count AS ready, m.applied_count AS applied,
            m.applied_with_fenced_result_count AS "appliedWithProof", m.verified_baseline_mutation_count AS "verifiedBaselineMutations",
            m.inconclusive_count AS inconclusive, m.cutoff_count AS cutoffs, m.capacity_skipped_count AS skipped,
            m.terminal_unavailable_count AS unavailable, m.resolver_attempt_count AS attempts,
            m.resolver_usage_complete_count AS "usageComplete", m.resolver_usage_missing_count AS "usageMissing",
            m.resolver_cost_known_count AS "costKnown", m.resolver_nonterminal_attempt_count AS "nonterminalAttempts"
        FROM unnest($1::uuid[]) WITH ORDINALITY owner(id,n)
        LEFT JOIN analysis_v2_gender_resolution_metrics m ON m.request_id=owner.id ORDER BY n
    `, [requestIds]);
    const providerTimes = await db.query(`
        SELECT a.stage,p.release_reason AS "releaseReason",count(*)::int AS attempts,
            round(avg(a.latency_ms))::int AS "meanReportedLatencyMs",
            round(avg(1000 * extract(epoch FROM (p.released_at-p.acquired_at))))::int AS "meanLeaseMs",
            round(avg(1000 * extract(epoch FROM (p.released_at-a.terminalized_at))))::int AS "meanTerminalToReleaseMs"
        FROM analysis_v2_ai_attempts a
        JOIN analysis_provider_admission_leases p ON p.request_id=a.request_id AND p.job_key=a.job_key
            AND p.job_claim_token=a.job_claim_token AND p.workload_role='paid' AND p.logical_provider='gemini'
            AND p.operation_key='gemini:'||a.operation_key||':attempt:'||a.attempt::text
        WHERE a.request_id=ANY($1::uuid[]) GROUP BY a.stage,p.release_reason ORDER BY a.stage,p.release_reason
    `, [requestIds]);
    return {
        times: times.rows, stageTimes: stages.rows, capacity: capacity.rows[0], resolution: resolution.rows[0],
        providerTimes: providerTimes.rows, resolutionByOwner: resolutionByOwner.rows
    };
}

export async function sharedStandardFailureSummary(db: StandardConnection) {
    const requests = await db.query('SELECT status,count(*)::int AS n FROM analysis_requests GROUP BY status');
    const jobs = await db.query(`
        SELECT regexp_replace(job_key, ':[0-9]+$', ':*') AS stage, status, count(*)::int AS n,
            max(last_error_code) AS "lastCode", round(max(extract(epoch FROM clock_timestamp()-created_at)))::int AS "oldestSeconds"
        FROM analysis_pipeline_jobs WHERE status <> 'completed' GROUP BY stage,status ORDER BY stage,status
    `);
    const timing = await db.query(`
        SELECT count(*)::int AS paid,
            count(*) FILTER (WHERE e.occurred_at IS NOT NULL)::int AS published,
            count(*) FILTER (WHERE f.completed_at IS NOT NULL AND e.occurred_at IS NOT NULL
                AND greatest(f.completed_at,e.occurred_at)<=o.paid_at+interval '1 hour')::int AS "readyWithinHour",
            count(*) FILTER (WHERE f.completed_at IS NOT NULL AND e.occurred_at IS NOT NULL
                AND greatest(f.completed_at,e.occurred_at)>o.paid_at+interval '1 hour')::int AS "readyOverHour",
            count(*) FILTER (WHERE (f.completed_at IS NULL OR e.occurred_at IS NULL)
                AND clock_timestamp()>o.paid_at+interval '1 hour')::int AS "unfinishedOverHour"
        FROM earlybird_orders o LEFT JOIN earlybird_fulfillments f ON f.order_id=o.id
        LEFT JOIN analysis_progress_events e ON e.request_id=o.result_request_id AND e.event_code='ANALYSIS_COMPLETED'
        WHERE o.paid_at IS NOT NULL
    `);
    const leases = await db.query(`
        SELECT workload_role,logical_provider,state,count(*)::int AS n FROM analysis_provider_admission_leases
        GROUP BY workload_role,logical_provider,state ORDER BY workload_role,logical_provider,state
    `);
    const attempts = await db.query(`
        SELECT stage,status,count(*)::int AS n,
            count(*) FILTER (WHERE terminalized_at IS NULL)::int AS open,
            coalesce(round(sum(estimated_cost_usd)*1000000),0)::bigint::text AS "estimatedMicros"
        FROM analysis_v2_ai_attempts GROUP BY stage,status ORDER BY stage,status
    `);
    const holds = await db.query(`
        SELECT state,count(*)::int AS n,coalesce(round(sum(estimated_cost_usd)*1000000),0)::bigint::text AS "estimatedMicros",
            coalesce(round(sum(actual_cost_usd)*1000000),0)::bigint::text AS "settledMicros"
        FROM vertex_ai_budget_reservations GROUP BY state ORDER BY state
    `);
    const actors = await db.query(`
        SELECT phase,status,count(*)::int AS n,count(*) FILTER (WHERE usage_reconciled_at IS NULL)::int AS unreconciled,
               coalesce(round(sum(actual_usage_usd)*1000000),0)::bigint::text AS "knownMicros"
        FROM (SELECT 'paid' AS phase,status,usage_reconciled_at,actual_usage_usd FROM analysis_v2_provider_runs
              UNION ALL SELECT 'preflight',status,usage_reconciled_at,actual_usage_usd FROM analysis_preflight_provider_runs) a
        GROUP BY phase,status ORDER BY phase,status
    `);
    return {
        paymentTimingAtStop: timing.rows[0], requests: requests.rows, unfinished: jobs.rows, leases: leases.rows,
        attempts: attempts.rows, holds: holds.rows, actors: actors.rows
    };
}

// A failed admission can leave only a subset of the requests. This database belongs
// exclusively to the current synthetic wave. Read diagnostics independently of its workers.
export async function sharedStandardStopEvidence(db: StandardConnection, observation: SharedResolverObservation) {
    const [summary, resolver, unknown] = await Promise.allSettled([
        sharedStandardFailureSummary(db),
        readSharedResolverLedger(db, null).then(rows => observation.report(rows)),
        db.query<{
            count: number; estimatedMicros: number; resolverCount: number; resolverEstimatedMicros: number;
        }>(`
            SELECT count(*)::int AS count, coalesce(round(sum(estimated_cost_usd)*1000000),0)::int AS "estimatedMicros",
                count(*) FILTER (WHERE operation_key LIKE 'gender-resolution:%')::int AS "resolverCount",
                coalesce(round(sum(estimated_cost_usd) FILTER (WHERE operation_key LIKE 'gender-resolution:%')*1000000),0)::int
                    AS "resolverEstimatedMicros"
            FROM vertex_ai_budget_reservations WHERE state='settled' AND usage_unknown AND actual_cost_usd IS NULL
        `).then(({ rows }) => rows[0]),
    ]);
    const diagnosticsUnavailable: string[] = [];
    if (summary.status === 'rejected') diagnosticsUnavailable.push('pipeline_summary');
    if (resolver.status === 'rejected') diagnosticsUnavailable.push('resolver_ledger');
    if (unknown.status === 'rejected' || !unknown.value) diagnosticsUnavailable.push('unknown_budget');
    return {
        ...(summary.status === 'fulfilled' ? summary.value : {}),
        diagnosticsUnavailable,
        resolverEvidence: resolver.status === 'fulfilled'
            ? { coverage: 'database_and_sdk' as const, ...resolver.value }
            : { coverage: 'sdk_only' as const, ...observation.sdkSnapshot() },
        settledUnknownBudget: unknown.status === 'fulfilled' ? unknown.value ?? null : null,
    };
}

export async function databaseCounters(db: StandardConnection) {
    const { rows: [row] } = await db.query<{ read: number; hit: number; tempBytes: number; deadlocks: number }>(`
        SELECT blks_read::float8 AS read, blks_hit::float8 AS hit, temp_bytes::float8 AS "tempBytes", deadlocks::int AS deadlocks
        FROM pg_stat_database WHERE datname=current_database()
    `);
    return row;
}
