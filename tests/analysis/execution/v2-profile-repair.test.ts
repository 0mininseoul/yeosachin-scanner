import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import { REPLACEMENT_PROFILE_ACTOR } from '@/lib/services/instagram/providers/apify-profile-details';
import type { ApifyClientLike } from '@/lib/services/instagram/providers/apify-relationship';
import type { ProviderRunCheckpoint } from '@/lib/services/instagram/providers/types';
import { canonicalProviderInput } from '../../../lib/services/analysis/v2-provider-identity';
import {
    ANALYSIS_V2_PROFILE_REPAIR_OPERATION,
    profileRepairIdentity,
    profileRepairMaximumCharge,
    runAnalysisV2ProfileRepair,
} from '../../../lib/services/analysis/v2-profile-repair';

function profileItem(username: string, overrides: Record<string, unknown> = {}) {
    return {
        username,
        fullName: `${username} name`,
        biography: '',
        followersCount: 1,
        followsCount: 1,
        postsCount: 0,
        private: false,
        verified: false,
        latestPosts: [],
        ...overrides,
    };
}

// Mirrors the client fake in apify-profile-details.test.ts so the repair adapter is exercised
// through the real runReplacementProfileDetails, not a stub of it.
function mockClient(input: {
    items?: Array<Record<string, unknown>>;
    run?: Record<string, unknown>;
    updatedRun?: Record<string, unknown>;
} = {}) {
    const items = input.items ?? [];
    const start = vi.fn().mockResolvedValue({ id: 'ReplacementRun1234' });
    const waitForFinish = vi.fn().mockResolvedValue({
        status: 'SUCCEEDED',
        buildNumber: '0.0.692',
        generalAccess: 'RESTRICTED',
        defaultDatasetId: 'replacement-dataset',
        usageTotalUsd: 0.01,
        ...input.run,
    });
    const update = vi.fn().mockResolvedValue({ generalAccess: 'RESTRICTED', ...input.updatedRun });
    const updateKeyValueStore = vi.fn().mockResolvedValue({ generalAccess: 'RESTRICTED' });
    const updateDataset = vi.fn().mockResolvedValue({ generalAccess: 'RESTRICTED' });
    const updateRequestQueue = vi.fn().mockResolvedValue({ generalAccess: 'RESTRICTED' });
    const abort = vi.fn().mockResolvedValue(undefined);
    const listItems = vi.fn().mockResolvedValue({
        items,
        total: items.length,
        offset: 0,
        count: items.length,
        limit: items.length + 1,
    });
    const client = {
        actor: vi.fn(() => ({ start })),
        run: vi.fn(() => ({
            waitForFinish,
            update,
            abort,
            keyValueStore: () => ({ update: updateKeyValueStore }),
            dataset: () => ({ update: updateDataset }),
            requestQueue: () => ({ update: updateRequestQueue }),
        })),
        dataset: vi.fn(() => ({ listItems })),
    } as unknown as ApifyClientLike;
    return { client, start, listItems };
}

const env: Record<string, string | undefined> = {};

describe('analysis V2 profile repair adapter', () => {
    it('names the profile-repair provider operation', () => {
        expect(ANALYSIS_V2_PROFILE_REPAIR_OPERATION).toBe('profile-repair');
    });

    describe('maximum charge', () => {
        it('normalises three usernames to exactly 0.0081', () => {
            // The replacement Actor rate is 0.0027; 3 * 0.0027 is 0.0080999999999999995 in IEEE
            // 754, and the toFixed(12) normalisation is what makes this an exact 0.0081. Assert
            // strict equality: weakening to toBeCloseTo would hide that the ledger side and the
            // adapter side must produce the identical normalised number.
            expect(profileRepairMaximumCharge(3)).toBe(0.0081);
        });

        it('admits the full 30-username batch at 0.081', () => {
            expect(profileRepairMaximumCharge(30)).toBe(0.081);
        });

        it('rejects a 34-username batch that would exceed the 0.09 hard cap', () => {
            // 34 * 0.0027 = 0.0918 > 0.09. The adapter's charge fence fires before any Apify call.
            expect(() => profileRepairMaximumCharge(34))
                .toThrow('ANALYSIS_V2_COLLECTION_BUDGET_ERROR');
        });
    });

    describe('durable identity', () => {
        it('length-prefixes the version, actor, pinned build, and username set', () => {
            expect(profileRepairIdentity(['alice', 'bob'])).toBe(canonicalProviderInput([
                'profile-repair-v1',
                REPLACEMENT_PROFILE_ACTOR.actorId,
                REPLACEMENT_PROFILE_ACTOR.build,
                'alice',
                'bob',
            ]));
        });

        it('changes when the pinned build changes', () => {
            const bumped = canonicalProviderInput([
                'profile-repair-v1',
                REPLACEMENT_PROFILE_ACTOR.actorId,
                '9.9.999',
                'alice',
                'bob',
            ]);
            expect(profileRepairIdentity(['alice', 'bob'])).not.toBe(bumped);
        });

        it('is order-sensitive and username-set-sensitive', () => {
            expect(profileRepairIdentity(['alice', 'bob']))
                .not.toBe(profileRepairIdentity(['bob', 'alice']));
            expect(profileRepairIdentity(['alice', 'bob']))
                .not.toBe(profileRepairIdentity(['alice', 'carol']));
            expect(profileRepairIdentity(['alice', 'bob']))
                .not.toBe(profileRepairIdentity(['alice']));
        });
    });

    describe('run', () => {
        it('hands the ledger charge straight to the adapter so the durable identity holds', async () => {
            const { client, start } = mockClient({
                items: [profileItem('alice'), profileItem('bob')],
                // Under the 2-username ceiling of 0.0054; a higher reported cost would trip the
                // post-run hard-cap check, which the disagreement test below covers separately.
                run: { usageTotalUsd: 0.005 },
            });
            // assertDurableIdentity throws SCRAPING_RUN_CHECKPOINT_ERROR unless the checkpoint's
            // maxChargeUsd equals the value the adapter computes. Feeding it the same
            // profileRepairMaximumCharge output proves the two sides share one number.
            const providerRunCheckpoint: ProviderRunCheckpoint = {
                credentialSlot: 'primary',
                maxChargeUsd: profileRepairMaximumCharge(2),
            };

            const results = await runAnalysisV2ProfileRepair({
                usernames: ['alice', 'bob'],
                credentialSlot: 'primary',
                providerRunCheckpoint,
                env,
                client,
            });

            expect(results.map(result => result.outcome.status)).toEqual(['success', 'success']);
            expect(start).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                maxTotalChargeUsd: profileRepairMaximumCharge(2),
            }));
        });

        it('rejects a checkpoint whose charge disagrees with the computed ceiling', async () => {
            const { client, start } = mockClient({
                items: [profileItem('alice')],
            });
            const providerRunCheckpoint: ProviderRunCheckpoint = {
                credentialSlot: 'primary',
                maxChargeUsd: profileRepairMaximumCharge(1) + 0.01,
            };

            await expect(runAnalysisV2ProfileRepair({
                usernames: ['alice'],
                credentialSlot: 'primary',
                providerRunCheckpoint,
                env,
                client,
            })).rejects.toThrow('SCRAPING_RUN_CHECKPOINT_ERROR');
            expect(start).not.toHaveBeenCalled();
        });

        it('refuses to read a run that cannot be pinned to restricted access', async () => {
            // PR #64 regression guard: an inherited non-RESTRICTED run must never be read. The
            // guard lives in runReplacementProfileDetails; this proves the adapter surfaces it
            // rather than swallowing it, and returns no results.
            const { client, listItems } = mockClient({
                items: [profileItem('alice')],
                run: { generalAccess: 'FOLLOW_USER_SETTING' },
                updatedRun: { generalAccess: 'ANYONE_WITH_ID_CAN_READ' },
            });

            await expect(runAnalysisV2ProfileRepair({
                usernames: ['alice'],
                credentialSlot: 'primary',
                providerRunCheckpoint: {},
                env,
                client,
            })).rejects.toThrow('SCRAPING_ACCESS_ERROR');
            expect(listItems).not.toHaveBeenCalled();
        });
    });
});
