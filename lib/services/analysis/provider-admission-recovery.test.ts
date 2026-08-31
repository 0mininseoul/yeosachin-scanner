import { describe, expect, it, vi } from 'vitest';
import {
    recoverExpiredAnalysisProviderAdmissions,
} from './provider-admission-recovery';
import type { AnalysisProviderAdmissionStore } from './provider-admission-store';

const candidates = [
    {
        admissionId: 'a'.repeat(64),
        fence: 1,
        expiresAt: '2026-08-31T00:00:00.000Z',
    },
    {
        admissionId: 'b'.repeat(64),
        fence: 3,
        expiresAt: '2026-08-31T00:00:01.000Z',
    },
] as const;

function store(): AnalysisProviderAdmissionStore {
    return {
        acquire: vi.fn(),
        renew: vi.fn(),
        release: vi.fn(),
        listExpired: vi.fn(async () => ({ candidates, hasMore: false })),
        recoverExpired: vi.fn(async () => true),
        resolve: vi.fn(async () => true),
    } as unknown as AnalysisProviderAdmissionStore;
}

function candidate(index: number) {
    return {
        admissionId: index.toString(16).padStart(64, '0'),
        fence: 1,
        expiresAt: `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`,
    };
}

describe('provider admission expiry recovery', () => {
    it('recovers a bounded batch with fresh recovery fences', async () => {
        const admissionStore = store();
        const summary = await recoverExpiredAnalysisProviderAdmissions({
            store: admissionStore,
            limit: 2,
            concurrency: 2,
            randomUuid: vi.fn()
                .mockReturnValueOnce('c'.repeat(8) + '-1111-4111-8111-111111111111')
                .mockReturnValueOnce('d'.repeat(8) + '-2222-4222-8222-222222222222')
                .mockReturnValueOnce('e'.repeat(8) + '-3333-4333-8333-333333333333')
                .mockReturnValueOnce('f'.repeat(8) + '-4444-4444-8444-444444444444'),
        });

        expect(summary).toEqual({
            scanned: 2,
            recovered: 2,
            resolved: 2,
            skipped: 0,
            failed: 0,
            hasMore: false,
        });
        expect(admissionStore.listExpired).toHaveBeenCalledWith({ limit: 2 });
        expect(admissionStore.recoverExpired).toHaveBeenNthCalledWith(1, {
            admissionId: candidates[0].admissionId,
            recoveryToken: 'c'.repeat(8) + '-1111-4111-8111-111111111111',
        });
        expect(admissionStore.resolve).toHaveBeenNthCalledWith(1, {
            admissionId: candidates[0].admissionId,
            resolutionToken: expect.stringMatching(/^[a-f0-9-]{36}$/),
        });
    });

    it('uses the store continuation bit exactly, including a page with fewer than its limit', async () => {
        const admissionStore = store();
        (admissionStore.listExpired as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            candidates: [candidates[0]],
            hasMore: false,
        });

        await expect(recoverExpiredAnalysisProviderAdmissions({
            store: admissionStore,
            limit: 16,
            concurrency: 1,
            randomUuid: () => 'e'.repeat(8) + '-3333-4333-8333-333333333333',
        })).resolves.toMatchObject({
            scanned: 1,
            recovered: 1,
            resolved: 1,
            hasMore: false,
        });
    });

    it('passes a 64-row page so unresolved old rows cannot hide a later recoverable row', async () => {
        const admissionStore = store();
        const unresolved = Array.from({ length: 17 }, (_, index) => ({
            admissionId: String(index).padStart(64, '0'),
            fence: 1,
            expiresAt: `2026-08-31T00:00:${String(index).padStart(2, '0')}.000Z`,
        }));
        const later = {
            admissionId: 'f'.repeat(64),
            fence: 2,
            expiresAt: '2026-08-31T00:01:00.000Z',
        };
        (admissionStore.listExpired as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            candidates: [...unresolved, later],
            hasMore: false,
        });

        const summary = await recoverExpiredAnalysisProviderAdmissions({
            store: admissionStore,
            limit: 64,
            concurrency: 8,
            randomUuid: () => 'e'.repeat(8) + '-3333-4333-8333-333333333333',
        });

        expect(summary).toMatchObject({
            scanned: 18,
            recovered: 18,
            resolved: 18,
            hasMore: false,
        });
        expect(admissionStore.recoverExpired).toHaveBeenCalledWith(expect.objectContaining({
            admissionId: later.admissionId,
        }));
    });

    it('counts concurrent races and provider-store failures without unbounded retries', async () => {
        const admissionStore = store();
        (admissionStore.recoverExpired as ReturnType<typeof vi.fn>)
            .mockResolvedValueOnce(false)
            .mockRejectedValueOnce(new Error('temporary'));

        await expect(recoverExpiredAnalysisProviderAdmissions({
            store: admissionStore,
            limit: 2,
            concurrency: 1,
            randomUuid: () => 'e'.repeat(8) + '-3333-4333-8333-333333333333',
        })).resolves.toEqual({
            scanned: 2,
            recovered: 0,
            resolved: 0,
            skipped: 1,
            failed: 1,
            hasMore: false,
        });
        expect(admissionStore.recoverExpired).toHaveBeenCalledTimes(2);
    });

    it('follows a genuine second page after unresolved head rows', async () => {
        const admissionStore = store();
        const head = Array.from({ length: 16 }, (_, index) => candidate(index));
        const tail = candidate(16);
        const firstCursor = {
            expiresAt: head[head.length - 1].expiresAt,
            fence: head[head.length - 1].fence,
            admissionId: head[head.length - 1].admissionId,
        } as const;
        const listExpired = admissionStore.listExpired as ReturnType<typeof vi.fn>;
        listExpired
            .mockReset()
            .mockResolvedValueOnce({
                candidates: head,
                hasMore: true,
                nextCursor: firstCursor,
            })
            .mockResolvedValueOnce({
                candidates: [tail],
                hasMore: false,
            });
        const recoverExpired = admissionStore.recoverExpired as ReturnType<typeof vi.fn>;
        // The first sixteen are still owned/running and therefore remain
        // unresolved; the later row is recoverable in the same bounded pass.
        recoverExpired.mockImplementation(async ({ admissionId }: { admissionId: string }) =>
            admissionId === tail.admissionId
        );

        const summary = await recoverExpiredAnalysisProviderAdmissions({
            store: admissionStore,
            limit: 16,
            concurrency: 4,
            randomUuid: () => 'e'.repeat(8) + '-3333-4333-8333-333333333333',
        });

        expect(summary).toEqual({
            scanned: 17,
            recovered: 1,
            resolved: 1,
            skipped: 16,
            failed: 0,
            hasMore: false,
        });
        expect(listExpired).toHaveBeenNthCalledWith(1, { limit: 16 });
        expect(listExpired).toHaveBeenNthCalledWith(2, {
            limit: 16,
            cursor: firstCursor,
        });
        expect(recoverExpired).toHaveBeenCalledTimes(17);
    });

    it('fails closed instead of reporting a false drain for an unfollowable page', async () => {
        const admissionStore = store();
        (admissionStore.listExpired as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            candidates: [],
            hasMore: true,
        });

        await expect(recoverExpiredAnalysisProviderAdmissions({
            store: admissionStore,
            limit: 16,
            concurrency: 1,
        })).rejects.toThrow('missing continuation cursor');
    });
});
