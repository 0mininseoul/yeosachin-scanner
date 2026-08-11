import { z } from 'zod';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { analysisV2ProgressStore } from '@/lib/services/analysis/v2-progress-store';
import { createSupabaseAnalysisV2DagStateStore } from '@/lib/services/analysis/v2-dag-state-store';
import { hydratePersistedAnalysisDurationEstimate } from '@/lib/services/analysis/duration-estimate-store';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import { isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';

const requestIdSchema = z.string().uuid();
const PRIVATE_NO_STORE_HEADERS = {
    'Cache-Control': 'private, no-store, max-age=0',
    Vary: 'Cookie',
} as const;

function json(body: unknown, status: number) {
    return NextResponse.json(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ requestId: string }> },
) {
    try {
        const parsedRequestId = requestIdSchema.safeParse((await params).requestId);
        if (!parsedRequestId.success) return json({ error: 'Invalid duration request.' }, 400);

        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) return json({ error: 'Authentication required.' }, 401);

        try {
            await requireActiveAccountClassification(user.id);
        } catch (accountError) {
            if (accountError instanceof AccountPrincipalAdmissionError) {
                return json({ error: 'Account unavailable.' }, 403);
            }
            throw accountError;
        }

        const demo = await demoAnalysisStore.findForOwner(parsedRequestId.data, user.id);
        if (demo) {
            if (demo.user_id !== user.id || !isDemoOperator(user.id) || !demo.started_at) {
                return json({ error: 'Analysis duration not found.' }, 404);
            }
            // Synthetic demo is deliberately isolated from the production estimator.
            return json({
                source: 'demo', version: 'demo-v1', rangeSeconds: { lowSeconds: 60, highSeconds: 90 },
            }, 200);
        }

        const progress = await analysisV2ProgressStore.loadForOwner({
            requestId: parsedRequestId.data, userId: user.id, afterSequence: 0, eventLimit: 1,
        });
        if (!progress) return json({ error: 'Analysis duration not found.' }, 404);
        if (['completed', 'failed', 'upgrade_required'].includes(progress.snapshot.status)) {
            return json({ estimate: null }, 200);
        }

        const state = await createSupabaseAnalysisV2DagStateStore().load(parsedRequestId.data);
        if (!state) return json({ estimate: null }, 200);
        const hydrated = hydratePersistedAnalysisDurationEstimate(state);
        return json({ estimate: hydrated?.estimate ?? null }, 200);
    } catch {
        console.error('[analysis-duration] owner duration read failed');
        return json({ error: 'Analysis duration could not be loaded.' }, 500);
    }
}
