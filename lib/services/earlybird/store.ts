import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const checkoutResultSchema = z.array(z.object({
    order_id: z.string().uuid(),
    created: z.boolean(),
    seller_reference: z.string().regex(/^ord\.[a-f0-9]{32}$/),
})).length(1);

const sellerReferenceResultSchema = z.string()
    .regex(/^ord\.[a-f0-9]{32}$/);

const checkoutRecoveryRowSchema = z.object({
    id: z.string().uuid(),
    user_id: z.string().uuid(),
    preflight_id: z.string().uuid(),
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
});

const currentCheckoutPhoneRowSchema = z.object({
    id: z.string().uuid(),
    provider: z.string().min(1).max(50),
    phone_number: z.string().min(1).max(50).nullable(),
    phone_number_normalized: z.string().min(1).max(32).nullable(),
    phone_number_verification_source: z.string().min(1).max(64).nullable(),
    phone_number_verified_at: z.string().datetime({ offset: true }).nullable(),
});

const waitlistResultSchema = z.array(z.object({
    waitlist_id: z.string().uuid(),
    created: z.boolean(),
})).length(1);

const legacyRefreshResultSchema = z.array(z.object({
    order_id: z.string().uuid(),
    preflight_id: z.string().uuid(),
    created: z.boolean(),
    seller_reference: sellerReferenceResultSchema,
    plan_id: z.enum(['basic', 'standard']),
    payment_address: z.string().min(1).max(128),
})).length(1);

export class EarlybirdPersistenceError extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = 'EarlybirdPersistenceError';
        this.code = code;
    }
}

function boundedDatabaseCode(error: unknown): string {
    if (!error || typeof error !== 'object' || !('message' in error)) {
        return 'EARLYBIRD_PERSISTENCE_FAILED';
    }
    const message = String(error.message);
    const knownCode = [
        'PLAN_UPGRADE_REQUIRED',
        'PLAN_SELECTION_UNAVAILABLE',
        'PREFLIGHT_NOT_VALID',
        'PREFLIGHT_NOT_LATEST',
        'EARLYBIRD_WAITLIST_REQUIRED',
        'EARLYBIRD_WAITLIST_NOT_ELIGIBLE',
        'EARLYBIRD_ORDER_CONFLICT',
        'EARLYBIRD_CHECKOUT_ALREADY_PENDING',
        'CHECKOUT_PHONE_REQUIRED',
        'EARLYBIRD_PRICE_SNAPSHOT_INVALID',
        'EARLYBIRD_PRICING_REFRESH_REQUIRED',
        'EARLYBIRD_PRODUCT_CONFIGURATION_REQUIRED',
        'EARLYBIRD_LEGACY_REFRESH_NOT_FOUND',
        'EARLYBIRD_LEGACY_REFRESH_NOT_ELIGIBLE',
        'EARLYBIRD_LEGACY_REFRESH_CONFLICT',
        'EARLYBIRD_SOLD_OUT',
    ].find(code => message.includes(code));
    return knownCode ?? 'EARLYBIRD_PERSISTENCE_FAILED';
}

export interface CreateCheckoutRecordInput {
    userId: string;
    preflightId: string;
    planId: 'basic' | 'standard';
    productId: string;
    paymentAddress: string;
    amountKrw: number;
    pricingVersion: string;
    disclosureVersion: string;
    disclosureText: string;
    disclosureAcceptedAt: string;
}

export interface RefreshLegacyCheckoutRecordInput {
    userId: string;
    legacyOrderId: string;
    disclosureVersion: string;
    disclosureText: string;
    disclosureAcceptedAt: string;
    launchStatusSnapshot: unknown;
    planCatalogSnapshot: unknown;
    pricingSnapshot: unknown;
}

export const earlybirdStore = {
    async createCheckout(input: CreateCheckoutRecordInput) {
        const { data, error } = await supabaseAdmin.rpc('create_earlybird_checkout_v2', {
            p_user_id: input.userId,
            p_preflight_id: input.preflightId,
            p_plan_id: input.planId,
            p_expected_product_id: input.productId,
            p_payment_address: input.paymentAddress,
            p_expected_amount_krw: input.amountKrw,
            p_pricing_version: input.pricingVersion,
            p_disclosure_version: input.disclosureVersion,
            p_disclosure_text: input.disclosureText,
            p_disclosure_accepted_at: input.disclosureAcceptedAt,
        });
        if (error) throw new EarlybirdPersistenceError(boundedDatabaseCode(error));
        const parsed = checkoutResultSchema.safeParse(data);
        if (!parsed.success) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        return Object.freeze({
            orderId: parsed.data[0].order_id,
            created: parsed.data[0].created,
            sellerReference: parsed.data[0].seller_reference,
        });
    },

    async findCheckoutForRecovery(userId: string, preflightId: string) {
        const { data, error } = await supabaseAdmin
            .from('earlybird_orders')
            .select(
                'id, user_id, preflight_id, plan_id, pricing_version, '
                + 'expected_amount_krw, expected_groble_product_id, '
                + 'buyer_match_policy, expected_buyer_phone_number_normalized, '
                + 'expected_buyer_phone_verification_source, disclosure_version, '
                + 'disclosure_text, disclosure_accepted_at, groble_seller_reference, '
                + 'status, payment_id, actual_amount_krw, paid_at'
            )
            .eq('preflight_id', preflightId)
            .eq('user_id', userId)
            .maybeSingle();
        if (error) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        if (!data) return null;
        const parsed = checkoutRecoveryRowSchema.safeParse(data);
        if (!parsed.success
            || parsed.data.user_id !== userId
            || parsed.data.preflight_id !== preflightId) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        return Object.freeze({
            orderId: parsed.data.id,
            userId: parsed.data.user_id,
            preflightId: parsed.data.preflight_id,
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
            status: parsed.data.status,
            paymentId: parsed.data.payment_id,
            actualAmountKrw: parsed.data.actual_amount_krw,
            paidAt: parsed.data.paid_at,
        });
    },

    async refreshLegacyCheckout(input: RefreshLegacyCheckoutRecordInput) {
        const { data, error } = await supabaseAdmin.rpc(
            'refresh_legacy_earlybird_checkout',
            {
                p_user_id: input.userId,
                p_legacy_order_id: input.legacyOrderId,
                p_disclosure_version: input.disclosureVersion,
                p_disclosure_text: input.disclosureText,
                p_disclosure_accepted_at: input.disclosureAcceptedAt,
                p_launch_status_snapshot: input.launchStatusSnapshot,
                p_plan_catalog_snapshot: input.planCatalogSnapshot,
                p_pricing_snapshot: input.pricingSnapshot,
            }
        );
        if (error) {
            throw new EarlybirdPersistenceError(boundedDatabaseCode(error));
        }
        const parsed = legacyRefreshResultSchema.safeParse(data);
        if (!parsed.success) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        return Object.freeze({
            orderId: parsed.data[0].order_id,
            preflightId: parsed.data[0].preflight_id,
            created: parsed.data[0].created,
            sellerReference: parsed.data[0].seller_reference,
            planId: parsed.data[0].plan_id,
            paymentAddress: parsed.data[0].payment_address,
        });
    },

    async findCurrentCheckoutPhone(userId: string) {
        const { data, error } = await supabaseAdmin
            .from('users')
            .select(
                'id, provider, phone_number, phone_number_normalized, '
                + 'phone_number_verification_source, phone_number_verified_at'
            )
            .eq('id', userId)
            .maybeSingle();
        if (error) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        if (!data) return null;
        const parsed = currentCheckoutPhoneRowSchema.safeParse(data);
        if (!parsed.success || parsed.data.id !== userId) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        return Object.freeze({
            userId: parsed.data.id,
            provider: parsed.data.provider,
            phoneNumber: parsed.data.phone_number,
            phoneNumberNormalized: parsed.data.phone_number_normalized,
            verificationSource: parsed.data.phone_number_verification_source,
            verifiedAt: parsed.data.phone_number_verified_at,
        });
    },

    async joinWaitlist(userId: string, preflightId: string) {
        const { data, error } = await supabaseAdmin.rpc('join_earlybird_waitlist', {
            p_user_id: userId,
            p_preflight_id: preflightId,
        });
        if (error) throw new EarlybirdPersistenceError(boundedDatabaseCode(error));
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
