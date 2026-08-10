import { after, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    preflightExclusionRequestV1Schema,
    preflightStatusV1Schema,
} from '@/lib/contracts/analysis-v2';
import {
    InvalidPreflightExclusionError,
    PreflightExpiredError,
    PreflightImmutableError,
    PreflightNotFoundError,
    preflightStore,
    publicPreflightStatusDto,
    type PreflightSupabaseClient,
} from '@/lib/services/analysis/preflight';
import {
    observeRoute,
    suppressOperationalObservation,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';
import { insertLandingLead } from '@/lib/services/leads/store';
import { demoPreflightLifecycle, demoReadyPreflight, demoResponseHeaders, isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';
import { loadDemoFixtureForVersion } from '@/lib/services/demo-analysis/fixture-store';
import {
    BETA_TEST_ACCESS_UNAVAILABLE,
    betaTestFreePoolEnabled,
    hasBetaTestAccess,
} from '@/lib/services/analysis/betatest-access';
import { recordPreflightFailure } from '@/lib/services/analysis/preflight-failure-ledger';
import {
    AnonymousPreflightClaimInvalidError,
    readAnonymousAnalysisV2Preflight,
    setAnonymousAnalysisV2PreflightExclusion,
} from '@/lib/services/analysis/anonymous-preflight';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string): NextResponse {
    return NextResponse.json({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        code,
        error: message,
    }, { status });
}

function demoErrorResponse(status: number, code: string, message: string): NextResponse {
    return NextResponse.json({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        code,
        error: message,
    }, { status, headers: demoResponseHeaders() });
}

async function authenticatedSession() {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    return {
        user: error || !user ? null : user,
        supabase: supabase as unknown as PreflightSupabaseClient,
    };
}

function captureExcludedLandingLead(
    preflightId: string,
    excludedInstagramId: string,
): void {
    try {
        after(async () => {
            try {
                await insertLandingLead({
                    instagramId: excludedInstagramId,
                    inputContext: 'excluded',
                    sourcePreflightId: preflightId,
                });
            } catch {
                // Lead capture is best-effort and must never alter the exclusion decision.
            }
        });
    } catch {
        // The durable exclusion remains authoritative when background work is unavailable.
    }
}

function exclusionFailureErrorCode(error: unknown): 'PREFLIGHT_PERSISTENCE_ERROR' | 'INTERNAL_ERROR' {
    return error instanceof Error && error.message.startsWith('PREFLIGHT_PERSISTENCE_ERROR:')
        ? 'PREFLIGHT_PERSISTENCE_ERROR'
        : 'INTERNAL_ERROR';
}

async function consumedPreflightStatus(
    preflightId: string,
    userId: string,
    exclusionDecision: 'exclude' | 'skip',
    client: PreflightSupabaseClient,
) {
    const { data, error } = await client
        .from('analysis_requests')
        .select('id, user_id, preflight_id, pipeline_version')
        .eq('preflight_id', preflightId)
        .eq('user_id', userId)
        .eq('pipeline_version', 'v2')
        .maybeSingle();
    if (error || !data) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: consumed request lookup failed.');
    }
    const row = data as Record<string, unknown>;
    if (
        typeof row.id !== 'string'
        || !UUID_PATTERN.test(row.id)
        || row.user_id !== userId.toLowerCase()
        || row.preflight_id !== preflightId.toLowerCase()
        || row.pipeline_version !== 'v2'
    ) {
        throw new Error('PREFLIGHT_PERSISTENCE_ERROR: invalid consumed request lookup.');
    }
    return preflightStatusV1Schema.parse({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        preflightId,
        status: 'consumed',
        exclusionDecision,
        requestId: row.id,
    });
}

async function handleGET(
    request: Request,
    { params }: { params: Promise<{ preflightId: string }> }
) {
    let demoRecognized = false;
    try {
        const session = await authenticatedSession();
        const { preflightId } = await params;
        if (!UUID_PATTERN.test(preflightId)) {
            return errorResponse(400, 'INVALID_REQUEST', '사전 점검 식별자가 올바르지 않습니다.');
        }

        if (!session.user) {
            const claimToken = request.headers.get('x-preflight-claim-token')?.trim();
            if (!claimToken) return errorResponse(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
            const stored = await readAnonymousAnalysisV2Preflight(preflightId, claimToken, {
                client: session.supabase,
            });
            if (!stored) return errorResponse(404, 'NOT_FOUND', '사전 점검 요청을 찾을 수 없습니다.');
            // Groble is the source of truth for paid-plan inventory. The server
            // must not expose a second, potentially stale sold-out signal.
            return NextResponse.json(publicPreflightStatusDto(stored));
        }
        const { user } = session;

        try {
            await requireActiveAccountClassification(user.id);
        } catch (accountError) {
            if (accountError instanceof AccountPrincipalAdmissionError) {
                return errorResponse(403, accountError.code, '이 계정은 현재 사용할 수 없습니다.');
            }
            throw accountError;
        }

        const demo = await demoAnalysisStore.findForOwner(preflightId, user.id);
        if (demo) {
            demoRecognized = true;
            if (!isDemoOperator(user.id)) return suppressOperationalObservation(demoErrorResponse(404, 'NOT_FOUND', '사전 점검 요청을 찾을 수 없습니다.'));
            const lifecycle = demoPreflightLifecycle(demo);
            if (lifecycle === 'consumed') {
                return suppressOperationalObservation(NextResponse.json(preflightStatusV1Schema.parse({
                    schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
                    preflightId: demo.id,
                    status: 'consumed',
                    exclusionDecision: 'skip',
                    requestId: demo.id,
                }), { headers: demoResponseHeaders() }));
            }
            if (lifecycle === 'expired') {
                return suppressOperationalObservation(demoErrorResponse(410, 'PREFLIGHT_EXPIRED', '사전 점검 요청이 만료되었습니다.'));
            }
            const fixture = await loadDemoFixtureForVersion(demo.fixture_version);
            if (!fixture) {
                return suppressOperationalObservation(demoErrorResponse(503, 'DEMO_UNAVAILABLE', '데모 분석을 일시적으로 사용할 수 없습니다.'));
            }
            return suppressOperationalObservation(NextResponse.json(
                demoReadyPreflight(demo, demo.fixture_version, fixture.target),
                { headers: demoResponseHeaders() }
            ));
        }

        const stored = await preflightStore.findForOwner(preflightId, user.id, {
            client: session.supabase,
        });
        if (!stored) {
            return errorResponse(404, 'NOT_FOUND', '사전 점검 요청을 찾을 수 없습니다.');
        }
        if (stored.status === 'consumed') {
            if (stored.exclusionDecision === 'pending') {
                throw new Error('PREFLIGHT_PERSISTENCE_ERROR: consumed exclusion is pending.');
            }
            return NextResponse.json(await consumedPreflightStatus(
                preflightId,
                user.id,
                stored.exclusionDecision,
                session.supabase,
            ));
        }
        // Groble is the source of truth for paid-plan inventory. The server
        // must not expose a second, potentially stale sold-out signal.
        return NextResponse.json(publicPreflightStatusDto(stored));
    } catch (error) {
        if (demoRecognized) {
            return suppressOperationalObservation(demoErrorResponse(
                500,
                'ANALYSIS_FAILED',
                '사전 점검 상태 조회에 실패했습니다.'
            ));
        }
        if (error instanceof PreflightExpiredError) {
            return errorResponse(410, 'PREFLIGHT_EXPIRED', '사전 점검 요청이 만료되었습니다.');
        }
        if (error instanceof AnonymousPreflightClaimInvalidError) {
            return errorResponse(401, 'UNAUTHORIZED', '사전 점검 상태를 확인할 수 없습니다.');
        }
        if (error instanceof Error && error.message.includes('ANONYMOUS_PREFLIGHT_CLAIM_CONFIG_ERROR')) {
            return errorResponse(503, 'ANONYMOUS_PREFLIGHT_UNAVAILABLE', '익명 사전 점검을 잠시 사용할 수 없습니다.');
        }
        console.error('Preflight status read failed.');
        return errorResponse(500, 'ANALYSIS_FAILED', '사전 점검 상태 조회에 실패했습니다.');
    }
}

export async function GET(
    request: Request,
    routeContext: { params: Promise<{ preflightId: string }> }
): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/analysis/preflight/[preflightId]',
        () => handleGET(request, routeContext),
    );
}

async function handlePATCH(
    request: Request,
    { params }: { params: Promise<{ preflightId: string }> },
    context: OperationalRequestContext,
) {
    let demoRecognized = false;
    let observedUserId: string | undefined;
    let observedPreflightId: string | undefined;
    try {
        const session = await authenticatedSession();
        const { preflightId } = await params;
        if (!UUID_PATTERN.test(preflightId)) {
            return errorResponse(400, 'INVALID_REQUEST', '사전 점검 식별자가 올바르지 않습니다.');
        }
        observedPreflightId = preflightId;

        if (!session.user) {
            const claimToken = request.headers.get('x-preflight-claim-token')?.trim();
            if (!claimToken) return errorResponse(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
            let anonymousBody: unknown;
            try {
                anonymousBody = await request.json();
            } catch {
                void recordPreflightFailure({
                    preflightId,
                    stage: 'exclusion',
                    errorCode: 'EXCLUSION_RULE_VIOLATION',
                });
                return errorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.');
            }
            const anonymousParsed = preflightExclusionRequestV1Schema.safeParse(anonymousBody);
            if (!anonymousParsed.success) {
                void recordPreflightFailure({
                    preflightId,
                    stage: 'exclusion',
                    errorCode: 'EXCLUSION_RULE_VIOLATION',
                });
                return errorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.');
            }
            const updated = await setAnonymousAnalysisV2PreflightExclusion({
                preflightId,
                claimToken,
                decision: anonymousParsed.data.decision,
                excludedInstagramId: anonymousParsed.data.decision === 'exclude'
                    ? anonymousParsed.data.excludedInstagramId
                    : null,
            }, { client: session.supabase });
            if (!updated) return errorResponse(409, 'PREFLIGHT_IMMUTABLE', '이 사전 점검 요청은 변경할 수 없습니다.');
            if (anonymousParsed.data.decision === 'exclude') {
                captureExcludedLandingLead(preflightId, anonymousParsed.data.excludedInstagramId);
            }
            operationalLogger.emit({
                event: 'preflight.exclusion_decided',
                severity: 'info',
                fields: {
                    ...context,
                    preflight_id: preflightId,
                    operation: 'anonymous_exclusion',
                    disposition: 'accepted',
                },
            });
            return new NextResponse(null, { status: 204 });
        }

        const { user, supabase } = session;
        observedUserId = user.id;

        try {
            await requireActiveAccountClassification(user.id);
        } catch (accountError) {
            if (accountError instanceof AccountPrincipalAdmissionError) {
                return errorResponse(403, accountError.code, '이 계정은 현재 사용할 수 없습니다.');
            }
            throw accountError;
        }

        const demo = await demoAnalysisStore.findForOwner(preflightId, user.id);
        if (demo) {
            demoRecognized = true;
            if (!isDemoOperator(user.id)) return suppressOperationalObservation(demoErrorResponse(404, 'NOT_FOUND', '사전 점검 요청을 찾을 수 없습니다.'));
            let demoBody: unknown;
            try {
                demoBody = await request.json();
            } catch {
                return suppressOperationalObservation(demoErrorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.'));
            }
            if (!preflightExclusionRequestV1Schema.safeParse(demoBody).success) {
                return suppressOperationalObservation(demoErrorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.'));
            }
            if (demoPreflightLifecycle(demo) !== 'ready') {
                return suppressOperationalObservation(demoErrorResponse(409, 'PREFLIGHT_IMMUTABLE', '이 사전 점검 요청은 변경할 수 없습니다.'));
            }
            // Synthetic runs do not persist an exclusion or create a lead; this preserves
            // the existing UI's compatible acknowledgement without mutating production rows.
            return suppressOperationalObservation(new NextResponse(null, { status: 204, headers: demoResponseHeaders() }));
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            void recordPreflightFailure({
                userId: user.id,
                preflightId,
                stage: 'exclusion',
                errorCode: 'EXCLUSION_RULE_VIOLATION',
            });
            return errorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.');
        }
        const parsed = preflightExclusionRequestV1Schema.safeParse(body);
        if (!parsed.success) {
            void recordPreflightFailure({
                userId: user.id,
                preflightId,
                stage: 'exclusion',
                errorCode: 'EXCLUSION_RULE_VIOLATION',
            });
            return errorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.');
        }

        if (
            await preflightStore.hasBetaEntryProvenance(preflightId, user.id, {
                client: supabase,
            })
            && (
                !betaTestFreePoolEnabled()
                || !await hasBetaTestAccess(supabase)
            )
        ) {
            return errorResponse(
                403,
                BETA_TEST_ACCESS_UNAVAILABLE,
                '베타 분석을 사용할 수 없습니다.'
            );
        }

        await preflightStore.setExclusion({
            preflightId,
            userId: user.id,
            decision: parsed.data.decision,
            excludedInstagramId: parsed.data.decision === 'exclude'
                ? parsed.data.excludedInstagramId
                : null,
        }, { client: supabase });
        if (parsed.data.decision === 'exclude') {
            captureExcludedLandingLead(
                preflightId,
                parsed.data.excludedInstagramId,
            );
        }
        operationalLogger.emit({
            event: 'preflight.exclusion_decided',
            severity: 'info',
            fields: {
                ...context,
                user_id: user.id,
                preflight_id: preflightId,
                ...(parsed.data.decision === 'exclude'
                    ? { excluded_instagram_id: parsed.data.excludedInstagramId }
                    : {}),
                operation: 'exclusion',
                disposition: 'accepted',
            },
        });
        return new NextResponse(null, { status: 204 });
    } catch (error) {
        if (demoRecognized) {
            return suppressOperationalObservation(demoErrorResponse(
                500,
                'ANALYSIS_FAILED',
                '제외 계정 저장에 실패했습니다.'
            ));
        }
        if (error instanceof PreflightNotFoundError) {
            return errorResponse(404, 'NOT_FOUND', '사전 점검 요청을 찾을 수 없습니다.');
        }
        if (error instanceof AnonymousPreflightClaimInvalidError) {
            return errorResponse(401, 'UNAUTHORIZED', '사전 점검 상태를 확인할 수 없습니다.');
        }
        if (error instanceof Error && error.message.includes('ANONYMOUS_PREFLIGHT_CLAIM_CONFIG_ERROR')) {
            return errorResponse(503, 'ANONYMOUS_PREFLIGHT_UNAVAILABLE', '익명 사전 점검을 잠시 사용할 수 없습니다.');
        }
        if (error instanceof InvalidPreflightExclusionError) {
            void recordPreflightFailure({
                ...(observedUserId ? { userId: observedUserId } : {}),
                ...(observedPreflightId ? { preflightId: observedPreflightId } : {}),
                stage: 'exclusion',
                errorCode: 'EXCLUSION_RULE_VIOLATION',
            });
            return errorResponse(400, 'INVALID_EXCLUSION', '대상 계정은 제외할 수 없습니다.');
        }
        if (error instanceof PreflightImmutableError) {
            return errorResponse(409, error.message, '이 사전 점검 요청은 변경할 수 없습니다.');
        }
        const errorCode = exclusionFailureErrorCode(error);
        operationalLogger.emit({
            event: 'preflight.failed',
            severity: 'error',
            fields: {
                ...context,
                ...(observedUserId ? { user_id: observedUserId } : {}),
                ...(observedPreflightId ? { preflight_id: observedPreflightId } : {}),
                operation: 'exclusion',
                disposition: 'failed',
                error_code: errorCode,
            },
            error,
        });
        console.error(`Preflight exclusion update failed (${errorCode}).`);
        return errorResponse(500, 'ANALYSIS_FAILED', '제외 계정 저장에 실패했습니다.');
    }
}

export async function PATCH(
    request: Request,
    routeContext: { params: Promise<{ preflightId: string }> }
): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/analysis/preflight/[preflightId]',
        context => handlePATCH(request, routeContext, context),
    );
}
