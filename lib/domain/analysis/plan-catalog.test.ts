import { describe, expect, it } from 'vitest';
import {
    ANALYSIS_PLAN_CATALOG,
    PLAN_PRICING_VERSION,
    assessPlanSelection,
    assessRelationshipCoverage,
    buildPlanSelectionCards,
    calculateDetailedScreeningScope,
    determinePlanEligibility,
    minimumCompleteRelationshipCount,
} from './plan-catalog';

const TEST_ENTITLEMENT = { accessMode: 'test_entitlement' } as const;

describe('analysis plan catalog', () => {
    it('keeps server-owned capacities and the earlybird pricing snapshot', () => {
        expect(ANALYSIS_PLAN_CATALOG.basic).toMatchObject({
            relationshipCapacity: { followers: 400, following: 400 },
            detailedMutualLimit: 300,
        });
        expect(ANALYSIS_PLAN_CATALOG.standard).toMatchObject({
            relationshipCapacity: { followers: 800, following: 800 },
            detailedMutualLimit: 600,
        });
        expect(ANALYSIS_PLAN_CATALOG.plus).toMatchObject({
            relationshipCapacity: { followers: 1_200, following: 1_200 },
            detailedMutualLimit: 900,
        });

        for (const plan of Object.values(ANALYSIS_PLAN_CATALOG)) {
            expect(plan.launchStatus).toBe('production');
            expect(plan.pricingVersion).toBe(PLAN_PRICING_VERSION);
        }
        expect(ANALYSIS_PLAN_CATALOG.basic.price).toEqual({
            currency: 'KRW', status: 'quoted', amountKrw: 14_900,
        });
        expect(ANALYSIS_PLAN_CATALOG.standard.price).toEqual({
            currency: 'KRW', status: 'quoted', amountKrw: 19_900,
        });
        expect(ANALYSIS_PLAN_CATALOG.plus.price).toEqual({
            currency: 'KRW', status: 'deferred', amountKrw: null,
        });
    });

    it('allows production preflight against the active earlybird catalog', () => {
        expect(determinePlanEligibility({ followers: 100, following: 100 })).toMatchObject({
            status: 'eligible',
            capacityRequiredPlanId: 'basic',
            requiredPlanId: 'basic',
        });
    });

    it('automatically selects the smallest plan that covers both relationship sides', () => {
        expect(determinePlanEligibility(
            { followers: 400, following: 400 },
            TEST_ENTITLEMENT
        )).toMatchObject({
            status: 'eligible',
            capacityRequiredPlanId: 'basic',
            requiredPlanId: 'basic',
            selectablePlanIds: ['basic', 'standard', 'plus'],
        });
        expect(determinePlanEligibility(
            { followers: 401, following: 200 },
            TEST_ENTITLEMENT
        )).toMatchObject({
            status: 'eligible',
            capacityRequiredPlanId: 'standard',
            requiredPlanId: 'standard',
            selectablePlanIds: ['standard', 'plus'],
        });
        expect(determinePlanEligibility(
            { followers: 700, following: 801 },
            TEST_ENTITLEMENT
        )).toMatchObject({
            status: 'eligible',
            capacityRequiredPlanId: 'plus',
            requiredPlanId: 'plus',
            selectablePlanIds: ['plus'],
        });
    });

    it('promotes the required plan to the next active upper plan', () => {
        const options = {
            accessMode: 'test_entitlement',
            launchStatusOverrides: {
                basic: 'disabled',
                standard: 'disabled',
                plus: 'test_only',
            },
        } as const;

        expect(determinePlanEligibility({ followers: 650, following: 500 }, options)).toEqual({
            status: 'eligible',
            capacityRequiredPlanId: 'standard',
            requiredPlanId: 'plus',
            selectablePlanIds: ['plus'],
            counts: { followers: 650, following: 500 },
        });
        expect(buildPlanSelectionCards({ followers: 650, following: 500 }, options)).toEqual([
            {
                planId: 'basic',
                launchStatus: 'disabled',
                selectionState: 'unavailable',
                unavailableReason: 'below_required_plan',
            },
            {
                planId: 'standard',
                launchStatus: 'disabled',
                selectionState: 'unavailable',
                unavailableReason: 'launch_gate',
            },
            {
                planId: 'plus',
                launchStatus: 'test_only',
                selectionState: 'required',
                unavailableReason: null,
            },
        ]);
    });

    it('allows only restrictive runtime launch overrides', () => {
        expect(determinePlanEligibility(
            { followers: 100, following: 100 },
            { launchStatusOverrides: { basic: 'disabled' } }
        )).toMatchObject({ requiredPlanId: 'standard' });
    });

    it('keeps every card visible and disables a gated upper plan for test entitlement', () => {
        const options = {
            ...TEST_ENTITLEMENT,
            launchStatusOverrides: { plus: 'disabled' },
        } as const;

        expect(buildPlanSelectionCards({ followers: 650, following: 500 }, options)).toEqual([
            expect.objectContaining({
                planId: 'basic',
                selectionState: 'unavailable',
                unavailableReason: 'below_required_plan',
            }),
            expect.objectContaining({
                planId: 'standard',
                selectionState: 'required',
                unavailableReason: null,
            }),
            expect.objectContaining({
                planId: 'plus',
                launchStatus: 'disabled',
                selectionState: 'unavailable',
                unavailableReason: 'launch_gate',
            }),
        ]);
    });

    it('blocks when no capacity-compatible plan passes the active launch gate', () => {
        expect(determinePlanEligibility(
            { followers: 900, following: 900 },
            {
                ...TEST_ENTITLEMENT,
                launchStatusOverrides: { plus: 'disabled' },
            }
        )).toEqual({
            status: 'blocked',
            reason: 'launch_gate',
            capacityRequiredPlanId: 'plus',
            counts: { followers: 900, following: 900 },
        });
    });

    it('blocks accounts beyond Plus instead of silently truncating either side', () => {
        expect(determinePlanEligibility({ followers: 1_201, following: 3 })).toEqual({
            status: 'blocked',
            reason: 'over_plus_capacity',
            counts: { followers: 1_201, following: 3 },
            maximumSupported: { followers: 1_200, following: 1_200 },
        });
        expect(determinePlanEligibility({ followers: 3, following: 1_201 }).status)
            .toBe('blocked');
    });

    it('rejects a lower plan while allowing the required plan or an upgrade', () => {
        const counts = { followers: 650, following: 500 };

        expect(assessPlanSelection('basic', counts, TEST_ENTITLEMENT)).toEqual({
            allowed: false,
            selectedPlanId: 'basic',
            reason: 'below_required_plan',
            requiredPlanId: 'standard',
        });
        expect(assessPlanSelection('standard', counts, TEST_ENTITLEMENT).allowed).toBe(true);
        expect(assessPlanSelection('plus', counts, TEST_ENTITLEMENT).allowed).toBe(true);
        expect(assessPlanSelection('plus', { followers: 1_201, following: 1 })).toEqual({
            allowed: false,
            selectedPlanId: 'plus',
            reason: 'over_plus_capacity',
        });
        expect(assessPlanSelection('plus', counts, {
            ...TEST_ENTITLEMENT,
            launchStatusOverrides: { plus: 'disabled' },
        })).toEqual({
            allowed: false,
            selectedPlanId: 'plus',
            reason: 'launch_gate',
            requiredPlanId: 'standard',
        });
    });

    it('fails closed on malformed detected relationship counts', () => {
        expect(() => determinePlanEligibility({ followers: -1, following: 0 })).toThrow(RangeError);
        expect(() => determinePlanEligibility({ followers: 1.5, following: 0 })).toThrow(RangeError);
        expect(() => determinePlanEligibility({ followers: Number.MAX_SAFE_INTEGER + 1, following: 0 }))
            .toThrow(RangeError);
    });
});

describe('relationship coverage', () => {
    it('uses a 99% minimum with ceiling semantics', () => {
        expect(minimumCompleteRelationshipCount(400)).toBe(396);
        expect(minimumCompleteRelationshipCount(474)).toBe(470);
        expect(minimumCompleteRelationshipCount(642)).toBe(636);

        expect(assessRelationshipCoverage(474, 469)).toMatchObject({
            minimumRequired: 470,
            meetsCoverageGate: false,
            exactCountMatch: false,
        });
        expect(assessRelationshipCoverage(474, 470)).toMatchObject({
            minimumRequired: 470,
            meetsCoverageGate: true,
            exactCountMatch: false,
        });
    });

    it('handles empty and graph-growth observations without invalid ratios', () => {
        expect(assessRelationshipCoverage(0, 0)).toEqual({
            detected: 0,
            collected: 0,
            minimumRequired: 0,
            coverageRatio: 1,
            meetsCoverageGate: true,
            exactCountMatch: true,
        });
        expect(assessRelationshipCoverage(10, 11)).toMatchObject({
            coverageRatio: 1,
            meetsCoverageGate: true,
            exactCountMatch: false,
        });
    });
});

describe('detailed mutual screening scope', () => {
    it('reports detected, screened, and not-screened counts per plan', () => {
        expect(calculateDetailedScreeningScope('basic', 350)).toEqual({
            detected: 350,
            screened: 300,
            notScreened: 50,
            isFullyScreened: false,
        });
        expect(calculateDetailedScreeningScope('standard', 550)).toEqual({
            detected: 550,
            screened: 550,
            notScreened: 0,
            isFullyScreened: true,
        });
        expect(calculateDetailedScreeningScope('plus', 1_000)).toEqual({
            detected: 1_000,
            screened: 900,
            notScreened: 100,
            isFullyScreened: false,
        });
    });

    it('preserves the scope total invariant at zero and every plan boundary', () => {
        for (const [planId, detected] of [
            ['basic', 0],
            ['basic', 300],
            ['standard', 601],
            ['plus', 900],
        ] as const) {
            const scope = calculateDetailedScreeningScope(planId, detected);
            expect(scope.screened + scope.notScreened).toBe(scope.detected);
        }
    });
});
