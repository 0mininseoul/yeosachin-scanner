import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
    EarlybirdCheckoutRecoveryError,
    loadCurrentEarlybirdCheckoutPhone,
    recoverEarlybirdCheckout,
} from '@/lib/services/earlybird/checkout';
import { earlybirdStore, EarlybirdPersistenceError } from '@/lib/services/earlybird/store';
import {
    parseEarlybirdCheckoutContinuationQuery,
    type EarlybirdCheckoutPlanId,
} from '@/lib/services/earlybird/checkout-continuation';
import {
    getGrobleCheckoutUrl,
    readGrobleConfig,
} from '@/lib/services/groble/config';
import {
    AccountPrincipalAdmissionError,
    requireActiveAccountClassification,
} from '@/lib/services/identity/account-principal-store';
import {
    observeRoute,
    type OperationalRequestContext,
} from '@/lib/observability/request';
import {
    flushOperationalLogs,
    operationalLogger,
} from '@/lib/observability/server';

const REDIRECT_FLUSH_DEADLINE_MS = 100;

type RedirectFailureCode =
    | 'INVALID_REQUEST'
    | 'UNAUTHORIZED'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';

function noStoreRedirect(request: Request, destination: string): NextResponse {
    const response = NextResponse.redirect(new URL(destination, request.url), {
        status: 303,
    });
    response.headers.set('Cache-Control', 'no-store');
    return response;
}

function emitRedirectFailure(
    context: OperationalRequestContext,
    errorCode: RedirectFailureCode,
): void {
    try {
        operationalLogger.emit({
            event: 'earlybird.checkout_failed',
            severity: errorCode === 'INTERNAL_ERROR' ? 'error' : 'warn',
            fields: {
                ...context,
                operation: 'checkout',
                disposition: 'rejected',
                error_code: errorCode,
            },
        });
    } catch {
        // Redirect diagnostics are best effort and must not alter the fallback.
    }
}

function unavailable(
    request: Request,
    context: OperationalRequestContext,
    errorCode: RedirectFailureCode = 'VALIDATION_ERROR',
    planId?: EarlybirdCheckoutPlanId,
): NextResponse {
    emitRedirectFailure(context, errorCode);
    const planQuery = planId ? `plan=${encodeURIComponent(planId)}&` : '';
    return noStoreRedirect(request, `/earlybird?${planQuery}checkout=unavailable`);
}

async function flushRedirectEventWithinDeadline(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const flush = Promise.resolve()
        .then(() => flushOperationalLogs())
        .catch(() => undefined);
    try {
        await Promise.race([
            flush,
            new Promise<void>(resolve => {
                timeout = setTimeout(resolve, REDIRECT_FLUSH_DEADLINE_MS);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

async function handleGET(
    request: Request,
    context: OperationalRequestContext,
): Promise<NextResponse> {
    let validatedPlanId: EarlybirdCheckoutPlanId | undefined;
    try {
        const url = new URL(request.url);
        const requestedPlanId = url.searchParams.get('planId');
        const queryEntries = Array.from(url.searchParams.keys());
        if (url.searchParams.getAll('planId').length === 1) {
            validatedPlanId = requestedPlanId === 'basic' || requestedPlanId === 'standard'
                ? requestedPlanId
                : undefined;
        }
        if (
            queryEntries.length !== 2
            || queryEntries[0] !== 'orderId'
            || queryEntries[1] !== 'planId'
            || url.searchParams.getAll('orderId').length !== 1
            || url.searchParams.getAll('planId').length !== 1
        ) {
            return unavailable(request, context, 'INVALID_REQUEST', validatedPlanId);
        }
        const continuation = parseEarlybirdCheckoutContinuationQuery(
            url.searchParams.get('orderId'),
            url.searchParams.get('planId'),
        );
        if (
            !continuation
            || url.search
                !== `?orderId=${continuation.orderId}&planId=${continuation.planId}`
        ) {
            return unavailable(request, context, 'INVALID_REQUEST', continuation?.planId ?? validatedPlanId);
        }

        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return unavailable(request, context, 'UNAUTHORIZED', continuation.planId);
        }
        try {
            await requireActiveAccountClassification(user.id);
        } catch (error) {
            return unavailable(
                request,
                context,
                error instanceof AccountPrincipalAdmissionError
                    ? 'UNAUTHORIZED'
                    : 'INTERNAL_ERROR',
                continuation.planId,
            );
        }

        const order = await earlybirdStore.findCheckoutForRedirect(
            user.id,
            continuation.orderId,
            continuation.planId,
        );
        if (!order || order.planId !== continuation.planId) {
            return unavailable(request, context, 'VALIDATION_ERROR', continuation.planId);
        }

        const currentPhone = await loadCurrentEarlybirdCheckoutPhone(user.id);
        const recovered = await recoverEarlybirdCheckout({
            userId: user.id,
            preflightId: order.preflightId,
            planId: continuation.planId,
            targetInstagramId: order.targetInstagramId,
            currentPhone,
        });
        if (recovered.orderId !== order.orderId || !order.sellerReference) {
            return unavailable(request, context, 'VALIDATION_ERROR', continuation.planId);
        }

        const checkoutUrl = getGrobleCheckoutUrl(
            continuation.planId,
            order.sellerReference,
            readGrobleConfig(),
        );
        // This event is intentionally emitted only after every owner/order/
        // phone/evidence/age check and immediately before the external 303.
        try {
            operationalLogger.emit({
                event: 'earlybird.checkout_redirected',
                severity: 'info',
                fields: {
                    ...context,
                    plan_id: continuation.planId,
                    operation: 'checkout',
                    disposition: 'redirected',
                },
            });
        } catch {
            // Logging failure must never strand an otherwise valid checkout.
        }
        await flushRedirectEventWithinDeadline();

        const response = NextResponse.redirect(checkoutUrl, { status: 303 });
        response.headers.set('Cache-Control', 'no-store');
        return response;
    } catch (error) {
        if (error instanceof AccountPrincipalAdmissionError) {
            return unavailable(request, context, 'UNAUTHORIZED', validatedPlanId);
        }
        if (
            error instanceof EarlybirdCheckoutRecoveryError
            || error instanceof EarlybirdPersistenceError
        ) {
            return unavailable(request, context, 'VALIDATION_ERROR', validatedPlanId);
        }
        return unavailable(request, context, 'INTERNAL_ERROR', validatedPlanId);
    }
}

export async function GET(request: Request): Promise<NextResponse> {
    return observeRoute(
        request,
        '/api/earlybird/checkout/redirect',
        context => handleGET(request, context),
    );
}
