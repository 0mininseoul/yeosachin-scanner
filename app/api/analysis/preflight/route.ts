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
    preflightEnqueueFailureCode,
    preflightEnqueueFailureMetadata,
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
    suppressOperationalObservation,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import {
    flushOperationalLogs,
    operationalLogger,
} from '@/lib/observability/server';
import { emitPreflightProcessObservation } from '@/lib/observability/preflight-events';
import { demoResponseHeaders, isDemoEligible } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    bestEffortBetaApifySettlement,
    settleBetaApifyPreflightCredit,
} from '@/lib/services/analysis/beta-apify-credit-settlement-runtime';
import {
    preflightFailureReason,
    recordPreflightFailure,
} from '@/lib/services/analysis/preflight-failure-ledger';
import {
    AnonymousPreflightClaimInvalidError,
    AnonymousPreflightIdempotencyConflictError,
    AnonymousPreflightRateLimitedError,
    createAnonymousAnalysisV2Preflight,
    markAnonymousAnalysisV2PreflightDispatched,
    reserveAnonymousAnalysisV2PreflightDispatch,
    reserveAnonymousPreflightBudget,
    type AnonymousPreflightClient,
} from '@/lib/services/analysis/anonymous-preflight';
import {
    createAnonymousPreflightClaim,
    hashAnonymousRateLimitValue,
    requestClientIp,
} from '@/lib/services/analysis/anonymous-preflight-claim';
import { preflightTargetInputHash } from '@/lib/services/analysis/preflight-identity';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
    requireActiveE2eTestRunner,
} from '@/lib/services/identity/account-principal-store';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

function errorResponse(status: number, code: string, message: string): NextResponse {
    return NextResponse.json({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        code,
        error: message,
    }, { status });
}

function authProvider(
    value: unknown,
    options: { allowSignedE2eEmail: boolean } = { allowSignedE2eEmail: false },
): PreflightAuthProvider | null {
    if (value === 'google' || value === 'kakao') return value;
    if (options.allowSignedE2eEmail && value === 'email') return value;
    return null;
}

function preflightErrorCode(code: string): string {
    if (code === 'UNAUTHORIZED') return 'UNAUTHORIZED';
    if (code === 'ACCOUNT_ADMISSION_DENIED') return 'UNAUTHORIZED';
    if (code === 'PREFLIGHT_RATE_LIMITED') return 'RATE_LIMITED';
    if (code === 'NOT_FOUND') return 'NOT_FOUND';
    if (code === 'QUEUE_UNAVAILABLE' || code === 'V2_PIPELINE_UNAVAILABLE') {
        return 'JOB_DISPATCH_NOT_READY';
    }
    if (code.includes('INVALID') || code === 'UNSUPPORTED_AUTH') return 'VALIDATION_ERROR';
    return 'INTERNAL_ERROR';
}

type SignedTestAdmissionState = 'absent' | 'valid' | 'invalid';

function signedTestAdmissionState(
    request: Request,
    input: { userId: string; targetInstagramId: string; idempotencyKey: string }
): SignedTestAdmissionState {
    const token = request.headers.get('x-analysis-test-admission');
    if (token === null) return 'absent';
    if (!token.trim()) return 'invalid';
    try {
        if (!analysisTestEntitlementsEnabled()) return 'invalid';
        assertAnalysisTestEntitlementConfiguration();
        return verifyAnalysisTestAdmission(
            token,
            input
        ) !== null ? 'valid' : 'invalid';
    } catch {
        return 'invalid';
    }
}

function anonymousPreflightDailyLimit(
    env: Record<string, string | undefined> = process.env,
): number {
    const raw = env.ANONYMOUS_PREFLIGHT_DAILY_LIMIT?.trim();
    if (!raw) return 300;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new Error('ANONYMOUS_PREFLIGHT_CONFIG_ERROR');
    }
    return value;
}

async function handleAnonymousPOST(
    request: Request,
    context: OperationalRequestContext,
    client: AnonymousPreflightClient,
): Promise<NextResponse> {
    let targetInstagramId: string | undefined;
    let preflightId: string | undefined;
    const failed = (status: number, code: string, message: string): NextResponse => {
        void recordPreflightFailure({
            ...(preflightId ? { preflightId } : {}),
            stage: 'request',
            errorCode: preflightFailureReason(code),
        });
        operationalLogger.emit({
            event: status >= 500 ? 'preflight.failed' : 'preflight.blocked',
            severity: status >= 500 ? 'error' : 'info',
            fields: {
                ...context,
                ...(preflightId ? { preflight_id: preflightId } : {}),
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
            return failed(400, 'INVALID_IDEMPOTENCY_KEY', '올바른 Idempotency-Key가 필요합니다.');
        }
        if (!isAnalysisV2AdmissionAvailable()) {
            return failed(
                503,
                'V2_PIPELINE_UNAVAILABLE',
                '새 분석 접수가 일시적으로 중단되었습니다.',
            );
        }

        let dispatchPolicy;
        try {
            dispatchPolicy = resolvePreflightDispatchPolicy();
        } catch {
            return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
        }
        if (dispatchPolicy.mode === 'unavailable') {
            return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
        }

        const env = process.env;
        const targetInputHash = preflightTargetInputHash(targetInstagramId, env);
        const deviceValue = request.headers.get('x-anonymous-device-id')?.trim()
            || request.headers.get('user-agent')?.trim()
            || 'missing-device';
        const budget = await reserveAnonymousPreflightBudget({
            ipHash: hashAnonymousRateLimitValue(requestClientIp(request), 'ip', env),
            deviceHash: hashAnonymousRateLimitValue(deviceValue, 'device', env),
            targetInputHash,
            dailyLimit: anonymousPreflightDailyLimit(env),
            // The budget RPC is intentionally service-role-only because it writes
            // the abuse-prevention attempt ledger. Keep the public create/dispatch
            // RPCs claim-bound to the anonymous client, but execute this server-side
            // accounting call with the admin client.
            client: supabaseAdmin,
        });
        if (!budget.allowed) {
            throw new AnonymousPreflightRateLimitedError(budget.reason === 'daily_cap'
                ? 'daily_cap'
                : 'rate_limited');
        }

        const claim = createAnonymousPreflightClaim({ env });
        const created = await createAnonymousAnalysisV2Preflight({
            targetInstagramId,
            targetInputHash,
            idempotencyKey,
            claimToken: claim.token,
            env,
        }, { client, env });
        preflightId = created.preflightId;
        if (created.status === 'expired') throw new PreflightExpiredError();
        if (created.status === 'consumed') throw new PreflightConsumedError();

        const reservation = await reserveAnonymousAnalysisV2PreflightDispatch(
            created.preflightId,
            claim.token,
            { env, client },
        );
        if (reservation.status === 'expired') throw new PreflightExpiredError();
        if (reservation.status === 'missing') throw new AnonymousPreflightClaimInvalidError();

        if (reservation.shouldEnqueue && dispatchPolicy.mode === 'queue') {
            try {
                await enqueuePreflightTask(created.preflightId, reservation.generation, {
                    config: dispatchPolicy.config,
                });
                if (!reservation.reservationToken) {
                    throw new Error('ANONYMOUS_PREFLIGHT_DISPATCH_TOKEN_MISSING');
                }
                await markAnonymousAnalysisV2PreflightDispatched({
                    preflightId: created.preflightId,
                    claimToken: claim.token,
                    generation: reservation.generation,
                    reservationToken: reservation.reservationToken,
                }, { env, client });
            } catch (error) {
                const metadata = error instanceof PreflightTaskEnqueueError
                    ? error.failureMetadata
                    : preflightEnqueueFailureMetadata(error);
                console.error('Preflight Cloud Tasks enqueue failed.', {
                    failure_code: error instanceof PreflightTaskEnqueueError
                        ? error.failureCode
                        : preflightEnqueueFailureCode(error),
                    error_name: metadata.errorName,
                    missing_module: metadata.missingModule,
                    provider_code: metadata.providerCode,
                });
                if (error instanceof PreflightTaskEnqueueError
                    && error.disposition === 'replayable') {
                    return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
                }
                return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
            }
        } else if (reservation.shouldEnqueue) {
            if (!reservation.reservationToken) {
                return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 상태를 확정할 수 없습니다.');
            }
            await markAnonymousAnalysisV2PreflightDispatched({
                preflightId: created.preflightId,
                claimToken: claim.token,
                generation: reservation.generation,
                reservationToken: reservation.reservationToken,
            }, { env, client });
            after(async () => {
                try {
                    await processPreflight(created.preflightId, {
                        observer(observation: PreflightProcessObservation) {
                            emitPreflightProcessObservation(context, observation);
                        },
                    });
                } catch {
                    console.error('Anonymous preflight local worker failed.');
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
                preflight_id: created.preflightId,
                operation: 'anonymous_preflight',
                disposition: 'requested',
                provider: 'apify',
            },
        });
        return NextResponse.json(acceptedPreflightDto(created, claim.token), {
            status: created.created ? 202 : 200,
        });
    } catch (error) {
        if (error instanceof AnonymousPreflightRateLimitedError) {
            return failed(429, 'PREFLIGHT_RATE_LIMITED', '사전 점검 요청이 너무 많습니다. 로그인 후 계속할 수 있습니다.');
        }
        if (error instanceof AnonymousPreflightIdempotencyConflictError) {
            return failed(409, 'IDEMPOTENCY_CONFLICT', '같은 Idempotency-Key가 다른 요청에 사용되었습니다.');
        }
        if (error instanceof PreflightExpiredError) {
            return failed(410, 'PREFLIGHT_EXPIRED', '사전 점검 요청이 만료되었습니다.');
        }
        if (error instanceof AnonymousPreflightClaimInvalidError) {
            return failed(401, 'UNAUTHORIZED', '사전 점검 상태를 확인할 수 없습니다.');
        }
        if (error instanceof Error && error.message.includes('CONFIG_ERROR')) {
            return failed(503, 'ANONYMOUS_PREFLIGHT_UNAVAILABLE', '익명 사전 점검을 잠시 사용할 수 없습니다. 로그인 후 계속해주세요.');
        }
        console.error('Anonymous preflight creation failed.');
        return failed(500, 'ANALYSIS_FAILED', '사전 점검 요청 생성에 실패했습니다.');
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
    let demoCandidate = false;
    const demoErrorResponse = (status: number, code: string, message: string): NextResponse =>
        NextResponse.json({
            schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
            code,
            error: message,
        }, { status, headers: demoResponseHeaders() });
    const failed = (status: number, code: string, message: string): NextResponse => {
        void recordPreflightFailure({
            ...(userId ? { userId } : {}),
            ...(preflightId ? { preflightId } : {}),
            stage: 'request',
            errorCode: preflightFailureReason(code),
        });
        operationalLogger.emit({
            event: status >= 500 ? 'preflight.failed' : 'preflight.blocked',
            severity: status >= 500 ? 'error' : 'info',
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
            return handleAnonymousPOST(request, context, supabase);
        }
        userId = user.id;
        try {
            await requireActiveAccountClassification(user.id);
        } catch (accountError) {
            if (accountError instanceof AccountPrincipalAdmissionError) {
                return failed(403, accountError.code, '이 계정은 현재 사용할 수 없습니다.');
            }
            return failed(
                503,
                'V2_PIPELINE_UNAVAILABLE',
                '새 분석 접수가 일시적으로 중단되었습니다.',
            );
        }
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return failed(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
        }
        const rawTargetInstagramId = body && typeof body === 'object'
            ? Reflect.get(body, 'targetInstagramId')
            : undefined;
        // This is intentionally evaluated before validation failures can be logged. The
        // demo target is never an operational analytics/logging subject.
        demoCandidate = isDemoEligible(user.id, rawTargetInstagramId);
        const parsed = preflightRequestV1Schema.safeParse(body);
        if (!parsed.success) {
            return demoCandidate
                ? suppressOperationalObservation(demoErrorResponse(400, 'INVALID_REQUEST', '인스타그램 아이디를 확인해주세요.'))
                : failed(400, 'INVALID_REQUEST', '인스타그램 아이디를 확인해주세요.');
        }
        targetInstagramId = parsed.data.targetInstagramId;

        const idempotencyKey = request.headers.get('idempotency-key')?.trim();
        if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
            return demoCandidate
                ? suppressOperationalObservation(demoErrorResponse(400, 'INVALID_IDEMPOTENCY_KEY', '올바른 Idempotency-Key가 필요합니다.'))
                : failed(400, 'INVALID_IDEMPOTENCY_KEY', '올바른 Idempotency-Key가 필요합니다.');
        }
        // This check intentionally uses the un-normalized browser value. All production
        // validation continues to receive the canonical parsed value below.
        if (demoCandidate) {
            const createdDemo = await demoAnalysisStore.createOrReplay({
                userId: user.id,
                idempotencyKey,
            });
            if (!createdDemo) {
                return suppressOperationalObservation(demoErrorResponse(503, 'ANALYSIS_FAILED', '사전 점검 요청 생성에 실패했습니다.'));
            }
            return suppressOperationalObservation(NextResponse.json({
                schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
                preflightId: createdDemo.run.id,
                expiresAt: new Date(new Date(createdDemo.run.created_at).getTime() + 30 * 60_000).toISOString(),
                status: 'pending',
                exclusionDecision: 'pending',
            }, { status: createdDemo.created ? 202 : 200, headers: demoResponseHeaders() }));
        }
        const publicAdmission = isAnalysisV2AdmissionAvailable();
        const signedTestAdmission = signedTestAdmissionState(
            request,
            {
                userId: user.id,
                targetInstagramId: parsed.data.targetInstagramId,
                idempotencyKey,
            }
        );
        if (signedTestAdmission === 'invalid') {
            return failed(
                503,
                'V2_PIPELINE_UNAVAILABLE',
                '새 분석 접수가 일시적으로 중단되었습니다.'
            );
        }
        if (signedTestAdmission === 'valid') {
            try {
                await requireActiveE2eTestRunner(user);
            } catch (accountError) {
                if (accountError instanceof AccountPrincipalAdmissionError) {
                    return failed(
                        403,
                        accountError.code,
                        '이 계정은 현재 사용할 수 없습니다.',
                    );
                }
                return failed(
                    503,
                    'V2_PIPELINE_UNAVAILABLE',
                    '새 분석 접수가 일시적으로 중단되었습니다.',
                );
            }
        }
        if (!publicAdmission && signedTestAdmission !== 'valid') {
            return failed(
                503,
                'V2_PIPELINE_UNAVAILABLE',
                '새 분석 접수가 일시적으로 중단되었습니다.'
            );
        }
        const email = user.email?.trim();
        provider = authProvider(user.app_metadata?.provider, {
            allowSignedE2eEmail: signedTestAdmission === 'valid',
        });
        if (!email || email.length > 320 || !provider) {
            return failed(400, 'UNSUPPORTED_AUTH', '인증 정보를 확인할 수 없습니다.');
        }

        let dispatchPolicy;
        let accessMode;
        try {
            dispatchPolicy = resolvePreflightDispatchPolicy();
            accessMode = signedTestAdmission === 'valid'
                ? 'test_entitlement'
                : trustedPreflightAccessMode();
        } catch {
            return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
        }
        if (dispatchPolicy.mode === 'unavailable') {
            return failed(503, 'QUEUE_UNAVAILABLE', '사전 점검 작업 큐를 사용할 수 없습니다.');
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
                const metadata = error instanceof PreflightTaskEnqueueError
                    ? error.failureMetadata
                    : preflightEnqueueFailureMetadata(error);
                console.error('Preflight Cloud Tasks enqueue failed.', {
                    failure_code: error instanceof PreflightTaskEnqueueError
                        ? error.failureCode
                        : preflightEnqueueFailureCode(error),
                    error_name: metadata.errorName,
                    missing_module: metadata.missingModule,
                    provider_code: metadata.providerCode,
                });
                if (
                    error instanceof PreflightTaskEnqueueError
                    && error.disposition === 'terminal'
                ) {
                    try {
                        await preflightStore.blockQueueUnavailable(created.preflightId, user.id);
                        await bestEffortBetaApifySettlement(() => (
                            settleBetaApifyPreflightCredit(
                                supabaseAdmin, created.preflightId,
                                { telemetry: operationalLogger }
                            )
                        ).then(() => undefined));
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
                        settleBetaCredit: preflightId => (
                            settleBetaApifyPreflightCredit(
                                supabaseAdmin, preflightId,
                                { telemetry: operationalLogger }
                            )
                        ),
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
        if (demoCandidate) {
            return suppressOperationalObservation(demoErrorResponse(
                503,
                'ANALYSIS_FAILED',
                '사전 점검 요청 생성에 실패했습니다.'
            ));
        }
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
