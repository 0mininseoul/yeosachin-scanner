import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { hasValidAdminAuthorization } from '@/lib/services/instagram/admin-selection';
import {
    classifyAnalysisFailure,
    isValidAnalysisRequestId,
} from '@/lib/services/analysis/observability';
import { reconcileSettledAnalysisProviderCosts } from '@/lib/services/analysis/provider-cost-reconciliation';
import {
    loadAnalysisV2OperationalObservability,
} from '@/lib/services/analysis/v2-operational-observability';
import { loadBetaApifyPoolObservability } from '@/lib/services/analysis/beta-apify-pool-observability';
import { getBetaApifyCreditPoolRuntimeConfig } from '@/lib/services/analysis/beta-apify-credit-runtime';

const MAX_EVENT_ROWS = 500;
const SAFE_OPERATIONAL_ERROR_CODES = new Set([
    'ANALYSIS_V2_OBSERVABILITY_VALIDATION_ERROR',
    'ANALYSIS_V2_OBSERVABILITY_PERSISTENCE_ERROR',
]);

function safeOperationalErrorCode(error: unknown): string {
    if (
        error instanceof Error
        && SAFE_OPERATIONAL_ERROR_CODES.has(error.message)
    ) {
        return error.message;
    }
    return 'OBSERVABILITY_QUERY_FAILED';
}

/** GET /api/admin/analysis-observability?requestId=<uuid> */
export async function GET(request: Request) {
    if (!hasValidAdminAuthorization(request.headers.get('authorization'))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const searchParams = new URL(request.url).searchParams;
    const scope = searchParams.get('scope');
    if (scope === 'betatest-pool') {
        try {
            const { maxSnapshotAgeSeconds } = getBetaApifyCreditPoolRuntimeConfig();
            const pool = await loadBetaApifyPoolObservability(
                supabaseAdmin, maxSnapshotAgeSeconds
            );
            return NextResponse.json({ success: true, scope, pool });
        } catch {
            console.error('[analysis.observability] betatest pool query failed', {
                scope: 'betatest-pool',
                errorCode: 'OBSERVABILITY_QUERY_FAILED',
            });
            return NextResponse.json(
                { error: 'Failed to get analysis observability.' },
                { status: 500 }
            );
        }
    }
    const requestId = searchParams.get('requestId');
    if (!isValidAnalysisRequestId(requestId)) {
        return NextResponse.json({ error: 'Valid requestId required' }, { status: 400 });
    }

    try {
        const v2 = await loadAnalysisV2OperationalObservability(
            supabaseAdmin,
            requestId
        );
        if (v2) {
            return NextResponse.json({
                success: true,
                ...v2,
                costPolicy: {
                    billingSource: 'analysis_v2_provider_runs+analysis_v2_ai_attempts',
                    providerCostBasis: 'actual_and_conservative',
                    geminiCostBasis: 'estimated',
                    gcpInfrastructureIncluded: false,
                },
            });
        }

        const reconciliation = await reconcileSettledAnalysisProviderCosts(
            supabaseAdmin,
            requestId
        );
        if (reconciliation.failed > 0 || reconciliation.hasMore) {
            console.warn('[analysis.observability] provider costs remain pending', {
                requestId,
                eligible: reconciliation.eligible,
                failed: reconciliation.failed,
                hasMore: reconciliation.hasMore,
            });
        }
        const [summaryResult, eventsResult] = await Promise.all([
            supabaseAdmin
                .from('analysis_operational_cost_summary')
                .select('*')
                .eq('request_id', requestId)
                .maybeSingle(),
            supabaseAdmin
                .from('analysis_step_events')
                .select(
                    'id, step, event_type, delivery_attempt, progress, latency_ms, failure_category, created_at'
                )
                .eq('request_id', requestId)
                .order('created_at', { ascending: true })
                .limit(MAX_EVENT_ROWS),
        ]);

        if (summaryResult.error || eventsResult.error) {
            throw new Error('Operational telemetry query failed.');
        }
        if (!summaryResult.data) {
            return NextResponse.json({ error: 'Request not found' }, { status: 404 });
        }

        return NextResponse.json({
            success: true,
            summary: summaryResult.data,
            events: eventsResult.data ?? [],
            eventsTruncated: (eventsResult.data?.length ?? 0) === MAX_EVENT_ROWS,
            costPolicy: {
                billingSource: 'analysis_provider_cost_ledger',
                scraperEstimateIsDiagnosticOnly: true,
                gcpInfrastructureIncluded: false,
            },
        });
    } catch (error) {
        console.error('[analysis.observability] admin query failed', {
            requestId,
            errorCode: safeOperationalErrorCode(error),
            failureCategory: classifyAnalysisFailure(error),
        });
        return NextResponse.json(
            { error: 'Failed to get analysis observability.' },
            { status: 500 }
        );
    }
}
