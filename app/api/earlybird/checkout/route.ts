import { after, NextResponse } from 'next/server';
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
import {
    EARLYBIRD_PLAN_CATALOG,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { preflightStore } from '@/lib/services/analysis/preflight';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import {
    flushOperationalLogs,
    operationalLogger,
} from '@/lib/observability/server';

function errorResponse(status: number, code: string, error: string): NextResponse {
    return NextResponse.json({ code, error }, { status });
}

function persistenceErrorResponse(error: EarlybirdPersistenceError): NextResponse {
    if (error.code === 'CHECKOUT_PHONE_REQUIRED') {
        return errorResponse(
            409,
            error.code,
            '카카오 계정의 전화번호 동의 정보를 확인한 뒤 다시 로그인해주세요.'
        );
    }
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

function checkoutErrorCode(code: string): string {
    if (code === 'UNAUTHORIZED') return 'UNAUTHORIZED';
    if (code === 'EARLYBIRD_UNAVAILABLE') return 'INTERNAL_ERROR';
    return 'VALIDATION_ERROR';
}

function scheduleCheckoutEvent(input: {
    context: OperationalRequestContext;
    userId: string;
    preflightId: string;
    planId: PlanId;
    orderId?: string;
    created?: boolean;
    status?: number;
    errorCode?: string;
}): void {
    const amountKrw = isPaidEarlybirdPlanId(input.planId)
        ? EARLYBIRD_PLAN_CATALOG[input.planId].earlybirdAmountKrw
        : undefined;
    const success = Boolean(input.orderId);
    let emitted = false;
    const emitCheckoutEvent = (targetInstagramId?: string): void => {
        if (emitted) return;
        emitted = true;
        operationalLogger.emit({
            event: success ? 'earlybird.checkout_created' : 'earlybird.checkout_failed',
            severity: success ? 'info' : (input.status ?? 500) >= 500 ? 'error' : 'warn',
            fields: {
                ...input.context,
                user_id: input.userId,
                preflight_id: input.preflightId,
                ...(input.orderId ? { order_id: input.orderId } : {}),
                ...(targetInstagramId ? { target_instagram_id: targetInstagramId } : {}),
                plan_id: input.planId,
                ...(amountKrw === undefined ? {} : { amount_krw: amountKrw }),
                operation: 'checkout',
                disposition: success
                    ? input.created ? 'accepted' : 'exists'
                    : 'rejected',
                ...(input.errorCode ? { error_code: input.errorCode } : {}),
            },
        });
    };
    const emitBackgroundEvent = async (): Promise<void> => {
        let targetInstagramId: string | undefined;
        try {
            const preflight = await preflightStore.findForOwner(
                input.preflightId,
                input.userId,
            );
            targetInstagramId = preflight?.readySnapshot?.target.username;
        } catch {
            // Checkout observability remains best-effort and must not affect the response.
        }

        try {
            emitCheckoutEvent(targetInstagramId);
        } finally {
            await flushOperationalLogs();
        }
    };

    try {
        after(emitBackgroundEvent);
    } catch {
        try {
            // The route-level observer will flush this bounded event with the response.
            emitCheckoutEvent();
        } catch {
            // Observability must never alter an already-decided checkout response.
        }
    }
}

async function handlePOST(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    const state: {
        userId?: string;
        preflightId?: string;
        planId?: PlanId;
    } = {};
    const failed = (status: number, code: string, error: string): NextResponse => {
        const amountKrw = state.planId && isPaidEarlybirdPlanId(state.planId)
            ? EARLYBIRD_PLAN_CATALOG[state.planId].earlybirdAmountKrw
            : undefined;
        operationalLogger.emit({
            event: 'earlybird.checkout_failed',
            severity: status >= 500 ? 'error' : 'warn',
            fields: {
                ...context,
                ...(state.userId ? { user_id: state.userId } : {}),
                ...(state.preflightId ? { preflight_id: state.preflightId } : {}),
                ...(state.planId ? { plan_id: state.planId } : {}),
                ...(amountKrw === undefined ? {} : { amount_krw: amountKrw }),
                operation: 'checkout',
                disposition: 'rejected',
                error_code: checkoutErrorCode(code),
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
    const parsed = earlybirdCheckoutRequestSchema.safeParse(body);
    if (!parsed.success) {
        return failed(400, 'DISCLOSURE_REQUIRED', '필수 안내에 동의해주세요.');
    }
    state.preflightId = parsed.data.preflightId;
    state.planId = parsed.data.planId;

    try {
        const result = await createEarlybirdCheckout({
            userId: user.id,
            preflightId: parsed.data.preflightId,
            planId: parsed.data.planId,
        });
        scheduleCheckoutEvent({
            context,
            userId: user.id,
            preflightId: parsed.data.preflightId,
            planId: parsed.data.planId,
            orderId: result.orderId,
            created: result.created,
        });
        return NextResponse.json({
            orderId: result.orderId,
            checkoutUrl: result.checkoutUrl,
        }, { status: result.created ? 201 : 200 });
    } catch (error) {
        if (error instanceof EarlybirdWaitlistRequiredError) {
            scheduleCheckoutEvent({
                context,
                userId: user.id,
                preflightId: parsed.data.preflightId,
                planId: parsed.data.planId,
                status: 409,
                errorCode: 'VALIDATION_ERROR',
            });
            return errorResponse(409, error.message, 'Plus 플랜은 대기 신청으로 접수해주세요.');
        }
        if (error instanceof EarlybirdPersistenceError) {
            const response = persistenceErrorResponse(error);
            scheduleCheckoutEvent({
                context,
                userId: user.id,
                preflightId: parsed.data.preflightId,
                planId: parsed.data.planId,
                status: response.status,
                errorCode: response.status >= 500
                    ? 'INTERNAL_ERROR'
                    : 'VALIDATION_ERROR',
            });
            return response;
        }
        scheduleCheckoutEvent({
            context,
            userId: user.id,
            preflightId: parsed.data.preflightId,
            planId: parsed.data.planId,
            status: 503,
            errorCode: 'INTERNAL_ERROR',
        });
        return errorResponse(
            503,
            'EARLYBIRD_UNAVAILABLE',
            '사전 구매 접수를 잠시 후 다시 시도해주세요.',
        );
    }
}

export async function POST(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/earlybird/checkout',
        context => handlePOST(request, context),
    );
}
