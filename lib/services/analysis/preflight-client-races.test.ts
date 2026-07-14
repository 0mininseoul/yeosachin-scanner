import { describe, expect, it } from 'vitest';
import {
    freshPlanSnapshotV1Schema,
    preflightStatusV1Schema,
} from '@/lib/contracts/analysis-v2';
import {
    mergeFreshPlanSnapshot,
    mergeLoadedPreflight,
    PreflightRequestCoordinator,
    restoreExclusionState,
} from '@/hooks/useAnalysisV2Preflight';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const otherPreflightId = '223e4567-e89b-42d3-a456-426614174000';

const plans = [
    {
        planId: 'basic',
        launchStatus: 'test_only',
        relationshipCapacity: { followers: 400, following: 400 },
        detailedMutualLimit: 300,
        selectionState: 'required',
        unavailableReason: null,
        pricingVersion: 'deferred',
        price: { status: 'deferred', currency: 'KRW', amountKrw: null },
    },
    {
        planId: 'standard',
        launchStatus: 'test_only',
        relationshipCapacity: { followers: 800, following: 800 },
        detailedMutualLimit: 600,
        selectionState: 'available_upgrade',
        unavailableReason: null,
        pricingVersion: 'deferred',
        price: { status: 'deferred', currency: 'KRW', amountKrw: null },
    },
    {
        planId: 'plus',
        launchStatus: 'test_only',
        relationshipCapacity: { followers: 1_200, following: 1_200 },
        detailedMutualLimit: 900,
        selectionState: 'available_upgrade',
        unavailableReason: null,
        pricingVersion: 'deferred',
        price: { status: 'deferred', currency: 'KRW', amountKrw: null },
    },
] as const;

describe('analysis V2 preflight request coordinator', () => {
    it('restores a durable exclusion decision and never regresses it to pending', () => {
        expect(restoreExclusionState('undecided', 'exclude')).toBe('excluded');
        expect(restoreExclusionState('undecided', 'skip')).toBe('skipped');
        expect(restoreExclusionState('excluded', 'pending')).toBe('excluded');
        expect(restoreExclusionState('skipped', 'pending')).toBe('skipped');
        expect(restoreExclusionState('saving', 'pending')).toBe('saving');

        const saved = preflightStatusV1Schema.parse({
            schemaVersion: 1,
            preflightId,
            expiresAt: '2030-07-14T12:00:00.000Z',
            status: 'pending',
            exclusionDecision: 'exclude',
        });
        const stale = preflightStatusV1Schema.parse({
            ...saved,
            exclusionDecision: 'pending',
        });
        expect(mergeLoadedPreflight(saved, stale).exclusionDecision).toBe('exclude');
    });

    it('aborts and fences every response from an older target generation', () => {
        const coordinator = new PreflightRequestCoordinator();
        const firstGeneration = coordinator.beginLifecycle(preflightId);
        const staleGet = coordinator.beginRequest(firstGeneration, preflightId)!;
        const stalePatch = coordinator.beginRequest(firstGeneration, preflightId)!;

        const nextGeneration = coordinator.beginLifecycle(otherPreflightId);

        expect(staleGet.signal.aborted).toBe(true);
        expect(stalePatch.signal.aborted).toBe(true);
        expect(staleGet.isCurrent()).toBe(false);
        expect(stalePatch.isCurrent()).toBe(false);
        expect(coordinator.isCurrent(nextGeneration, otherPreflightId)).toBe(true);
        expect(coordinator.beginRequest(firstGeneration, preflightId)).toBeNull();
    });

    it('allows only one polling request until the current one settles', () => {
        const coordinator = new PreflightRequestCoordinator();
        const generation = coordinator.beginLifecycle(preflightId);
        const firstPoll = coordinator.beginPoll(generation, preflightId)!;

        expect(coordinator.beginPoll(generation, preflightId)).toBeNull();
        firstPoll.finish();

        const nextPoll = coordinator.beginPoll(generation, preflightId);
        expect(nextPoll).not.toBeNull();
        nextPoll?.abort();
        expect(nextPoll?.signal.aborted).toBe(true);
    });

    it('binds an accepted POST to its current preflight id', () => {
        const coordinator = new PreflightRequestCoordinator();
        const generation = coordinator.beginLifecycle();
        const createRequest = coordinator.beginRequest(generation)!;

        expect(coordinator.attachPreflight(generation, preflightId)).toBe(true);
        expect(createRequest.isCurrent()).toBe(true);
        expect(coordinator.beginRequest(generation, otherPreflightId)).toBeNull();
        expect(coordinator.beginRequest(generation, preflightId)).not.toBeNull();
    });
});

describe('fresh plan client merge', () => {
    it('replaces only the bounded plan and count fields on a ready preflight', () => {
        const current = preflightStatusV1Schema.parse({
            schemaVersion: 1,
            preflightId,
            expiresAt: '2030-07-14T12:00:00.000Z',
            status: 'ready',
            exclusionDecision: 'exclude',
            target: {
                username: 'target.name',
                fullName: 'Target',
                bio: null,
                profileImage: null,
                followersCount: 300,
                followingCount: 350,
                isPrivate: false,
            },
            accessMode: 'test_entitlement',
            capacityRequiredPlan: 'basic',
            requiredPlan: 'basic',
            plans,
            pricingVersion: 'deferred',
        });
        expect(current.status).toBe('ready');
        if (current.status !== 'ready') throw new Error('ready fixture expected');

        const latest = freshPlanSnapshotV1Schema.parse({
            followersCount: 620,
            followingCount: 710,
            capacityRequiredPlanId: 'standard',
            requiredPlanId: 'standard',
            selectedPlanId: 'basic',
            plans: plans.map((plan, index) => ({
                ...plan,
                selectionState: index === 0
                    ? 'unavailable'
                    : index === 1 ? 'required' : 'available_upgrade',
                unavailableReason: index === 0 ? 'below_required_plan' : null,
            })),
            pricingVersion: 'deferred',
            refreshedAt: '2026-07-14T12:00:00.000Z',
        });

        const merged = mergeFreshPlanSnapshot(current, latest);

        expect(merged).toMatchObject({
            status: 'ready',
            capacityRequiredPlan: 'standard',
            requiredPlan: 'standard',
            target: {
                username: 'target.name',
                fullName: 'Target',
                followersCount: 620,
                followingCount: 710,
            },
        });
        expect(merged?.plans[0]).toMatchObject({
            selectionState: 'unavailable',
            unavailableReason: 'below_required_plan',
        });
    });

    it('refuses to merge a blocked latest snapshot into a ready preflight', () => {
        const current = preflightStatusV1Schema.parse({
            schemaVersion: 1,
            preflightId,
            expiresAt: '2030-07-14T12:00:00.000Z',
            status: 'ready',
            exclusionDecision: 'skip',
            target: {
                username: 'target.name',
                fullName: null,
                bio: null,
                profileImage: null,
                followersCount: 300,
                followingCount: 350,
                isPrivate: false,
            },
            accessMode: 'test_entitlement',
            capacityRequiredPlan: 'basic',
            requiredPlan: 'basic',
            plans,
            pricingVersion: 'deferred',
        });
        if (current.status !== 'ready') throw new Error('ready fixture expected');
        const blocked = freshPlanSnapshotV1Schema.parse({
            followersCount: 1_500,
            followingCount: 1_400,
            capacityRequiredPlanId: null,
            requiredPlanId: null,
            selectedPlanId: 'plus',
            plans: plans.map(plan => ({
                ...plan,
                selectionState: 'unavailable',
                unavailableReason: 'over_plus_capacity',
            })),
            pricingVersion: 'deferred',
            refreshedAt: '2026-07-14T12:00:00.000Z',
        });

        expect(mergeFreshPlanSnapshot(current, blocked)).toBeNull();
    });
});
