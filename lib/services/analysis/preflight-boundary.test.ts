import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ClaimedPreflight, PreflightStore } from './preflight';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { processPreflight } from './preflight';
import type { PreflightProviderRunStore } from './preflight-provider-run';

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
            workerAttemptCount: 1,
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

function providerRunStore(): PreflightProviderRunStore {
    return {
        load: vi.fn(async () => null),
        reserve: vi.fn(),
        checkpointStarted: vi.fn(),
        checkpointRejected: vi.fn(),
        checkpointTerminal: vi.fn(),
    };
}

describe('preflight free-provider boundary', () => {
    it('keeps count-only self-hosted as primary and does not pay on primary success', async () => {
        const source = readFileSync(new URL('./preflight.ts', import.meta.url), 'utf8');
        expect(source).toContain(
            "import { getSelfHostedProfileSummary } from '@/lib/services/instagram/providers/selfhosted'"
        );
        expect(source).not.toContain("import { getInstagramProfile } from '@/lib/services/instagram'");

        const getProfile = vi.fn(async () => ({
            username: 'target.name',
            fullName: 'Target',
            bio: 'bio',
            profilePicUrl: 'https://cdn.example.com/avatar.jpg',
            followersCount: 350,
            followingCount: 300,
            postsCount: 87,
            isPrivate: false,
            isVerified: false,
            // No latestPosts: preflight must not depend on timeline completeness.
        }));
        const getFallbackProfile = vi.fn();
        const preflightStore = store();

        await expect(processPreflight(preflightId, {
            store: preflightStore,
            getProfile,
            getFallbackProfile,
            providerRunStore: providerRunStore(),
            env: {
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET:
                    Buffer.alloc(32, 21).toString('base64url'),
            },
        }))
            .resolves.toBe('ready');
        expect(getProfile).toHaveBeenCalledWith('target.name', {
            invocationDeadlineAtMs: expect.any(Number),
        });
        expect(getFallbackProfile).not.toHaveBeenCalled();
        expect(preflightStore.finalizeReady).toHaveBeenCalledOnce();
    });
});
