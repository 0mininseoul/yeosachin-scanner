import { describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
    genderTriageMicrobatch: vi.fn(),
}));

vi.mock('@/lib/services/ai/v2-staged-analysis', async importOriginal => {
    const actual = await importOriginal<
        typeof import('@/lib/services/ai/v2-staged-analysis')
    >();
    return {
        ...actual,
        genderTriageMicrobatch: provider.genderTriageMicrobatch,
    };
});

import { createReplayStagedAiAdapter } from './replay-staged-ai-adapter';

describe('replay v2.9 account-profile fidelity', () => {
    it('lets exact profile evidence change opaque identity and paired batch composition', async () => {
        provider.genderTriageMicrobatch.mockImplementation(async accounts => (
            accounts.map((account: { accountId: string }) => ({
                accountId: account.accountId,
                source: 'checkpoint',
                result: {
                    assessment: {
                        inferredGender: 'unknown',
                        confidence: 'low',
                        ownerConsistency: 'not_visible',
                        evidenceSelectionIds: [],
                    },
                    routingDecision: 'route_to_feature_analysis',
                    routingReason: 'conserve_female_recall',
                    analyzedSelectionIds: ['profile:same'],
                    v29AccountContext: 'uncertain',
                },
            }))
        ));
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.9');
        const common = {
            media: [{
                selectionId: 'profile:same',
                kind: 'profile' as const,
                jpegBase64: '/9j/2Q==',
            }],
        };

        await adapter.triageMany?.([
            {
                ordinal: 1,
                ...common,
                accountProfile: {
                    fullName: 'First',
                    hasProfileImage: true,
                    bio: 'personal notes',
                },
            },
            {
                ordinal: 2,
                ...common,
                accountProfile: {
                    fullName: 'Second',
                    hasProfileImage: false,
                    bio: 'team updates',
                },
            },
        ]);

        expect(provider.genderTriageMicrobatch).toHaveBeenCalledOnce();
        const accounts = provider.genderTriageMicrobatch.mock.calls[0]![0] as
            Array<{ accountId: string; input: { accountProfile: unknown } }>;
        expect(accounts).toHaveLength(2);
        expect(new Set(accounts.map(account => account.accountId)).size).toBe(2);
        expect(accounts.map(account => account.accountId))
            .toEqual([...accounts.map(account => account.accountId)].sort());
        expect(accounts.map(account => account.input.accountProfile))
            .toEqual(expect.arrayContaining([
                {
                    fullName: 'First',
                    hasProfileImage: true,
                    bio: 'personal notes',
                },
                {
                    fullName: 'Second',
                    hasProfileImage: false,
                    bio: 'team updates',
                },
            ]));
    });
});
