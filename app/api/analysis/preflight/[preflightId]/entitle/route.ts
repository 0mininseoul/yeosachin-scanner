import { z } from 'zod';
import { NextResponse } from 'next/server';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    planIdSchema,
} from '@/lib/contracts/analysis-v2';
import {
    analysisTestEntitlementsEnabled,
    assertAnalysisTestEntitlementConfiguration,
    verifyAnalysisTestEntitlement,
} from '@/lib/services/analysis/test-entitlement';
import {
    AnalysisV2EntitlementConsumptionError,
    consumeAnalysisV2TestEntitlement,
    hashAnalysisTestEntitlementJti,
    validatePreflightForTestEntitlement,
    type AnalysisV2InitialJobDispatcher,
    type AnalysisV2EntitlementErrorCode,
    type AnalysisV2PreflightRow,
} from '@/lib/services/analysis/test-entitlement-consumption';
import {
    configuredAuthorizedTestProviderPolicy,
} from '@/lib/services/analysis/authorized-test-provider-policy';
import {
    AnalysisV2FreshAdmissionError,
    markAnalysisV2FreshAdmissionDispatched,
    releaseAnalysisV2FreshAdmissionDispatch,
    reserveAnalysisV2FreshAdmission,
    type AnalysisV2FreshPlanSnapshot,
    type AnalysisV2FreshAdmissionErrorCode,
} from '@/lib/services/analysis/fresh-plan-admission';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
    enqueueFreshAdmissionTask,
    getPreflightTasksConfig,
} from '@/lib/services/analysis/preflight-tasks';
import {
    dispatchAnalysisV2Job,
    getAnalysisV2TasksConfig,
} from '@/lib/services/analysis/v2-tasks';

const uuidSchema = z.string().uuid().transform(value => value.toLowerCase());
const requestBodySchema = z.object({
    planId: planIdSchema,
}).strict();
type EntitlementRouteContext = { params: Promise<{ preflightId: string }> };

const PREFLIGHT_COLUMNS = [
    'id',
    'user_id',
    'status',
    'expires_at',
    'target_instagram_id',
    'target_followers_count',
    'target_following_count',
    'access_mode',
    'capacity_required_plan_id',
    'required_plan_id',
    'launch_status_snapshot',
    'plan_cards_snapshot',
    'exclusion_decision',
    'excluded_instagram_id',
    'pricing_version',
    'pricing_snapshot',
    'consumed_request_id',
].join(', ');

const ERROR_STATUS: Readonly<Record<AnalysisV2EntitlementErrorCode, number>> = {
    ANALYSIS_V2_PREFLIGHT_NOT_FOUND: 404,
    ANALYSIS_V2_PREFLIGHT_NOT_READY: 409,
    ANALYSIS_V2_PREFLIGHT_EXPIRED: 410,
    ANALYSIS_V2_EXCLUSION_REQUIRED: 409,
    ANALYSIS_V2_PLAN_NOT_ALLOWED: 409,
    ANALYSIS_V2_ENTITLEMENT_CONFLICT: 409,
    ANALYSIS_ALREADY_IN_PROGRESS: 409,
    ANALYSIS_V2_AUTHORIZED_TEST_POLICY_INVALID: 503,
    ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SCOPE_MISMATCH: 403,
    ANALYSIS_V2_AUTHORIZED_TEST_POLICY_CONFLICT: 409,
    ANALYSIS_V2_AUTHORIZED_TEST_POLICY_TOO_LATE: 409,
};

const FRESH_ADMISSION_ERROR_STATUS: Readonly<
Record<AnalysisV2FreshAdmissionErrorCode, number>
> = {
    ANALYSIS_V2_PREFLIGHT_NOT_FOUND: 404,
    ANALYSIS_V2_PREFLIGHT_NOT_READY: 409,
    ANALYSIS_V2_PREFLIGHT_EXPIRED: 410,
    ANALYSIS_V2_PLAN_NOT_ALLOWED: 409,
    ANALYSIS_V2_TARGET_NOT_FOUND: 409,
    ANALYSIS_V2_TARGET_PRIVATE: 409,
    ANALYSIS_V2_TARGET_MISMATCH: 409,
    ANALYSIS_V2_OVER_PLUS_CAPACITY: 409,
    ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE: 503,
};

function entitlementError(code: AnalysisV2EntitlementErrorCode) {
    return NextResponse.json(
        { error: '분석 테스트 이용권을 사용할 수 없습니다.', code },
        { status: ERROR_STATUS[code] }
    );
}

function freshAdmissionError(
    code: AnalysisV2FreshAdmissionErrorCode,
    latestPlan: AnalysisV2FreshPlanSnapshot | null = null
) {
    return NextResponse.json(
        {
            error: '최신 계정 정보로 분석 가능 여부를 확인할 수 없습니다.',
            code,
            ...(latestPlan ? { latestPlan } : {}),
        },
        { status: FRESH_ADMISSION_ERROR_STATUS[code] }
    );
}

async function dispatchInitialJob(
    dispatcher: AnalysisV2InitialJobDispatcher,
    requestId: string,
    jobKey: Parameters<AnalysisV2InitialJobDispatcher>[1]
) {
    await dispatcher(requestId, jobKey);
}

export async function POST(
    request: Request,
    { params }: EntitlementRouteContext
) {
    try {
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: '로그인이 필요합니다.', code: 'AUTHENTICATION_REQUIRED' },
                { status: 401 }
            );
        }
        let entitlementsEnabled = false;
        try {
            entitlementsEnabled = analysisTestEntitlementsEnabled();
            if (entitlementsEnabled) assertAnalysisTestEntitlementConfiguration();
        } catch {
            console.error('Analysis V2 test entitlement configuration is invalid.');
            return NextResponse.json(
                {
                    error: '분석 테스트 이용권 설정을 확인할 수 없습니다.',
                    code: 'TEST_ENTITLEMENTS_UNAVAILABLE',
                },
                { status: 503 }
            );
        }
        if (!entitlementsEnabled) {
            return NextResponse.json(
                {
                    error: '분석 테스트 이용권 기능이 비활성화되어 있습니다.',
                    code: 'TEST_ENTITLEMENTS_DISABLED',
                },
                { status: 503 }
            );
        }
        const parsedPreflightId = uuidSchema.safeParse((await params).preflightId);
        if (!parsedPreflightId.success) {
            return NextResponse.json(
                { error: '사전 점검 ID가 올바르지 않습니다.', code: 'INVALID_PREFLIGHT_ID' },
                { status: 400 }
            );
        }
        const preflightId = parsedPreflightId.data;

        let rawBody: unknown;
        try {
            rawBody = await request.json();
        } catch {
            return NextResponse.json(
                { error: '요청 형식이 올바르지 않습니다.', code: 'INVALID_REQUEST' },
                { status: 400 }
            );
        }
        const body = requestBodySchema.safeParse(rawBody);
        if (!body.success) {
            return NextResponse.json(
                { error: '요청 형식이 올바르지 않습니다.', code: 'INVALID_REQUEST' },
                { status: 400 }
            );
        }

        const entitlementToken = request.headers.get('x-analysis-test-entitlement');
        if (!entitlementToken) {
            return NextResponse.json(
                { error: '유효한 분석 테스트 이용권이 필요합니다.', code: 'INVALID_ENTITLEMENT' },
                { status: 403 }
            );
        }

        const entitlement = verifyAnalysisTestEntitlement(entitlementToken, {
            preflightId,
            userId: user.id,
            planId: body.data.planId,
        });
        if (!entitlement) {
            return NextResponse.json(
                { error: '유효한 분석 테스트 이용권이 필요합니다.', code: 'INVALID_ENTITLEMENT' },
                { status: 403 }
            );
        }
        const entitlementJtiHash = hashAnalysisTestEntitlementJti(entitlement.nonce);
        const preflightQuery = await supabaseAdmin
            .from('analysis_preflights')
            .select(PREFLIGHT_COLUMNS)
            .eq('id', preflightId)
            .eq('user_id', user.id)
            .maybeSingle();
        if (preflightQuery.error) {
            throw new Error('ANALYSIS_V2_ENTITLEMENT_ROUTE_ERROR: preflight read failed.');
        }
        if (!preflightQuery.data) {
            return entitlementError('ANALYSIS_V2_PREFLIGHT_NOT_FOUND');
        }

        const row = preflightQuery.data as unknown as AnalysisV2PreflightRow;
        if (row.id !== preflightId || row.user_id !== user.id.toLowerCase()) {
            return entitlementError('ANALYSIS_V2_PREFLIGHT_NOT_FOUND');
        }

        const validatedPreflight = validatePreflightForTestEntitlement(
            row,
            body.data.planId,
            { deferPlanSelectionToFreshAdmission: true }
        );
        let providerExecutionPolicy;
        try {
            providerExecutionPolicy = configuredAuthorizedTestProviderPolicy(
                {
                    targetUsername: row.target_instagram_id,
                    ownerUserId: user.id,
                }
            );
        } catch {
            console.error('Authorized analysis test provider policy is invalid.');
            return NextResponse.json(
                {
                    error: '분석 테스트 공급자 설정을 확인할 수 없습니다.',
                    code: 'TEST_PROVIDER_POLICY_UNAVAILABLE',
                },
                { status: 503 }
            );
        }

        let analysisTasksConfig;
        let preflightTasksConfig;
        if (validatedPreflight.state === 'ready') {
            try {
                analysisTasksConfig = getAnalysisV2TasksConfig();
                preflightTasksConfig = getPreflightTasksConfig();
                if (!analysisTasksConfig || !preflightTasksConfig) {
                    throw new Error('queue disabled');
                }
            } catch {
                console.error('Analysis V2 task queue configuration is unavailable.');
                return NextResponse.json(
                    { error: '분석 작업 큐를 사용할 수 없습니다.', code: 'QUEUE_UNAVAILABLE' },
                    { status: 503 }
                );
            }
        }

        let admissionToken: string | null = null;
        if (validatedPreflight.state === 'ready') {
            const admission = await reserveAnalysisV2FreshAdmission(supabaseAdmin, {
                preflightId,
                userId: user.id,
                selectedPlanId: body.data.planId,
                entitlementJtiHash,
            });
            if (admission.state === 'pending') {
                if (admission.shouldEnqueue) {
                    const dispatch = {
                        preflightId,
                        userId: user.id,
                        generation: admission.generation,
                        dispatchGeneration: admission.dispatchGeneration,
                        dispatchToken: admission.dispatchToken!,
                    };
                    try {
                        await enqueueFreshAdmissionTask(
                            preflightId,
                            admission.generation,
                            admission.dispatchGeneration,
                            admission.dispatchToken!,
                            { config: preflightTasksConfig! }
                        );
                    } catch {
                        try {
                            await releaseAnalysisV2FreshAdmissionDispatch(
                                supabaseAdmin,
                                dispatch
                            );
                        } catch {
                            console.error(
                                'Analysis V2 fresh admission dispatch release failed.'
                            );
                        }
                        console.error('Analysis V2 fresh admission dispatch failed.');
                        return NextResponse.json(
                            {
                                error: '최신 계정 확인 작업을 시작할 수 없습니다.',
                                code: 'QUEUE_UNAVAILABLE',
                            },
                            { status: 503 }
                        );
                    }
                    try {
                        await markAnalysisV2FreshAdmissionDispatched(
                            supabaseAdmin,
                            dispatch
                        );
                    } catch {
                        console.error('Analysis V2 fresh admission dispatch mark failed.');
                        return NextResponse.json(
                            {
                                error: '최신 계정 확인 작업 상태를 확정할 수 없습니다.',
                                code: 'QUEUE_UNAVAILABLE',
                            },
                            { status: 503 }
                        );
                    }
                }
                return NextResponse.json({
                    schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
                    preflightId,
                    status: 'admission_pending',
                    backgroundProcessing: true,
                    retryAfterMs: 1_000,
                }, {
                    status: 202,
                    headers: { 'Retry-After': '1' },
                });
            }
            if (admission.state === 'blocked') {
                return freshAdmissionError(admission.errorCode, admission.snapshot);
            }
            if (!admission.selectedPlanAllowed) {
                return freshAdmissionError(
                    'ANALYSIS_V2_PLAN_NOT_ALLOWED',
                    admission.snapshot
                );
            }
            admissionToken = admission.admissionToken;
        }
        const consumed = await consumeAnalysisV2TestEntitlement(supabaseAdmin, {
            preflightId,
            userId: user.id,
            selectedPlanId: body.data.planId,
            entitlementJtiHash,
            admissionToken,
            ...(providerExecutionPolicy ? {
                targetUsername: row.target_instagram_id,
                providerExecutionPolicy,
            } : {}),
        });

        const terminal = consumed.requestStatus === 'completed'
            || consumed.requestStatus === 'failed';
        if (!terminal) {
            try {
                await dispatchInitialJob(
                    dispatchAnalysisV2Job,
                    consumed.requestId,
                    consumed.initialJobKey
                );
            } catch {
                // The transaction already persisted a recoverable outbox job. A replay
                // uses the same request and job key instead of consuming another token.
                console.error('Analysis V2 initial job dispatch failed.');
                return NextResponse.json(
                    { error: '분석 작업 큐를 사용할 수 없습니다.', code: 'QUEUE_UNAVAILABLE' },
                    { status: 503 }
                );
            }
        }

        const responseStatus = consumed.requestStatus === 'pending'
            ? 'queued'
            : consumed.requestStatus;
        const backgroundProcessing = consumed.requestStatus === 'pending'
            ? true
            : consumed.backgroundProcessing;

        return NextResponse.json({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            requestId: consumed.requestId,
            status: responseStatus,
            backgroundProcessing,
        }, { status: consumed.created ? 201 : 200 });
    } catch (error) {
        if (error instanceof AnalysisV2FreshAdmissionError) {
            return freshAdmissionError(error.code);
        }
        if (error instanceof AnalysisV2EntitlementConsumptionError) {
            return entitlementError(error.code);
        }
        // Deliberately omit request headers and error details: they may contain credentials.
        console.error('Analysis V2 test entitlement consumption failed.');
        return NextResponse.json(
            { error: '분석 요청 생성에 실패했습니다.', code: 'ANALYSIS_START_FAILED' },
            { status: 500 }
        );
    }
}
