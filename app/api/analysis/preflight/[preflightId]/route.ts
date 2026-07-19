import { NextResponse } from 'next/server';
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
} from '@/lib/services/analysis/preflight';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(status: number, code: string, message: string): NextResponse {
    return NextResponse.json({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        code,
        error: message,
    }, { status });
}

async function authenticatedUser() {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    return error || !user ? null : user;
}

async function consumedPreflightStatus(
    preflightId: string,
    userId: string,
    exclusionDecision: 'exclude' | 'skip'
) {
    const { data, error } = await supabaseAdmin
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
    _request: Request,
    { params }: { params: Promise<{ preflightId: string }> }
) {
    try {
        const user = await authenticatedUser();
        if (!user) return errorResponse(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
        const { preflightId } = await params;
        if (!UUID_PATTERN.test(preflightId)) {
            return errorResponse(400, 'INVALID_REQUEST', '사전 점검 식별자가 올바르지 않습니다.');
        }

        const stored = await preflightStore.findForOwner(preflightId, user.id);
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
                stored.exclusionDecision
            ));
        }
        return NextResponse.json(publicPreflightStatusDto(stored));
    } catch (error) {
        if (error instanceof PreflightExpiredError) {
            return errorResponse(410, 'PREFLIGHT_EXPIRED', '사전 점검 요청이 만료되었습니다.');
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
    try {
        const user = await authenticatedUser();
        if (!user) return errorResponse(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
        const { preflightId } = await params;
        if (!UUID_PATTERN.test(preflightId)) {
            return errorResponse(400, 'INVALID_REQUEST', '사전 점검 식별자가 올바르지 않습니다.');
        }

        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return errorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.');
        }
        const parsed = preflightExclusionRequestV1Schema.safeParse(body);
        if (!parsed.success) {
            return errorResponse(400, 'INVALID_EXCLUSION', '제외 계정 입력을 확인해주세요.');
        }

        await preflightStore.setExclusion({
            preflightId,
            userId: user.id,
            decision: parsed.data.decision,
            excludedInstagramId: parsed.data.decision === 'exclude'
                ? parsed.data.excludedInstagramId
                : null,
        });
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
        if (error instanceof PreflightNotFoundError) {
            return errorResponse(404, 'NOT_FOUND', '사전 점검 요청을 찾을 수 없습니다.');
        }
        if (error instanceof InvalidPreflightExclusionError) {
            return errorResponse(400, 'INVALID_EXCLUSION', '대상 계정은 제외할 수 없습니다.');
        }
        if (error instanceof PreflightImmutableError) {
            return errorResponse(409, error.message, '이 사전 점검 요청은 변경할 수 없습니다.');
        }
        console.error('Preflight exclusion update failed.');
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
