import { after, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    preflightRequestV1Schema,
} from '@/lib/contracts/analysis-v2';
import {
    PreflightIdempotencyConflictError,
    PreflightRateLimitedError,
    PreflightConsumedError,
    PreflightExpiredError,
    acceptedPreflightDto,
    preflightStore,
    processPreflight,
    trustedPreflightAccessMode,
    type PreflightAuthProvider,
    type PreflightProcessObservation,
} from '@/lib/services/analysis/preflight';
import {
    PreflightTaskEnqueueError,
    enqueuePreflightTask,
    resolvePreflightDispatchPolicy,
} from '@/lib/services/analysis/preflight-tasks';
import {
    analysisTestEntitlementsEnabled,
    assertAnalysisTestEntitlementConfiguration,
    verifyAnalysisTestAdmission,
} from '@/lib/services/analysis/test-entitlement';
import { isAnalysisV2AdmissionAvailable } from '@/lib/services/analysis/v2-execution-gate';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import {
    flushOperationalLogs,
    operationalLogger,
} from '@/lib/observability/server';
import { emitPreflightProcessObservation } from '@/lib/observability/preflight-events';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function errorResponse(status: number, code: string, message: string): NextResponse {
    return NextResponse.json({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        code,
        error: message,
    }, { status });
}

function authProvider(value: unknown): PreflightAuthProvider | null {
    return value === 'google' || value === 'kakao' ? value : null;
}

function preflightErrorCode(code: string): string {
    if (code === 'UNAUTHORIZED') return 'UNAUTHORIZED';
    if (code === 'PREFLIGHT_RATE_LIMITED') return 'RATE_LIMITED';
    if (code === 'NOT_FOUND') return 'NOT_FOUND';
    if (code === 'QUEUE_UNAVAILABLE' || code === 'V2_PIPELINE_UNAVAILABLE') {
        return 'JOB_DISPATCH_NOT_READY';
    }
    if (code.includes('INVALID') || code === 'UNSUPPORTED_AUTH') return 'VALIDATION_ERROR';
    return 'INTERNAL_ERROR';
}

function hasValidSignedTestAdmission(
    request: Request,
    input: { userId: string; targetInstagramId: string; idempotencyKey: string }
): boolean {
    try {
        if (!analysisTestEntitlementsEnabled()) return false;
        assertAnalysisTestEntitlementConfiguration();
        return verifyAnalysisTestAdmission(
            request.headers.get('x-analysis-test-admission'),
            input
        ) !== null;
    } catch {
        return false;
    }
}

async function handlePOST(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    let userId: string | undefined;
    let targetInstagramId: string | undefined;
    let provider: PreflightAuthProvider | null = null;
    let preflightId: string | undefined;
    const failed = (status: number, code: string, message: string): NextResponse => {
        operationalLogger.emit({
            event: 'preflight.failed',
            severity: status >= 500 ? 'error' : 'warn',
            fields: {
                ...context,
                ...(userId ? { user_id: userId } : {}),
                ...(preflightId ? { preflight_id: preflightId } : {}),
                ...(targetInstagramId ? { target_instagram_id: targetInstagramId } : {}),
                ...(provider ? { provider } : {}),
                operation: 'preflight',
                disposition: status === 429
                    ? 'rate_limited'
                    : status >= 500 ? 'failed' : 'rejected',
                error_code: preflightErrorCode(code),
            },
        });
        return errorResponse(status, code, message);
    };

    try {
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            return failed(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
        }
        userId = user.id;
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return failed(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
        }
        const parsed = preflightRequestV1Schema.safeParse(body);
        if (!parsed.success) {
            return failed(400, 'INVALID_REQUEST', '인스타그램 아이디를 확인해주세요.');
        }
        targetInstagramId = parsed.data.targetInstagramId;

        const idempotencyKey = request.headers.get('idempotency-key')?.trim();
        if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
            return failed(
                400,
                'INVALID_IDEMPOTENCY_KEY',
                '올바른 Idempotency-Key가 필요합니다.'
            );
        }
        const publicAdmission = isAnalysisV2AdmissionAvailable();
        const signedTestAdmission = !publicAdmission && hasValidSignedTestAdmission(
            request,
            {
                userId: user.id,
                targetInstagramId: parsed.data.targetInstagramId,
                idempotencyKey,
            }
        );
        if (!publicAdmission && !signedTestAdmission) {
            return failed(
                503,
                'V2_PIPELINE_UNAVAILABLE',
                '새 분석 접수가 일시적으로 중단되었습니다.'
            );
        }
        const email = user.email?.trim();
        provider = authProvider(user.app_metadata?.provider);
        if (!email || email.length > 320 || !provider) {
            return failed(400, 'UNSUPPORTED_AUTH', '인증 정보를 확인할 수 없습니다.');
        }

        let dispatchPolicy;
        let accessMode;
        try {
            dispatchPolicy = resolvePreflightDispatchPolicy();
            accessMode = trustedPreflightAccessMode();
        } catch {
            return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
        }
        if (dispatchPolicy.mode === 'unavailable') {
            return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
        }
        if (signedTestAdmission && accessMode !== 'test_entitlement') {
            return failed(
                503,
                'V2_PIPELINE_UNAVAILABLE',
                '테스트 분석 접수 설정이 활성화되지 않았습니다.'
            );
        }

        const created = await preflightStore.createOrReplay({
            userId: user.id,
            email,
            authProvider: provider,
            targetInstagramId: parsed.data.targetInstagramId,
            idempotencyKey,
            accessMode,
        });
        preflightId = created.preflightId;
        if (created.status === 'expired') throw new PreflightExpiredError();
        if (created.status === 'consumed') throw new PreflightConsumedError();

        const reservation = await preflightStore.reserveDispatch(
            created.preflightId,
            user.id
        );
        if (reservation.status === 'expired') throw new PreflightExpiredError();
        if (reservation.status === 'consumed') throw new PreflightConsumedError();

        if (reservation.shouldEnqueue && dispatchPolicy.mode === 'queue') {
            try {
                await enqueuePreflightTask(created.preflightId, reservation.generation, {
                    config: dispatchPolicy.config,
                });
            } catch (error) {
                if (
                    error instanceof PreflightTaskEnqueueError
                    && error.disposition === 'terminal'
                ) {
                    try {
                        await preflightStore.blockQueueUnavailable(created.preflightId, user.id);
                    } catch {
                        console.error('Preflight queue failure terminalization failed.');
                    }
                }
                return failed(
                    503,
                    'QUEUE_UNAVAILABLE',
                    '사전 점검 작업 큐를 사용할 수 없습니다.'
                );
            }
            try {
                await preflightStore.markDispatched({
                    preflightId: created.preflightId,
                    userId: user.id,
                    generation: reservation.generation,
                    reservationToken: reservation.reservationToken!,
                });
            } catch {
                return failed(
                    503,
                    'QUEUE_UNAVAILABLE',
                    '사전 점검 작업 상태를 확정할 수 없습니다.'
                );
            }
        } else if (reservation.shouldEnqueue) {
            await preflightStore.markDispatched({
                preflightId: created.preflightId,
                userId: user.id,
                generation: reservation.generation,
                reservationToken: reservation.reservationToken!,
            });
            after(async () => {
                let failureObserved = false;
                try {
                    await processPreflight(created.preflightId, {
                        observer(observation: PreflightProcessObservation) {
                            if (observation.type === 'failed') failureObserved = true;
                            emitPreflightProcessObservation(context, observation);
                        },
                    });
                } catch {
                    console.error('Local preflight worker failed.');
                    if (!failureObserved) {
                        operationalLogger.emit({
                            event: 'preflight.failed',
                            severity: 'error',
                            fields: {
                                ...context,
                                user_id: user.id,
                                preflight_id: created.preflightId,
                                target_instagram_id: parsed.data.targetInstagramId,
                                operation: 'profile',
                                disposition: 'failed',
                                retryable: true,
                                error_code: 'UNKNOWN',
                            },
                        });
                    }
                } finally {
                    await flushOperationalLogs();
                }
            });
        }

        operationalLogger.emit({
            event: 'preflight.requested',
            severity: 'info',
            fields: {
                ...context,
                user_id: user.id,
                preflight_id: created.preflightId,
                target_instagram_id: parsed.data.targetInstagramId,
                provider,
                operation: 'preflight',
                disposition: 'requested',
            },
        });
        return NextResponse.json(acceptedPreflightDto(created), {
            status: created.created ? 202 : 200,
        });
    } catch (error) {
        if (error instanceof PreflightIdempotencyConflictError) {
            return failed(
                409,
                'IDEMPOTENCY_CONFLICT',
                '같은 Idempotency-Key가 다른 요청에 사용되었습니다.'
            );
        }
        if (error instanceof PreflightRateLimitedError) {
            return failed(
                429,
                'PREFLIGHT_RATE_LIMITED',
                '사전 점검 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'
            );
        }
        if (error instanceof PreflightExpiredError) {
            return failed(410, 'PREFLIGHT_EXPIRED', '사전 점검 요청이 만료되었습니다.');
        }
        if (error instanceof PreflightConsumedError) {
            return failed(409, 'PREFLIGHT_CONSUMED', '이미 사용된 사전 점검 요청입니다.');
        }
        console.error('Preflight creation failed.');
        return failed(500, 'ANALYSIS_FAILED', '사전 점검 요청 생성에 실패했습니다.');
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/analysis/preflight',
        context => handlePOST(request, context),
    );
}
