import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClaimedPreflight, PreflightStore } from './preflight';
import type { ScraperProvider } from '@/lib/services/instagram/providers/types';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { processPreflight } from './preflight';
import {
    __resetProvidersForTest,
    __setProvidersForTest,
} from '@/lib/services/instagram/scraper';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

function store(): PreflightStore {
    return {
        createOrReplay: vi.fn(),
        findForOwner: vi.fn(),
        reserveDispatch: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(async () => ({
            preflightId,
            claimToken: '323e4567-e89b-42d3-a456-426614174000', // gitleaks:allow -- UUID fixture
            userId,
            targetInstagramId: 'target.name',
            accessMode: 'test_entitlement',
            catalogSnapshot: {
                plans: {
                    basic: {
                        launchStatus: 'test_only',
                        relationshipCapacity: { followers: 400, following: 400 },
                        detailedMutualLimit: 300,
                    },
                    standard: {
                        launchStatus: 'test_only',
                        relationshipCapacity: { followers: 800, following: 800 },
                        detailedMutualLimit: 600,
                    },
                    plus: {
                        launchStatus: 'test_only',
                        relationshipCapacity: { followers: 1_200, following: 1_200 },
                        detailedMutualLimit: 900,
                    },
                },
                pricingVersion: 'deferred',
                prices: {
                    basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
                    standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
                    plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
                },
            },
        } satisfies ClaimedPreflight)),
        releaseClaim: vi.fn(async () => undefined),
        finalizeReady: vi.fn(async () => undefined),
        finalizeBlocked: vi.fn(async () => undefined),
        blockQueueUnavailable: vi.fn(async () => undefined),
        setExclusion: vi.fn(async () => undefined),
    };
}

describe('preflight free-provider boundary', () => {
    afterEach(() => __resetProvidersForTest());

    it('calls only the self-hosted profile capability with no fallback or telemetry sink', async () => {
        const selfHostedGetProfile = vi.fn(async (_username, context) => {
            expect(context?.requestId).toBeUndefined();
            expect(context?.onCostRunStarted).toBeUndefined();
            return {
                username: 'target.name',
                fullName: 'Target',
                bio: 'bio',
                profilePicUrl: 'https://cdn.example.com/avatar.jpg',
                followersCount: 350,
                followingCount: 300,
                postsCount: 10,
                isPrivate: false,
                isVerified: false,
            };
        });
        const forbiddenCapability = vi.fn(async () => {
            throw new Error('Paid or relationship capability must not run during preflight.');
        });
        const paidProvider = (name: 'apify' | 'coderx' | 'flashapi' | 'rapidapi') => ({
            name,
            paid: true,
            getProfile: forbiddenCapability,
            getFollowers: forbiddenCapability,
            getFollowing: forbiddenCapability,
        } satisfies ScraperProvider);
        __setProvidersForTest({
            SCRAPER_PROFILE: 'apify',
            SCRAPER_FALLBACK: 'true',
        }, {
            selfhosted: {
                name: 'selfhosted',
                paid: false,
                getProfile: selfHostedGetProfile,
                getFollowers: forbiddenCapability,
                getFollowing: forbiddenCapability,
            },
            apify: paidProvider('apify'),
            coderx: paidProvider('coderx'),
            flashapi: paidProvider('flashapi'),
            rapidapi: paidProvider('rapidapi'),
        });

        const preflightStore = store();
        await expect(processPreflight(preflightId, { store: preflightStore }))
            .resolves.toBe('ready');

        expect(selfHostedGetProfile).toHaveBeenCalledOnce();
        expect(forbiddenCapability).not.toHaveBeenCalled();
        expect(preflightStore.finalizeReady).toHaveBeenCalledOnce();
    });
});
