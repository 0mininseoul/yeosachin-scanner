import { describe, expect, it, vi } from 'vitest';
import type { ProviderCallContext } from '../types';
import type { SelfHostedAuthWorkerClient } from './client';
import {
    makeSelfHostedAuthInteractionAdapter,
    makeSelfHostedAuthProvider,
} from './index';

const metadata = {
    schemaVersion: 1 as const,
    runId: '0123456789abcdef0123456789abcdef',
    accountSlot: 'primary' as const,
};

function context() {
    const recordUsage = vi.fn();
    const onSelfHostedAuthRunFinished = vi.fn();
    const value: ProviderCallContext = {
        recordUsage,
        onSelfHostedAuthRunFinished,
        selfHostedAuthIdentity: {
            operationKey: `relationship-followers:${'a'.repeat(64)}`,
            inputHash: 'b'.repeat(64),
        },
    };
    return {
        value,
        recordUsage,
        onSelfHostedAuthRunFinished,
    };
}

describe('authenticated self-hosted relationship provider', () => {
    it('maps the worker response, emits zero-cost usage, and hands off the run receipt', async () => {
        const items = [{
            username: 'one.user',
            isPrivate: false,
            isVerified: false,
        }];
        const client = {
            getRelationship: vi.fn(async () => ({ ...metadata, items })),
        } as unknown as SelfHostedAuthWorkerClient;
        const provider = makeSelfHostedAuthProvider({ client });
        const observed = context();
        const controller = new AbortController();
        observed.value.startCancellationSignal = controller.signal;

        await expect(provider.getFollowers?.('target.user', 1200, observed.value))
            .resolves.toEqual(items);
        expect(client.getRelationship).toHaveBeenCalledWith(
            'followers',
            'target.user',
            1200,
            expect.objectContaining({
                operationKey: `relationship-followers:${'a'.repeat(64)}`,
                inputHash: 'b'.repeat(64),
                signal: controller.signal,
            })
        );
        expect(observed.recordUsage).toHaveBeenCalledWith({
            request_count: 1,
            result_count: 1,
            raw_result_count: 1,
            unique_result_count: 1,
            estimated_cost_usd: 0,
        });
        expect(observed.onSelfHostedAuthRunFinished).toHaveBeenCalledWith({
            provider: 'selfhosted_auth',
            runId: metadata.runId,
            accountSlot: 'primary',
        });
        expect(provider.name).toBe('selfhosted_auth');
        expect(provider.paid).toBe(false);
        expect(provider.getProfile).toBeUndefined();
    });
});

describe('authenticated self-hosted identity boundary', () => {
    it('fails closed when a generic provider call has no durable operation identity', async () => {
        const client = {
            getRelationship: vi.fn(),
        } as unknown as SelfHostedAuthWorkerClient;
        const provider = makeSelfHostedAuthProvider({ client });

        await expect(provider.getFollowers?.('target.user', 1, {
            recordUsage: () => undefined,
        })).rejects.toThrow('ANALYSIS_V2_SELFHOSTED_AUTH_IDENTITY_MISSING');
        expect(client.getRelationship).not.toHaveBeenCalled();
    });
});

describe('authenticated self-hosted interaction adapter', () => {
    it('shares the same receipt and usage contract for likers and comments', async () => {
        const liker = {
            postUrl: 'https://www.instagram.com/p/Abc123/',
            id: '123',
            username: 'liker.user',
            profilePicUrl: 'https://cdn.example/liker.jpg',
            isPrivate: false,
            isVerified: false,
            totalLikes: 1,
        };
        const comment = {
            postUrl: 'https://www.instagram.com/p/Abc123/',
            id: '456',
            text: 'hello',
            ownerUsername: 'comment.user',
            timestamp: '2026-08-03T00:00:00.000Z',
        };
        const client = {
            getPostLikers: vi.fn(async () => ({ ...metadata, items: [liker] })),
            getPostComments: vi.fn(async () => ({ ...metadata, items: [comment] })),
        } as unknown as SelfHostedAuthWorkerClient;
        const adapter = makeSelfHostedAuthInteractionAdapter({ client });

        const likerContext = context();
        likerContext.value.selfHostedAuthIdentity = {
            operationKey: `target-likers:${'c'.repeat(64)}`,
            inputHash: 'd'.repeat(64),
        };
        await expect(adapter.getPostLikers(
            [liker.postUrl],
            150,
            likerContext.value
        )).resolves.toEqual([liker]);
        expect(likerContext.onSelfHostedAuthRunFinished).toHaveBeenCalledOnce();

        const commentContext = context();
        commentContext.value.selfHostedAuthIdentity = {
            operationKey: `target-comments:${'e'.repeat(64)}`,
            inputHash: 'f'.repeat(64),
        };
        await expect(adapter.getPostComments(
            [comment.postUrl],
            15,
            commentContext.value
        )).resolves.toEqual([comment]);
        expect(commentContext.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
            estimated_cost_usd: 0,
            result_count: 1,
        }));
        expect(commentContext.onSelfHostedAuthRunFinished).toHaveBeenCalledWith({
            provider: 'selfhosted_auth',
            runId: metadata.runId,
            accountSlot: 'primary',
        });
    });
});
