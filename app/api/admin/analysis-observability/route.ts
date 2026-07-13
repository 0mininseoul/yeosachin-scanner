import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { hasValidAdminAuthorization } from '@/lib/services/instagram/admin-selection';
import { isValidAnalysisRequestId } from '@/lib/services/analysis/observability';
import { reconcileSettledAnalysisProviderCosts } from '@/lib/services/analysis/provider-cost-reconciliation';

const MAX_EVENT_ROWS = 500;

/** GET /api/admin/analysis-observability?requestId=<uuid> */
export async function GET(request: Request) {
    if (!hasValidAdminAuthorization(request.headers.get('authorization'))) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const requestId = new URL(request.url).searchParams.get('requestId');
    if (!isValidAnalysisRequestId(requestId)) {
        return NextResponse.json({ error: 'Valid requestId required' }, { status: 400 });
    }

    try {
        const reconciliation = await reconcileSettledAnalysisProviderCosts(
            supabaseAdmin,
            requestId
        );
        if (reconciliation.failed > 0 || reconciliation.hasMore) {
            console.warn('[analysis.observability] provider costs remain pending', {
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
    } catch {
        console.error('[analysis.observability] admin query failed');
        return NextResponse.json(
            { error: 'Failed to get analysis observability.' },
            { status: 500 }
        );
    }
}
