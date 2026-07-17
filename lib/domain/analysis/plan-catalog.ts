export const PLAN_IDS = ['basic', 'standard', 'plus'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export const PLAN_LAUNCH_STATUSES = ['production', 'test_only', 'disabled'] as const;

export type PlanLaunchStatus = (typeof PLAN_LAUNCH_STATUSES)[number];

export const PLAN_ACCESS_MODES = ['production', 'test_entitlement'] as const;

export type PlanAccessMode = (typeof PLAN_ACCESS_MODES)[number];

export type PlanLaunchStatusOverrides = Readonly<Partial<Record<PlanId, PlanLaunchStatus>>>;

export type PlanEligibilityCatalog = Readonly<Record<PlanId, Readonly<Pick<
    AnalysisPlan,
    'launchStatus' | 'relationshipCapacity' | 'detailedMutualLimit'
>>>>;

export interface PlanEligibilityOptions {
    accessMode?: PlanAccessMode;
    launchStatusOverrides?: PlanLaunchStatusOverrides;
    catalog?: PlanEligibilityCatalog;
}

export const PLAN_PRICING_VERSION = 'earlybird-2026-07-v1' as const;

export type DeferredKrwPrice = Readonly<{
    currency: 'KRW';
    status: 'deferred';
    amountKrw: null;
}>;

export type QuotedKrwPrice = Readonly<{
    currency: 'KRW';
    status: 'quoted';
    amountKrw: number;
}>;

export type KrwPrice = DeferredKrwPrice | QuotedKrwPrice;

export interface AnalysisPlan {
    id: PlanId;
    launchStatus: PlanLaunchStatus;
    relationshipCapacity: Readonly<{
        followers: number;
        following: number;
    }>;
    detailedMutualLimit: number;
    pricingVersion: typeof PLAN_PRICING_VERSION;
    price: KrwPrice;
}

const DEFERRED_KRW_PRICE: DeferredKrwPrice = Object.freeze({
    currency: 'KRW',
    status: 'deferred',
    amountKrw: null,
});

function quotedKrwPrice(amountKrw: number): QuotedKrwPrice {
    return Object.freeze({ currency: 'KRW', status: 'quoted', amountKrw });
}

export const ANALYSIS_PLAN_CATALOG = Object.freeze({
    basic: Object.freeze({
        id: 'basic',
        launchStatus: 'production',
        relationshipCapacity: Object.freeze({ followers: 400, following: 400 }),
        detailedMutualLimit: 300,
        pricingVersion: PLAN_PRICING_VERSION,
        price: quotedKrwPrice(14_900),
    }),
    standard: Object.freeze({
        id: 'standard',
        launchStatus: 'production',
        relationshipCapacity: Object.freeze({ followers: 800, following: 800 }),
        detailedMutualLimit: 600,
        pricingVersion: PLAN_PRICING_VERSION,
        price: quotedKrwPrice(19_900),
    }),
    plus: Object.freeze({
        id: 'plus',
        launchStatus: 'production',
        relationshipCapacity: Object.freeze({ followers: 1_200, following: 1_200 }),
        detailedMutualLimit: 900,
        pricingVersion: PLAN_PRICING_VERSION,
        price: DEFERRED_KRW_PRICE,
    }),
} satisfies Readonly<Record<PlanId, AnalysisPlan>>);

export type RelationshipCounts = Readonly<{
    followers: number;
    following: number;
}>;

export type PlanEligibility =
    | Readonly<{
        status: 'eligible';
        capacityRequiredPlanId: PlanId;
        requiredPlanId: PlanId;
        selectablePlanIds: readonly PlanId[];
        counts: RelationshipCounts;
    }>
    | Readonly<{
        status: 'blocked';
        reason: 'over_plus_capacity';
        counts: RelationshipCounts;
        maximumSupported: RelationshipCounts;
    }>
    | Readonly<{
        status: 'blocked';
        reason: 'launch_gate';
        capacityRequiredPlanId: PlanId;
        counts: RelationshipCounts;
    }>;

export type PlanSelectionAssessment =
    | Readonly<{
        allowed: true;
        selectedPlanId: PlanId;
        requiredPlanId: PlanId;
    }>
    | Readonly<{
        allowed: false;
        selectedPlanId: PlanId;
        reason: 'below_required_plan';
        requiredPlanId: PlanId;
    }>
    | Readonly<{
        allowed: false;
        selectedPlanId: PlanId;
        reason: 'over_plus_capacity';
    }>
    | Readonly<{
        allowed: false;
        selectedPlanId: PlanId;
        reason: 'launch_gate';
        requiredPlanId: PlanId | null;
    }>;

export type PlanUnavailableReason = 'below_required_plan' | 'launch_gate';

export interface PlanSelectionCardState {
    planId: PlanId;
    launchStatus: PlanLaunchStatus;
    selectionState: 'required' | 'available_upgrade' | 'unavailable';
    unavailableReason: PlanUnavailableReason | null;
}

export const RELATIONSHIP_MIN_COVERAGE_RATIO = 0.99;

export interface RelationshipCoverageAssessment {
    detected: number;
    collected: number;
    minimumRequired: number;
    coverageRatio: number;
    meetsCoverageGate: boolean;
    exactCountMatch: boolean;
}

export interface DetailedScreeningScope {
    detected: number;
    screened: number;
    notScreened: number;
    isFullyScreened: boolean;
}

function assertCount(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${field} must be a non-negative safe integer.`);
    }
}

function validatedCounts(counts: RelationshipCounts): RelationshipCounts {
    assertCount(counts.followers, 'followers');
    assertCount(counts.following, 'following');
    return Object.freeze({ ...counts });
}

function supportsCounts(
    plan: Pick<AnalysisPlan, 'relationshipCapacity'>,
    counts: RelationshipCounts
): boolean {
    return counts.followers <= plan.relationshipCapacity.followers
        && counts.following <= plan.relationshipCapacity.following;
}

function planSupportsAccessMode(
    launchStatus: PlanLaunchStatus,
    accessMode: PlanAccessMode
): boolean {
    if (launchStatus === 'disabled') {
        return false;
    }
    return accessMode === 'test_entitlement' || launchStatus === 'production';
}

function resolvedOptions(options: PlanEligibilityOptions): Required<PlanEligibilityOptions> {
    return {
        accessMode: options.accessMode ?? 'production',
        launchStatusOverrides: options.launchStatusOverrides ?? {},
        catalog: options.catalog ?? ANALYSIS_PLAN_CATALOG,
    };
}

export function getAnalysisPlan(planId: PlanId): AnalysisPlan {
    return ANALYSIS_PLAN_CATALOG[planId];
}

export function getEffectivePlanLaunchStatus(
    planId: PlanId,
    overrides: PlanLaunchStatusOverrides = {},
    catalog: PlanEligibilityCatalog = ANALYSIS_PLAN_CATALOG
): PlanLaunchStatus {
    const override = overrides[planId];
    if (override === undefined) {
        return catalog[planId].launchStatus;
    }
    if (!isPlanLaunchStatusOverrideAllowed(planId, override, catalog)) {
        throw new RangeError(
            `${planId} launch status cannot be promoted beyond the server catalog.`
        );
    }
    return override;
}

export function isPlanLaunchStatusOverrideAllowed(
    planId: PlanId,
    effectiveStatus: PlanLaunchStatus,
    catalog: PlanEligibilityCatalog = ANALYSIS_PLAN_CATALOG
): boolean {
    const configuredStatus = catalog[planId].launchStatus;
    const restrictiveness: Record<PlanLaunchStatus, number> = {
        disabled: 0,
        test_only: 1,
        production: 2,
    };
    return restrictiveness[effectiveStatus] <= restrictiveness[configuredStatus];
}

export function determinePlanEligibility(
    input: RelationshipCounts,
    options: PlanEligibilityOptions = {}
): PlanEligibility {
    const counts = validatedCounts(input);
    const resolved = resolvedOptions(options);
    const capacityRequiredPlanIndex = PLAN_IDS.findIndex(planId => (
        supportsCounts(resolved.catalog[planId], counts)
    ));

    if (capacityRequiredPlanIndex === -1) {
        const plus = resolved.catalog.plus;
        return Object.freeze({
            status: 'blocked',
            reason: 'over_plus_capacity',
            counts,
            maximumSupported: Object.freeze({
                followers: plus.relationshipCapacity.followers,
                following: plus.relationshipCapacity.following,
            }),
        });
    }

    const capacityRequiredPlanId = PLAN_IDS[capacityRequiredPlanIndex];
    const selectablePlanIds = PLAN_IDS.slice(capacityRequiredPlanIndex).filter(planId => (
        planSupportsAccessMode(
            getEffectivePlanLaunchStatus(
                planId,
                resolved.launchStatusOverrides,
                resolved.catalog
            ),
            resolved.accessMode
        )
    ));

    if (selectablePlanIds.length === 0) {
        return Object.freeze({
            status: 'blocked',
            reason: 'launch_gate',
            capacityRequiredPlanId,
            counts,
        });
    }

    const requiredPlanId = selectablePlanIds[0];
    return Object.freeze({
        status: 'eligible',
        capacityRequiredPlanId,
        requiredPlanId,
        selectablePlanIds: Object.freeze(selectablePlanIds),
        counts,
    });
}

export function assessPlanSelection(
    selectedPlanId: PlanId,
    counts: RelationshipCounts,
    options: PlanEligibilityOptions = {}
): PlanSelectionAssessment {
    const eligibility = determinePlanEligibility(counts, options);
    if (eligibility.status === 'blocked') {
        if (eligibility.reason === 'launch_gate') {
            return Object.freeze({
                allowed: false,
                selectedPlanId,
                reason: 'launch_gate',
                requiredPlanId: null,
            });
        }
        return Object.freeze({
            allowed: false,
            selectedPlanId,
            reason: 'over_plus_capacity',
        });
    }

    if (!eligibility.selectablePlanIds.includes(selectedPlanId)) {
        const selectedPlanIndex = PLAN_IDS.indexOf(selectedPlanId);
        const capacityRequiredPlanIndex = PLAN_IDS.indexOf(eligibility.capacityRequiredPlanId);
        if (selectedPlanIndex >= capacityRequiredPlanIndex) {
            return Object.freeze({
                allowed: false,
                selectedPlanId,
                reason: 'launch_gate',
                requiredPlanId: eligibility.requiredPlanId,
            });
        }
        return Object.freeze({
            allowed: false,
            selectedPlanId,
            reason: 'below_required_plan',
            requiredPlanId: eligibility.requiredPlanId,
        });
    }

    return Object.freeze({
        allowed: true,
        selectedPlanId,
        requiredPlanId: eligibility.requiredPlanId,
    });
}

export function buildPlanSelectionCards(
    input: RelationshipCounts,
    options: PlanEligibilityOptions = {}
): readonly PlanSelectionCardState[] {
    const counts = validatedCounts(input);
    const resolved = resolvedOptions(options);
    const eligibility = determinePlanEligibility(counts, resolved);
    const capacityRequiredPlanIndex = PLAN_IDS.findIndex(planId => (
        supportsCounts(resolved.catalog[planId], counts)
    ));

    return Object.freeze(PLAN_IDS.map((planId, index): PlanSelectionCardState => {
        const launchStatus = getEffectivePlanLaunchStatus(
            planId,
            resolved.launchStatusOverrides,
            resolved.catalog
        );
        if (capacityRequiredPlanIndex === -1 || index < capacityRequiredPlanIndex) {
            return Object.freeze({
                planId,
                launchStatus,
                selectionState: 'unavailable',
                unavailableReason: 'below_required_plan',
            });
        }

        const selectable = planSupportsAccessMode(launchStatus, resolved.accessMode);
        if (!selectable || eligibility.status === 'blocked') {
            return Object.freeze({
                planId,
                launchStatus,
                selectionState: 'unavailable',
                unavailableReason: 'launch_gate',
            });
        }

        return Object.freeze({
            planId,
            launchStatus,
            selectionState: planId === eligibility.requiredPlanId
                ? 'required'
                : 'available_upgrade',
            unavailableReason: null,
        });
    }));
}

export function minimumCompleteRelationshipCount(detected: number): number {
    assertCount(detected, 'detected');
    return Math.ceil(detected * RELATIONSHIP_MIN_COVERAGE_RATIO);
}

export function assessRelationshipCoverage(
    detected: number,
    collected: number
): RelationshipCoverageAssessment {
    assertCount(detected, 'detected');
    assertCount(collected, 'collected');

    const minimumRequired = minimumCompleteRelationshipCount(detected);
    return Object.freeze({
        detected,
        collected,
        minimumRequired,
        coverageRatio: detected === 0 ? 1 : Math.min(collected / detected, 1),
        meetsCoverageGate: collected >= minimumRequired,
        exactCountMatch: collected === detected,
    });
}

export function calculateDetailedScreeningScope(
    planId: PlanId,
    detected: number
): DetailedScreeningScope {
    assertCount(detected, 'detected');
    const screened = Math.min(detected, getAnalysisPlan(planId).detailedMutualLimit);
    return Object.freeze({
        detected,
        screened,
        notScreened: detected - screened,
        isFullyScreened: screened === detected,
    });
}
