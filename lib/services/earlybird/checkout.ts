import {
    EARLYBIRD_DISCLOSURE_TEXT,
    EARLYBIRD_DISCLOSURE_VERSION,
    EARLYBIRD_PLAN_CATALOG,
    EARLYBIRD_PRICING_VERSION,
    isPaidEarlybirdPlanId,
} from '@/lib/domain/earlybird/catalog';
import {
    ANALYSIS_PLAN_CATALOG,
    PLAN_IDS,
    type PlanId,
} from '@/lib/domain/analysis/plan-catalog';
import { getGrobleCheckoutUrl, readGrobleConfig } from '@/lib/services/groble/config';
import { normalizeKoreanMobileNumber } from '@/lib/services/identity/phone-number';
import { fetchEarlybirdRemainingSlots } from './inventory';
import {
    earlybirdStore,
    EarlybirdPersistenceError,
} from './store';

export class EarlybirdWaitlistRequiredError extends Error {
    constructor() {
        super('EARLYBIRD_WAITLIST_REQUIRED');
        this.name = 'EarlybirdWaitlistRequiredError';
    }
}

export class EarlybirdSoldOutError extends Error {
    constructor() {
        super('EARLYBIRD_SOLD_OUT');
        this.name = 'EarlybirdSoldOutError';
    }
}

export class EarlybirdCheckoutRecoveryError extends Error {
    readonly code:
        | 'EARLYBIRD_CHECKOUT_RECOVERY_NOT_FOUND'
        | 'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE'
        | 'EARLYBIRD_LEGACY_REFRESH_REQUIRED';

    constructor(code: EarlybirdCheckoutRecoveryError['code']) {
        super(code);
        this.name = 'EarlybirdCheckoutRecoveryError';
        this.code = code;
    }
}

export interface CurrentEarlybirdCheckoutPhone {
    normalizedPhone: string;
    verificationSource: 'kakao_rest_api';
}

export async function loadCurrentEarlybirdCheckoutPhone(
    userId: string,
    now: Date = new Date()
): Promise<CurrentEarlybirdCheckoutPhone> {
    const current = await earlybirdStore.findCurrentCheckoutPhone(userId);
    const verifiedAtMs = current?.verifiedAt
        ? Date.parse(current.verifiedAt)
        : Number.NaN;
    if (
        !current
        || current.provider !== 'kakao'
        || !current.phoneNumber
        || !current.phoneNumberNormalized
        || normalizeKoreanMobileNumber(current.phoneNumber)
            !== current.phoneNumberNormalized
        || current.verificationSource !== 'kakao_rest_api'
        || !Number.isFinite(verifiedAtMs)
        || verifiedAtMs < now.getTime() - 24 * 60 * 60 * 1_000
    ) {
        throw new EarlybirdPersistenceError('CHECKOUT_PHONE_REQUIRED');
    }
    return Object.freeze({
        normalizedPhone: current.phoneNumberNormalized,
        verificationSource: 'kakao_rest_api',
    });
}

export async function createEarlybirdCheckout(input: {
    userId: string;
    preflightId: string;
    planId: PlanId;
}) {
    if (!isPaidEarlybirdPlanId(input.planId)) {
        throw new EarlybirdWaitlistRequiredError();
    }
    const remainingSlots = (await fetchEarlybirdRemainingSlots())[input.planId];
    if (remainingSlots !== undefined && remainingSlots <= 0) {
        throw new EarlybirdSoldOutError();
    }
    const config = readGrobleConfig();
    const plan = EARLYBIRD_PLAN_CATALOG[input.planId];
    const record = await earlybirdStore.createCheckout({
        userId: input.userId,
        preflightId: input.preflightId,
        planId: input.planId,
        productId: config.productIds[input.planId],
        paymentAddress: config.paymentAddresses[input.planId],
        amountKrw: plan.earlybirdAmountKrw,
        pricingVersion: EARLYBIRD_PRICING_VERSION,
        disclosureVersion: EARLYBIRD_DISCLOSURE_VERSION,
        disclosureText: EARLYBIRD_DISCLOSURE_TEXT,
        disclosureAcceptedAt: new Date().toISOString(),
    });
    return Object.freeze({
        orderId: record.orderId,
        created: record.created,
        checkoutUrl: getGrobleCheckoutUrl(
            input.planId,
            record.sellerReference,
            config
        ),
    });
}

export async function recoverEarlybirdCheckout(input: {
    userId: string;
    preflightId: string;
    currentPhone: CurrentEarlybirdCheckoutPhone;
}) {
    const record = await earlybirdStore.findCheckoutForRecovery(
        input.userId,
        input.preflightId
    );
    if (!record) {
        throw new EarlybirdCheckoutRecoveryError(
            'EARLYBIRD_CHECKOUT_RECOVERY_NOT_FOUND'
        );
    }
    if (record.status !== 'payment_pending') {
        throw new EarlybirdCheckoutRecoveryError(
            'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE'
        );
    }
    if (record.pricingVersion === 'earlybird-2026-07-v1') {
        throw new EarlybirdCheckoutRecoveryError(
            'EARLYBIRD_LEGACY_REFRESH_REQUIRED'
        );
    }

    const config = readGrobleConfig();
    const amountKrw = record.pricingVersion === EARLYBIRD_PRICING_VERSION
        ? EARLYBIRD_PLAN_CATALOG[record.planId].earlybirdAmountKrw
        : null;
    if (
        amountKrw === null
        || record.expectedAmountKrw !== amountKrw
        || record.expectedProductId !== config.productIds[record.planId]
        || record.buyerMatchPolicy !== 'verified_kakao_phone'
        || !record.expectedBuyerPhoneNumberNormalized
        || record.expectedBuyerPhoneVerificationSource !== 'kakao_rest_api'
        || record.expectedBuyerPhoneNumberNormalized
            !== input.currentPhone.normalizedPhone
        || record.expectedBuyerPhoneVerificationSource
            !== input.currentPhone.verificationSource
        || record.disclosureVersion !== EARLYBIRD_DISCLOSURE_VERSION
        || record.disclosureText !== EARLYBIRD_DISCLOSURE_TEXT
        || !record.disclosureAcceptedAt
        || !record.sellerReference
        || record.paymentId !== null
        || record.actualAmountKrw !== null
        || record.paidAt !== null
    ) {
        throw new EarlybirdCheckoutRecoveryError(
            'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE'
        );
    }

    return Object.freeze({
        orderId: record.orderId,
        planId: record.planId,
        expectedAmountKrw: record.expectedAmountKrw,
        checkoutUrl: getGrobleCheckoutUrl(
            record.planId,
            record.sellerReference,
            config
        ),
    });
}

function currentCommerceSnapshots() {
    return Object.freeze({
        launchStatusSnapshot: Object.fromEntries(PLAN_IDS.map(planId => [
            planId,
            ANALYSIS_PLAN_CATALOG[planId].launchStatus,
        ])),
        planCatalogSnapshot: Object.fromEntries(PLAN_IDS.map(planId => {
            const plan = ANALYSIS_PLAN_CATALOG[planId];
            return [planId, {
                launchStatus: plan.launchStatus,
                relationshipCapacity: { ...plan.relationshipCapacity },
                detailedMutualLimit: plan.detailedMutualLimit,
            }];
        })),
        pricingSnapshot: Object.fromEntries(PLAN_IDS.map(planId => [
            planId,
            { ...ANALYSIS_PLAN_CATALOG[planId].price },
        ])),
    });
}

export async function refreshLegacyEarlybirdCheckout(input: {
    userId: string;
    legacyOrderId: string;
}) {
    const config = readGrobleConfig();
    const snapshots = currentCommerceSnapshots();
    const record = await earlybirdStore.refreshLegacyCheckout({
        userId: input.userId,
        legacyOrderId: input.legacyOrderId,
        disclosureVersion: EARLYBIRD_DISCLOSURE_VERSION,
        disclosureText: EARLYBIRD_DISCLOSURE_TEXT,
        disclosureAcceptedAt: new Date().toISOString(),
        ...snapshots,
    });
    if (
        record.paymentAddress !== config.paymentAddresses[record.planId]
    ) {
        throw new EarlybirdPersistenceError(
            'EARLYBIRD_PRODUCT_CONFIGURATION_REQUIRED'
        );
    }
    return Object.freeze({
        orderId: record.orderId,
        preflightId: record.preflightId,
        created: record.created,
        checkoutUrl: getGrobleCheckoutUrl(
            record.planId,
            record.sellerReference,
            config
        ),
    });
}

export async function joinEarlybirdWaitlist(input: {
    userId: string;
    preflightId: string;
}) {
    return earlybirdStore.joinWaitlist(input.userId, input.preflightId);
}
