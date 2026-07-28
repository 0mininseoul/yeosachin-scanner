import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    earlybirdWaitlistRequestSchema,
    isJsonRequest,
    isSameOriginMutation,
} from '@/lib/services/earlybird/contracts';
import { joinEarlybirdWaitlist } from '@/lib/services/earlybird/checkout';
import { EarlybirdPersistenceError } from '@/lib/services/earlybird/store';
import {
    observeRoute,
    suppressOperationalObservation,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import { operationalLogger } from '@/lib/observability/server';
import { demoResponseHeaders, isDemoOperator } from '@/lib/services/demo-analysis/demo-analysis';
import { demoAnalysisStore } from '@/lib/services/demo-analysis/store';

function errorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status });
}

function demoErrorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status, headers: demoResponseHeaders() });
}

function waitlistErrorCode(code: string): string {
    if (code === 'UNAUTHORIZED') return 'UNAUTHORIZED';
    if (code === 'EARLYBIRD_UNAVAILABLE') return 'INTERNAL_ERROR';
    return 'VALIDATION_ERROR';
}

async function handlePOST(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    const state: { userId?: string; preflightId?: string } = {};
    const failed = (status: number, code: string, error: string): NextResponse => {
        operationalLogger.emit({
            event: 'earlybird.waitlist_failed',
            severity: status >= 500 ? 'error' : 'warn',
            fields: {
                ...context,
                ...(state.userId ? { user_id: state.userId } : {}),
                ...(state.preflightId ? { preflight_id: state.preflightId } : {}),
                plan_id: 'plus',
                operation: 'checkout',
                disposition: 'rejected',
                error_code: waitlistErrorCode(code),
            },
        });
        return errorResponse(status, code, error);
    };

    if (!isSameOriginMutation(request)) {
        return failed(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 요청입니다.');
    }
    if (!isJsonRequest(request)) {
        return failed(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청이 필요합니다.');
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return failed(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    }
    state.userId = user.id;

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return failed(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const parsed = earlybirdWaitlistRequestSchema.safeParse(body);
    if (!parsed.success) {
        return failed(400, 'INVALID_REQUEST', 'Plus 플랜 대기 신청만 가능합니다.');
    }
    state.preflightId = parsed.data.preflightId;

    const demo = await demoAnalysisStore.findForOwner(parsed.data.preflightId, user.id);
    if (demo) {
        return suppressOperationalObservation(isDemoOperator(user.id)
            ? demoErrorResponse(409, 'PLAN_SELECTION_UNAVAILABLE', '선택한 플랜으로 사전 구매할 수 없습니다.')
            : demoErrorResponse(404, 'NOT_FOUND', '사전 점검 요청을 찾을 수 없습니다.'));
    }

    try {
        const result = await joinEarlybirdWaitlist({
            userId: user.id,
            preflightId: parsed.data.preflightId,
        });
        operationalLogger.emit({
            event: 'earlybird.waitlist_created',
            severity: 'info',
            fields: {
                ...context,
                user_id: user.id,
                preflight_id: parsed.data.preflightId,
                plan_id: 'plus',
                operation: 'checkout',
                disposition: result.created ? 'accepted' : 'exists',
            },
        });
        return NextResponse.json({
            waitlistId: result.waitlistId,
            status: 'waitlisted',
        }, { status: result.created ? 201 : 200 });
    } catch (error) {
        if (error instanceof EarlybirdPersistenceError
            && error.code === 'EARLYBIRD_WAITLIST_NOT_ELIGIBLE') {
            return failed(409, error.code, 'Plus 대기 신청 대상이 아닙니다.');
        }
        return failed(503, 'EARLYBIRD_UNAVAILABLE', '대기 신청을 잠시 후 다시 시도해주세요.');
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/earlybird/waitlist',
        context => handlePOST(request, context),
    );
}
