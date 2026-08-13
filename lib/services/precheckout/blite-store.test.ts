import { describe, expect, it, vi } from 'vitest';
import {
    createPrecheckoutBliteStore,
    createPrecheckoutBliteTerminalStore,
} from './blite-store';
import type { PrecheckoutBliteV1 } from './blite-contract';

const PREFLIGHT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEADLINE = '2026-08-13T00:01:00.000Z';
const COMPLETED_AT = '2026-08-13T00:00:20.000Z';
const FAILED_AT = '2026-08-13T00:00:20.000Z';
const SOURCE = {
    schemaVersion: 1,
    fullName: null,
    posts: [],
    media: [],
};

function dto(): PrecheckoutBliteV1 {
    return {
        schemaVersion: 1,
        persona: { headline: '헤드라인 텍스트입니다', summary: '요약 텍스트입니다 한글 포함' },
        signals: [
            { claim: '신호 1 텍스트', category: '카테고리', confidence: 0.82, band: 'high' },
            { claim: '신호 2 텍스트', category: '카테고리', confidence: 0.62, band: 'medium' },
            { claim: '신호 3 텍스트', category: '카테고리', confidence: 0.35, band: 'low' },
            { claim: '신호 4 텍스트', category: '카테고리', confidence: 0.71, band: 'high' },
        ],
        candidateRange: { min: 3, max: 9 },
        genderRead: {
            likelyFemale: true,
            confidence: 0.81,
            reasons: ['이유 1 텍스트', '이유 2 텍스트', '이유 3 텍스트'],
        },
        postCount: 1,
        evidenceFields: ['post.caption'],
    };
}

function client(data: unknown, error: null | { code?: string } = null) {
    return { rpc: vi.fn().mockResolvedValue({ data, error }) };
}

describe('precheckoutBliteStore', () => {
    it('parses a claimed lease and sends the exact RPC input', async () => {
        const database = client({ disposition: 'claimed', leaseToken: LEASE });
        const store = createPrecheckoutBliteStore(database);
        await expect(store.claim({ preflightId: PREFLIGHT })).resolves.toEqual({
            disposition: 'claimed', leaseToken: LEASE,
        });
        expect(database.rpc).toHaveBeenCalledWith('claim_precheckout_blite_v1', {
            p_preflight_id: PREFLIGHT,
        });
    });

    it('parses pending and complete dispositions', async () => {
        const pending = createPrecheckoutBliteStore(client({ disposition: 'pending' }));
        await expect(pending.claim({ preflightId: PREFLIGHT })).resolves.toEqual({ disposition: 'pending' });

        const dto = { schemaVersion: 1 };
        const complete = createPrecheckoutBliteStore(client({ disposition: 'complete', dto }));
        await expect(complete.claim({ preflightId: PREFLIGHT })).resolves.toEqual({ disposition: 'complete', dto });
    });

    it('fails closed on malformed persistence responses', async () => {
        const store = createPrecheckoutBliteStore(client({ disposition: 'claimed', leaseToken: 'bad' }));
        await expect(store.claim({ preflightId: PREFLIGHT })).rejects.toThrow('PRECHECKOUT_BLITE_PERSISTENCE_ERROR');
    });

    it('completes and releases with the exact lease fence', async () => {
        const database = client(true);
        const store = createPrecheckoutBliteStore(database);
        const dto = { schemaVersion: 1 };
        await store.complete({ preflightId: PREFLIGHT, leaseToken: LEASE, dto });
        expect(database.rpc).toHaveBeenLastCalledWith('complete_precheckout_blite_v1', {
            p_preflight_id: PREFLIGHT,
            p_lease_token: LEASE,
            p_dto: dto,
        });
        await store.release({ preflightId: PREFLIGHT, leaseToken: LEASE });
        expect(database.rpc).toHaveBeenLastCalledWith('release_precheckout_blite_v1', {
            p_preflight_id: PREFLIGHT,
            p_lease_token: LEASE,
        });
    });
});

describe('precheckout B-lite v2 terminal store', () => {
    it('parses the exact source-bearing v2 claim and sends only the v2 RPC input', async () => {
        const database = client({
            disposition: 'claimed', leaseToken: LEASE, source: SOURCE, deadlineAt: DEADLINE,
        });
        const store = createPrecheckoutBliteTerminalStore(database);

        await expect(store.claim({ preflightId: PREFLIGHT })).resolves.toEqual({
            disposition: 'claimed', leaseToken: LEASE, source: SOURCE, deadlineAt: DEADLINE,
        });
        expect(database.rpc).toHaveBeenCalledWith('claim_precheckout_blite_v2', {
            p_preflight_id: PREFLIGHT,
        });
    });

    it('uses lease-fenced v2 complete/fail RPCs and validates every terminal response', async () => {
        const database = {
            rpc: vi.fn()
                .mockResolvedValueOnce({ data: true, error: null })
                .mockResolvedValueOnce({ data: true, error: null }),
        };
        const store = createPrecheckoutBliteTerminalStore(database);
        const value = dto();

        await expect(store.complete({ preflightId: PREFLIGHT, leaseToken: LEASE, dto: value }))
            .resolves.toBe(true);
        expect(database.rpc).toHaveBeenLastCalledWith('complete_precheckout_blite_v2', {
            p_preflight_id: PREFLIGHT,
            p_lease_token: LEASE,
            p_dto: value,
        });
        await expect(store.fail({ preflightId: PREFLIGHT, leaseToken: LEASE, reason: 'model_invalid' }))
            .resolves.toBe(true);
        expect(database.rpc).toHaveBeenLastCalledWith('fail_precheckout_blite_v2', {
            p_preflight_id: PREFLIGHT,
            p_lease_token: LEASE,
            p_reason: 'model_invalid',
        });
    });

    it('reads bounded pending/complete/failed statuses and fails closed on malformed v2 output', async () => {
        const pending = createPrecheckoutBliteTerminalStore(client({
            state: 'pending', submittedAt: COMPLETED_AT, deadlineAt: DEADLINE,
        }));
        await expect(pending.readStatus({ preflightId: PREFLIGHT })).resolves.toEqual({
            state: 'pending', submittedAt: COMPLETED_AT, deadlineAt: DEADLINE,
        });
        const complete = createPrecheckoutBliteTerminalStore(client({
            state: 'complete', submittedAt: COMPLETED_AT, deadlineAt: DEADLINE,
            completedAt: COMPLETED_AT, dto: dto(),
        }));
        await expect(complete.readStatus({ preflightId: PREFLIGHT })).resolves.toMatchObject({
            state: 'complete', completedAt: COMPLETED_AT,
        });
        const failed = createPrecheckoutBliteTerminalStore(client({
            state: 'failed', submittedAt: COMPLETED_AT, deadlineAt: DEADLINE, failedAt: FAILED_AT,
        }));
        await expect(failed.readStatus({ preflightId: PREFLIGHT })).resolves.toEqual({
            state: 'failed', submittedAt: COMPLETED_AT, deadlineAt: DEADLINE, failedAt: FAILED_AT,
        });
        const malformed = createPrecheckoutBliteTerminalStore(client({
            disposition: 'claimed', leaseToken: LEASE, source: { schemaVersion: 1 }, deadlineAt: DEADLINE,
        }));
        await expect(malformed.claim({ preflightId: PREFLIGHT }))
            .rejects.toThrow('PRECHECKOUT_BLITE_PERSISTENCE_ERROR');
    });
});
