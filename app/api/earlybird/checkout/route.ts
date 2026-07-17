import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    earlybirdCheckoutRequestSchema,
    isJsonRequest,
    isSameOriginMutation,
} from '@/lib/services/earlybird/contracts';
import {
    createEarlybirdCheckout,
    EarlybirdWaitlistRequiredError,
} from '@/lib/services/earlybird/checkout';
import { EarlybirdPersistenceError } from '@/lib/services/earlybird/store';

function errorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status });
}

function persistenceErrorResponse(error: EarlybirdPersistenceError): NextResponse {
    if (error.code === 'EARLYBIRD_CHECKOUT_ALREADY_PENDING') {
        return errorResponse(
            409,
            error.code,
            '기존 결제창의 처리 상태를 먼저 확인해주세요.'
        );
    }
    if (error.code === 'PLAN_UPGRADE_REQUIRED'
        || error.code === 'PLAN_SELECTION_UNAVAILABLE'
        || error.code === 'EARLYBIRD_ORDER_CONFLICT') {
        return errorResponse(409, error.code, '선택한 플랜으로 사전 구매할 수 없습니다.');
    }
    if (error.code === 'PREFLIGHT_NOT_VALID' || error.code === 'PREFLIGHT_NOT_LATEST') {
        return errorResponse(409, error.code, '최신 사전 점검을 다시 확인해주세요.');
    }
    return errorResponse(503, 'EARLYBIRD_UNAVAILABLE', '사전 구매 접수를 잠시 후 다시 시도해주세요.');
}

export async function POST(request: Request): Promise<NextResponse> {
    if (!isSameOriginMutation(request)) {
        return errorResponse(403, 'FORBIDDEN_ORIGIN', '허용되지 않은 요청입니다.');
    }
    if (!isJsonRequest(request)) {
        return errorResponse(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청이 필요합니다.');
    }

    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return errorResponse(401, 'UNAUTHORIZED', '로그인이 필요합니다.');
    }

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return errorResponse(400, 'INVALID_REQUEST', '요청 형식이 올바르지 않습니다.');
    }
    const parsed = earlybirdCheckoutRequestSchema.safeParse(body);
    if (!parsed.success) {
        return errorResponse(400, 'DISCLOSURE_REQUIRED', '필수 안내에 동의해주세요.');
    }

    try {
        const result = await createEarlybirdCheckout({
            userId: user.id,
            preflightId: parsed.data.preflightId,
            planId: parsed.data.planId,
        });
        return NextResponse.json({
            orderId: result.orderId,
            checkoutUrl: result.checkoutUrl,
        }, { status: result.created ? 201 : 200 });
    } catch (error) {
        if (error instanceof EarlybirdWaitlistRequiredError) {
            return errorResponse(409, error.message, 'Plus 플랜은 대기 신청으로 접수해주세요.');
        }
        if (error instanceof EarlybirdPersistenceError) {
            return persistenceErrorResponse(error);
        }
        return errorResponse(503, 'EARLYBIRD_UNAVAILABLE', '사전 구매 접수를 잠시 후 다시 시도해주세요.');
    }
}
