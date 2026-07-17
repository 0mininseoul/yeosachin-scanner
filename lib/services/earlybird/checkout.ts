import {
    EARLYBIRD_DISCLOSURE_TEXT,
    EARLYBIRD_DISCLOSURE_VERSION,
    EARLYBIRD_PLAN_CATALOG,
    EARLYBIRD_PRICING_VERSION,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { getGrobleCheckoutUrl, readGrobleConfig } from '@/lib/services/groble/config';
import { earlybirdStore } from './store';

export class EarlybirdWaitlistRequiredError extends Error {
    constructor() {
        super('EARLYBIRD_WAITLIST_REQUIRED');
        this.name = 'EarlybirdWaitlistRequiredError';
    }
}

export async function createEarlybirdCheckout(input: {
    userId: string;
    preflightId: string;
    planId: PlanId;
}) {
    if (!isPaidEarlybirdPlanId(input.planId)) {
        throw new EarlybirdWaitlistRequiredError();
    }
    const config = readGrobleConfig();
    const plan = EARLYBIRD_PLAN_CATALOG[input.planId];
    const record = await earlybirdStore.createCheckout({
        userId: input.userId,
        preflightId: input.preflightId,
        planId: input.planId,
        productId: config.productIds[input.planId],
        amountKrw: plan.earlybirdAmountKrw,
        pricingVersion: EARLYBIRD_PRICING_VERSION,
        disclosureVersion: EARLYBIRD_DISCLOSURE_VERSION,
        disclosureText: EARLYBIRD_DISCLOSURE_TEXT,
        disclosureAcceptedAt: new Date().toISOString(),
    });
    return Object.freeze({
        orderId: record.orderId,
        created: record.created,
        checkoutUrl: getGrobleCheckoutUrl(input.planId, config),
    });
}

export async function joinEarlybirdWaitlist(input: {
    userId: string;
    preflightId: string;
}) {
    return earlybirdStore.joinWaitlist(input.userId, input.preflightId);
}
