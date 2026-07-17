import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const checkoutResultSchema = z.array(z.object({
    order_id: z.string().uuid(),
    created: z.boolean(),
})).length(1);

const waitlistResultSchema = z.array(z.object({
    waitlist_id: z.string().uuid(),
    created: z.boolean(),
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
        'EARLYBIRD_PRICE_SNAPSHOT_INVALID',
    ].find(code => message.includes(code));
    return knownCode ?? 'EARLYBIRD_PERSISTENCE_FAILED';
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
        if (error) throw new EarlybirdPersistenceError(boundedDatabaseCode(error));
        const parsed = checkoutResultSchema.safeParse(data);
        if (!parsed.success) {
            throw new EarlybirdPersistenceError('EARLYBIRD_PERSISTENCE_FAILED');
        }
        return Object.freeze({
            orderId: parsed.data[0].order_id,
            created: parsed.data[0].created,
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
