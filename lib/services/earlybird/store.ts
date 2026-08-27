import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { loadAccountCheckoutPhone } from '@/lib/services/identity/account-principal-store';

const checkoutResultSchema = z.array(z.object({
    order_id: z.string().uuid(),
    created: z.boolean(),
})).length(1);

const sellerReferenceResultSchema = z.string()
    .regex(/^ord\.[a-f0-9]{32}$/);

const checkoutRecoveryRowSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    preflight_id: z.string().uuid(),
    target_instagram_id: z.string().min(1).max(128),
    plan_id: z.enum(['basic', 'standard']),
    pricing_version: z.string().min(1).max(64),
    expected_amount_krw: z.number().int().positive(),
    expected_groble_product_id: z.string().min(1).max(128),
    buyer_match_policy: z.string().min(1).max(64),
    expected_buyer_phone_number_normalized: z.string().min(1).max(32).nullable(),
    expected_buyer_phone_verification_source: z.string().min(1).max(64).nullable(),
    disclosure_version: z.string().min(1).max(64),
    disclosure_text: z.string().min(1).max(1_000),
    disclosure_accepted_at: z.string().datetime({ offset: true }),
    groble_seller_reference: sellerReferenceResultSchema.nullable(),
    seller_reference_confirmed_at: z.string().datetime({ offset: true }).nullable(),
    status: z.enum([
        'payment_pending',
        'payment_failed',
        'paid',
        'analysis_in_progress',
        'completed',
        'overflow_refund_required',
        'cancelled',
        'refund_pending',
        'refunded',
    ]),
    payment_id: z.string().nullable(),
    actual_amount_krw: z.number().int().nonnegative().nullable(),
    paid_at: z.string().datetime({ offset: true }).nullable(),
    created_at: z.string().datetime({ offset: true }),
});

const checkoutLineagePreflightSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    target_instagram_id: z.string().min(1).max(128),
    created_at: z.string().datetime({ offset: true }),
});

export interface EarlybirdCheckoutRecoveryRecord {
    orderId: string;
    userId: string;
    preflightId: string;
    targetInstagramId: string;
    planId: 'basic' | 'standard';
    pricingVersion: string;
    expectedAmountKrw: number;
    expectedProductId: string;
    buyerMatchPolicy: string;
    expectedBuyerPhoneNumberNormalized: string | null;
    expectedBuyerPhoneVerificationSource: string | null;
    disclosureVersion: string;
    disclosureText: string;
    disclosureAcceptedAt: string;
    sellerReference: string | null;
    sellerReferenceConfirmedAt: string | null;
    status: 'payment_pending'
        | 'payment_failed'
        | 'paid'
        | 'analysis_in_progress'
        | 'completed'
        | 'overflow_refund_required'
        | 'cancelled'
        | 'refund_pending'
        | 'refunded';
    paymentId: string | null;
    actualAmountKrw: number | null;
    paidAt: string | null;
    createdAt: string;
}

type CheckoutLineageInput = Pick<
    EarlybirdCheckoutRecoveryRecord,
    'userId' | 'preflightId' | 'targetInstagramId'
>;

/**
 * A checkout is superseded only when durable preflight state proves that a
 * newer, ready, unexpired lineage exists for the same owner. The
 * caller cannot provide this decision: `resume=0` is merely a navigation hint.
 */
async function isDurablySuperseded(
    input: CheckoutLineageInput,
): Promise<boolean> {
    const currentResult = await supabaseAdmin
        .from('analysis_preflights')
        .select('id, user_id, target_instagram_id, created_at')
        .eq('id', input.preflightId)
        .eq('user_id', input.userId)
        .eq('target_instagram_id', input.targetInstagramId)
        .maybeSingle();
    if (currentResult.error) {
        throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
    }
    const current = checkoutLineagePreflightSchema.safeParse(currentResult.data);
    if (!current.success || current.data.user_id !== input.userId) return true;

    const latestResult = await supabaseAdmin
        .from('analysis_preflights')
        .select('id, user_id, target_instagram_id, created_at')
        .eq('user_id', input.userId)
        .eq('status', 'ready')
        .in('exclusion_decision', ['skip', 'exclude'])
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (latestResult.error) {
        throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
    }
    if (latestResult.data == null) return false;
    const latest = checkoutLineagePreflightSchema.safeParse(latestResult.data);
    if (!latest.success) {
        throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
    }
    if (latest.data.user_id !== input.userId) {
        throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
    }
    if (latest.data.id === current.data.id) return false;
    return latest.data.created_at > current.data.created_at
        || (
            latest.data.created_at === current.data.created_at
            && latest.data.id > current.data.id
        );
}

const waitlistResultSchema = z.array(z.object({
    waitlist_id: z.string().uuid(),
    created: z.boolean(),
})).length(1);

export class EarlybirdPersistenceError extends Error {
    readonly code: string;
    readonly subreason?: EarlybirdCheckoutLineageSubreason;

    constructor(code: string, subreason?: EarlybirdCheckoutLineageSubreason) {
        super(code);
        this.name = 'EarlybirdPersistenceError';
        this.code = code;
        this.subreason = subreason;
    }
}

export type EarlybirdCheckoutLineageSubreason =
    | 'STALE_PRICING_LINEAGE'
    | 'SUPERSEDED_LINEAGE';

function boundedDatabaseFailure(error: unknown): {
    code: string;
    subreason?: EarlybirdCheckoutLineageSubreason;
} {
    if (!error || typeof error !== 'object' || !('message' in error)) {
        return { code: 'EARLYBIRD_PERSISTENCE_FAILED' };
    }
    const message = String(error.message);
    const lineageCode = [
        'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE',
        'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE',
    ].find(code => message.includes(code));
    if (lineageCode) {
        const subreason: EarlybirdCheckoutLineageSubreason | undefined =
            message.includes('STALE_PRICING_LINEAGE')
                ? 'STALE_PRICING_LINEAGE'
                : message.includes('SUPERSEDED_LINEAGE')
                    ? 'SUPERSEDED_LINEAGE'
                    : undefined;
        // A lineage rejection without its fixed database-generated subreason
        // is deliberately opaque; callers must not infer it from mutable data.
        return subreason
            ? { code: lineageCode, subreason }
            : { code: 'EARLYBIRD_PERSISTENCE_FAILED' };
    }
    const knownCode = [
        'PLAN_UPGRADE_REQUIRED',
        'PLAN_SELECTION_UNAVAILABLE',
        'PREFLIGHT_NOT_VALID',
        'PREFLIGHT_NOT_LATEST',
        'EARLYBIRD_WAITLIST_REQUIRED',
        'EARLYBIRD_WAITLIST_NOT_ELIGIBLE',
        'EARLYBIRD_ORDER_CONFLICT',
        'CHECKOUT_PHONE_REQUIRED',
        'EARLYBIRD_PRICE_SNAPSHOT_INVALID',
        'EARLYBIRD_PRICING_REFRESH_REQUIRED',
    ].find(code => message.includes(code));
    return { code: knownCode ?? 'EARLYBIRD_PERSISTENCE_FAILED' };
}

export interface CreateCheckoutRecordInput {
    userId: string;
    preflightId: string;
    planId: 'basic' | 'standard';
    productId: string;
    amountKrw: number;
    pricingVersion: string;
    disclosureVersion: string;
    disclosureText: string;
    disclosureAcceptedAt: string;
}

export const earlybirdStore = {
    async createCheckout(input: CreateCheckoutRecordInput) {
        const { data, error } = await supabaseAdmin.rpc('create_earlybird_checkout', {
            p_user_id: input.userId,
            p_preflight_id: input.preflightId,
            p_plan_id: input.planId,
            p_expected_product_id: input.productId,
            p_expected_amount_krw: input.amountKrw,
            p_pricing_version: input.pricingVersion,
            p_disclosure_version: input.disclosureVersion,
            p_disclosure_text: input.disclosureText,
            p_disclosure_accepted_at: input.disclosureAcceptedAt,
        });
        if (error) {
            const failure = boundedDatabaseFailure(error);
            throw new EarlybirdPersistenceError(failure.code, failure.subreason);
        }
        const parsed = checkoutResultSchema.safeParse(data);
        if (!parsed.success) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        const { data: referenceData, error: referenceError } =
            await supabaseAdmin.rpc(
                'issue_earlybird_groble_seller_reference',
                { p_order_id: parsed.data[0].order_id }
            );
        if (referenceError) {
            const failure = boundedDatabaseFailure(referenceError);
            throw new EarlybirdPersistenceError(failure.code, failure.subreason);
        }
        const sellerReference = sellerReferenceResultSchema.safeParse(
            referenceData
        );
        if (!sellerReference.success) {
            throw new EarlybirdPersistenceError(
                'EARLYBIRD_PERSISTENCE_FAILED'
            );
        }
        return Object.freeze({
            orderId: parsed.data[0].order_id,
            created: parsed.data[0].created,
            sellerReference: sellerReference.data,
        });
    },

    async findCheckoutForRecovery(
        userId: string,
        preflightId: string,
        targetInstagramId: string | null,
        planId: 'basic' | 'standard',
    ) {
        const select =
            'id, user_id, preflight_id, target_instagram_id, plan_id, pricing_version, '
            + 'expected_amount_krw, expected_groble_product_id, '
            + 'buyer_match_policy, expected_buyer_phone_number_normalized, '
            + 'expected_buyer_phone_verification_source, disclosure_version, '
            + 'disclosure_text, disclosure_accepted_at, groble_seller_reference, '
            + 'seller_reference_confirmed_at, '
            + 'status, payment_id, actual_amount_krw, paid_at, created_at';
        const toRecord = (data: unknown, expectedPreflightId?: string) => {
            const parsed = checkoutRecoveryRowSchema.safeParse(data);
            if (!parsed.success
                || parsed.data.user_id !== userId
                || (expectedPreflightId && parsed.data.preflight_id !== expectedPreflightId)) {
                throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
            }
            return Object.freeze({
                orderId: parsed.data.id,
                userId: parsed.data.user_id,
                preflightId: parsed.data.preflight_id,
                targetInstagramId: parsed.data.target_instagram_id,
                planId: parsed.data.plan_id,
                pricingVersion: parsed.data.pricing_version,
                expectedAmountKrw: parsed.data.expected_amount_krw,
                expectedProductId: parsed.data.expected_groble_product_id,
                buyerMatchPolicy: parsed.data.buyer_match_policy,
                expectedBuyerPhoneNumberNormalized:
                    parsed.data.expected_buyer_phone_number_normalized,
                expectedBuyerPhoneVerificationSource:
                    parsed.data.expected_buyer_phone_verification_source,
                disclosureVersion: parsed.data.disclosure_version,
                disclosureText: parsed.data.disclosure_text,
                disclosureAcceptedAt: parsed.data.disclosure_accepted_at,
                sellerReference: parsed.data.groble_seller_reference,
                sellerReferenceConfirmedAt: parsed.data.seller_reference_confirmed_at,
                status: parsed.data.status,
                paymentId: parsed.data.payment_id,
                actualAmountKrw: parsed.data.actual_amount_krw,
                paidAt: parsed.data.paid_at,
                createdAt: parsed.data.created_at,
            });
        };

        const ownerQuery = supabaseAdmin
            .from('earlybird_orders')
            .select(select)
            .eq('preflight_id', preflightId)
            .eq('user_id', userId);
        const ownerResult = await ownerQuery.maybeSingle();
        if (ownerResult.error) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        if (ownerResult.data) return toRecord(ownerResult.data, preflightId);
        if (!targetInstagramId) return null;

        const lineageResult = await supabaseAdmin
            .from('earlybird_orders')
            .select(select)
            .eq('user_id', userId)
            .eq('target_instagram_id', targetInstagramId)
            .eq('plan_id', planId)
            .eq('status', 'payment_pending')
            .maybeSingle();
        if (lineageResult.error) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        return lineageResult.data ? toRecord(lineageResult.data) : null;
    },

    async findCheckoutForRedirect(
        userId: string,
        orderId: string,
        planId: 'basic' | 'standard',
    ) {
        const select =
            'id, user_id, preflight_id, target_instagram_id, plan_id, pricing_version, '
            + 'expected_amount_krw, expected_groble_product_id, '
            + 'buyer_match_policy, expected_buyer_phone_number_normalized, '
            + 'expected_buyer_phone_verification_source, disclosure_version, '
            + 'disclosure_text, disclosure_accepted_at, groble_seller_reference, '
            + 'seller_reference_confirmed_at, '
            + 'status, payment_id, actual_amount_krw, paid_at, created_at';
        const query = supabaseAdmin
            .from('earlybird_orders')
            .select(select)
            .eq('id', orderId)
            .eq('user_id', userId)
            .eq('plan_id', planId);
        const result = await query.maybeSingle();
        if (result.error) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        if (!result.data) return null;
        const parsed = checkoutRecoveryRowSchema.safeParse(result.data);
        if (!parsed.success || parsed.data.user_id !== userId) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        const record = Object.freeze({
            orderId: parsed.data.id,
            userId: parsed.data.user_id,
            preflightId: parsed.data.preflight_id,
            targetInstagramId: parsed.data.target_instagram_id,
            planId: parsed.data.plan_id,
            pricingVersion: parsed.data.pricing_version,
            expectedAmountKrw: parsed.data.expected_amount_krw,
            expectedProductId: parsed.data.expected_groble_product_id,
            buyerMatchPolicy: parsed.data.buyer_match_policy,
            expectedBuyerPhoneNumberNormalized:
                parsed.data.expected_buyer_phone_number_normalized,
            expectedBuyerPhoneVerificationSource:
                parsed.data.expected_buyer_phone_verification_source,
            disclosureVersion: parsed.data.disclosure_version,
            disclosureText: parsed.data.disclosure_text,
            disclosureAcceptedAt: parsed.data.disclosure_accepted_at,
            sellerReference: parsed.data.groble_seller_reference,
            sellerReferenceConfirmedAt: parsed.data.seller_reference_confirmed_at,
            status: parsed.data.status,
            paymentId: parsed.data.payment_id,
            actualAmountKrw: parsed.data.actual_amount_krw,
            paidAt: parsed.data.paid_at,
            createdAt: parsed.data.created_at,
        });
        if (await isDurablySuperseded(record)) {
            throw new EarlybirdPersistenceError('EARLYBIRD_CHECKOUT_NOT_RECOVERABLE');
        }
        return record;
    },

    async isCheckoutLineageSuperseded(input: CheckoutLineageInput): Promise<boolean> {
        return isDurablySuperseded(input);
    },

    async findCurrentCheckoutPhone(userId: string) {
        try {
            return await loadAccountCheckoutPhone(userId);
        } catch {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
    },

    async joinWaitlist(userId: string, preflightId: string) {
        const { data, error } = await supabaseAdmin.rpc('join_earlybird_waitlist', {
            p_user_id: userId,
            p_preflight_id: preflightId,
        });
        if (error) {
            const failure = boundedDatabaseFailure(error);
            throw new EarlybirdPersistenceError(failure.code, failure.subreason);
        }
        const parsed = waitlistResultSchema.safeParse(data);
        if (!parsed.success) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        return Object.freeze({
            waitlistId: parsed.data[0].waitlist_id,
            created: parsed.data[0].created,
        });
    },
};
