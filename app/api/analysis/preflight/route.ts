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

export async function POST(request: Request) {
    try {
        const supabase = await createClient();
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            return errorResponse(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
        }
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
        }
        const parsed = preflightRequestV1Schema.safeParse(body);
        if (!parsed.success) {
            return errorResponse(400, 'INVALID_REQUEST', '인스타그램 아이디를 확인해주세요.');
        }

        const idempotencyKey = request.headers.get('idempotency-key')?.trim();
        if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
            return errorResponse(
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
            return errorResponse(
                503,
                'V2_PIPELINE_UNAVAILABLE',
                '새 분석 접수가 일시적으로 중단되었습니다.'
            );
        }
        const email = user.email?.trim();
        const provider = authProvider(user.app_metadata?.provider);
        if (!email || email.length > 320 || !provider) {
            return errorResponse(400, 'UNSUPPORTED_AUTH', '인증 정보를 확인할 수 없습니다.');
        }

        let dispatchPolicy;
        let accessMode;
        try {
            dispatchPolicy = resolvePreflightDispatchPolicy();
            accessMode = trustedPreflightAccessMode();
        } catch {
            return errorResponse(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
        }
        if (dispatchPolicy.mode === 'unavailable') {
            return errorResponse(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
        }
        if (signedTestAdmission && accessMode !== 'test_entitlement') {
            return errorResponse(
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
                return errorResponse(
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
                return errorResponse(
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
                try {
                    await processPreflight(created.preflightId);
                } catch {
                    console.error('Local preflight worker failed.');
                }
            });
        }

        return NextResponse.json(acceptedPreflightDto(created), {
            status: created.created ? 202 : 200,
        });
    } catch (error) {
        if (error instanceof PreflightIdempotencyConflictError) {
            return errorResponse(
                409,
                'IDEMPOTENCY_CONFLICT',
                '같은 Idempotency-Key가 다른 요청에 사용되었습니다.'
            );
        }
        if (error instanceof PreflightRateLimitedError) {
            return errorResponse(
                429,
                'PREFLIGHT_RATE_LIMITED',
                '사전 점검 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'
            );
        }
        if (error instanceof PreflightExpiredError) {
            return errorResponse(410, 'PREFLIGHT_EXPIRED', '사전 점검 요청이 만료되었습니다.');
        }
        if (error instanceof PreflightConsumedError) {
            return errorResponse(409, 'PREFLIGHT_CONSUMED', '이미 사용된 사전 점검 요청입니다.');
        }
        console.error('Preflight creation failed.');
        return errorResponse(500, 'ANALYSIS_FAILED', '사전 점검 요청 생성에 실패했습니다.');
    }
}
