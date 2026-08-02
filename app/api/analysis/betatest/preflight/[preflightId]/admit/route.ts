import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ANALYSIS_V2_SCHEMA_VERSION, planIdSchema } from '@/lib/contracts/analysis-v2';
import {
    BETA_TEST_ACCESS_UNAVAILABLE,
    betaTestFreePoolEnabled,
    ensureBetaTestAccess,
} from '@/lib/services/analysis/betatest-access';
import {
    markAnalysisV2FreshAdmissionDispatched,
    reserveAnalysisV2FreshAdmission,
} from '@/lib/services/analysis/fresh-plan-admission';
import {
    enqueueFreshAdmissionTask,
    getPreflightTasksConfig,
} from '@/lib/services/analysis/preflight-tasks';
import {
    BETA_APIFY_PLAN_ACCESS_UNAVAILABLE,
    BETA_APIFY_PLAN_ADMISSION_ERROR,
    BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT,
    admitBetaApifyPlan,
    createBetaApifyPlanAdmissionStore,
} from '@/lib/services/analysis/beta-apify-plan-admission';
import {
    createBetaApifyCreditPoolStore,
    getBetaApifyCreditPoolRuntimeConfig,
} from '@/lib/services/analysis/beta-apify-credit-runtime';
import { dispatchAnalysisV2Job } from '@/lib/services/analysis/v2-tasks';
import { operationalLogger } from '@/lib/observability/server';

const idSchema = z.string().uuid().transform(value => value.toLowerCase());
const bodySchema = z.object({ planId: planIdSchema }).strict();
const BETA_ADMISSION_PENDING = 'BETA_ADMISSION_PENDING';
const BETA_CAPACITY_UNAVAILABLE = 'BETA_CAPACITY_UNAVAILABLE';
const BETA_ADMISSION_IDENTITY_CONFLICT = 'BETA_ADMISSION_IDENTITY_CONFLICT';

function failure(status: number, code: string, error: string) {
    return NextResponse.json({ schemaVersion: ANALYSIS_V2_SCHEMA_VERSION, code, error }, { status });
}

function betaAdmissionNonce(userId: string, preflightId: string): string {
    // Only a fixed-format non-secret idempotency witness for the legacy fresh
    // admission state machine. It is not an entitlement and is never exposed.
    return createHash('sha256').update(`betatest-admission-v1\n${userId}\n${preflightId}`).digest('hex');
}

type RouteContext = { params: Promise<{ preflightId: string }> };

export async function POST(request: Request, { params }: RouteContext): Promise<NextResponse> {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return failure(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    const preflight = idSchema.safeParse((await params).preflightId);
    let rawBody: unknown;
    try { rawBody = await request.json(); } catch { rawBody = null; }
    const body = bodySchema.safeParse(rawBody);
    if (!preflight.success || !body.success) {
        return failure(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const planStore = createBetaApifyPlanAdmissionStore(supabaseAdmin);
    try {
        const replay = await planStore.replayConsumed({
            preflightId: preflight.data,
            userId: user.id,
            selectedPlanId: body.data.planId,
        });
        if (replay) {
            try {
                await dispatchAnalysisV2Job(replay.requestId, replay.initialJobKey);
            } catch {
                return failure(503, 'QUEUE_UNAVAILABLE', '분석 작업을 시작할 수 없습니다.');
            }
            return NextResponse.json({
                schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
                requestId: replay.requestId,
                status: 'queued',
                backgroundProcessing: true,
            }, { status: 200 });
        }
    } catch (error) {
        if (
            error instanceof Error
            && error.message === BETA_APIFY_PLAN_REPLAY_IDENTITY_CONFLICT
        ) {
            return failure(
                409,
                BETA_ADMISSION_IDENTITY_CONFLICT,
                '이미 선택한 베타 플랜과 다릅니다.'
            );
        }
        return failure(503, BETA_ADMISSION_PENDING, '베타 분석을 준비할 수 없습니다.');
    }
    let maxSnapshotAgeSeconds: number;
    try {
        maxSnapshotAgeSeconds = getBetaApifyCreditPoolRuntimeConfig()
            .maxSnapshotAgeSeconds;
    } catch {
        return failure(503, BETA_ADMISSION_PENDING, '베타 분석을 준비할 수 없습니다.');
    }
    if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
        return failure(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
    }
    const owner = await supabaseAdmin
        .from('analysis_preflights')
        .select('id, user_id, analysis_entry_channel')
        .eq('id', preflight.data)
        .eq('user_id', user.id)
        .maybeSingle();
    if (owner.error) return failure(503, BETA_ADMISSION_PENDING, '베타 분석을 준비할 수 없습니다.');
    if (!owner.data || owner.data.analysis_entry_channel !== 'betatest') {
        return failure(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
    }

    try {
        // Recheck immediately before each mutation boundary; database RPCs
        // repeat the grant/channel checks transactionally for TOCTOU safety.
        if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
            return failure(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
        }
        const admission = await reserveAnalysisV2FreshAdmission(supabaseAdmin, {
            preflightId: preflight.data,
            userId: user.id,
            selectedPlanId: body.data.planId,
            entitlementJtiHash: betaAdmissionNonce(user.id, preflight.data),
        });
        if (admission.state === 'pending') {
            if (admission.shouldEnqueue && admission.dispatchToken) {
                const config = getPreflightTasksConfig();
                if (!config) return failure(503, BETA_ADMISSION_PENDING, '베타 분석을 준비할 수 없습니다.');
                if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
                    return failure(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
                }
                await enqueueFreshAdmissionTask(
                    preflight.data,
                    admission.generation,
                    admission.dispatchGeneration,
                    admission.dispatchToken,
                    { config }
                );
                if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
                    return failure(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
                }
                await markAnalysisV2FreshAdmissionDispatched(supabaseAdmin, {
                    preflightId: preflight.data, userId: user.id,
                    generation: admission.generation,
                    dispatchGeneration: admission.dispatchGeneration,
                    dispatchToken: admission.dispatchToken,
                });
            }
            return NextResponse.json({
                schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
                preflightId: preflight.data,
                code: BETA_ADMISSION_PENDING,
                status: 'admission_pending',
                retryAfterMs: 1_000,
            }, { status: 202, headers: { 'Retry-After': '1' } });
        }
        if (admission.state === 'blocked' || !admission.selectedPlanAllowed) {
            return failure(409, BETA_ADMISSION_PENDING, '베타 분석을 준비할 수 없습니다.');
        }
        if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
            return failure(403, BETA_TEST_ACCESS_UNAVAILABLE, '베타 분석을 사용할 수 없습니다.');
        }
        const poolStore = createBetaApifyCreditPoolStore(supabaseAdmin);
        const result = await admitBetaApifyPlan({
            preflightId: preflight.data,
            userId: user.id,
            admissionToken: admission.admissionToken,
            admissionGeneration: admission.generation,
            selectedPlanId: body.data.planId,
            maxSnapshotAgeSeconds,
            store: { ...poolStore, ...planStore },
            telemetry: operationalLogger,
        });
        try { await dispatchAnalysisV2Job(result.requestId, result.initialJobKey); } catch {
            return failure(503, 'QUEUE_UNAVAILABLE', '분석 작업을 시작할 수 없습니다.');
        }
        return NextResponse.json({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            requestId: result.requestId,
            status: 'queued',
            backgroundProcessing: true,
        }, { status: 200 });
    } catch (error) {
        if (
            error instanceof Error
            && error.message === BETA_APIFY_PLAN_ACCESS_UNAVAILABLE
        ) {
            return failure(
                403,
                BETA_TEST_ACCESS_UNAVAILABLE,
                '베타 분석을 사용할 수 없습니다.'
            );
        }
        if (error instanceof Error && error.message === BETA_APIFY_PLAN_ADMISSION_ERROR) {
            return failure(409, BETA_CAPACITY_UNAVAILABLE, '베타 분석을 준비할 수 없습니다.');
        }
        return failure(503, BETA_ADMISSION_PENDING, '베타 분석을 준비할 수 없습니다.');
    }
}
