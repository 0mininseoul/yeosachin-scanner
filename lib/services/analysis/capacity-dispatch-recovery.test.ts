import { describe, expect, it, vi } from 'vitest';
import {
    recoverAnalysisCapacityDispatches,
} from './capacity-dispatch-recovery';
import { PreflightTaskEnqueueError } from './preflight-tasks';
import { AnalysisV2TaskEnqueueError } from './v2-tasks';

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-42d3-a456-426614174001';
const TOKEN = '123e4567-e89b-42d3-a456-426614174002';

const preflightConfig = {
    workloadRole: 'preflight' as const,
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-preflight',
    targetUrl: 'https://preflight.example.com/api/analysis/preflight/worker',
    oidcAudience: 'https://preflight.example.com',
    serviceAccountEmail: 'preflight@example-project.iam.gserviceaccount.com',
    callerAuth: {} as never,
};
const paidConfig = {
    workloadRole: 'paid' as const,
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-v2-pipeline',
    targetUrl: 'https://paid.example.com/api/analysis/v2/worker',
    oidcAudience: 'https://paid.example.com',
    serviceAccountEmail: 'paid@example-project.iam.gserviceaccount.com',
    callerAuth: {} as never,
};

function client(rowsByRpc: Record<string, Record<string, unknown>[]>) {
    return {
        rpc: vi.fn(async (name: string) => {
            if (name.startsWith('list_')) return {
                data: rowsByRpc[name] ?? [],
                error: null,
            };
            return { data: true, error: null };
        }),
    } as never;
}

describe('capacity dispatch ambiguity recovery', () => {
    it('keeps an ordinary reservation on unknown create and converges by exact lookup + mark replay', async () => {
        const lookup = vi.fn()
            .mockResolvedValueOnce('not_found')
            .mockResolvedValueOnce('exists')
            .mockResolvedValueOnce('exists');
        const enqueue = vi.fn().mockRejectedValue(new Error('response lost'));
        const mark = vi.fn()
            .mockRejectedValueOnce(new Error('mark response lost'))
            .mockResolvedValueOnce(true);

        const result = await recoverAnalysisCapacityDispatches({
            client: client({ list_analysis_preflight_dispatch_recovery_v2: [{
                preflight_id: PREFLIGHT_ID,
                dispatch_generation: 4,
                dispatch_token: TOKEN,
            }]}),
            workloadRole: 'preflight',
            preflightConfig,
            paidConfig: null,
            lookupPreflight: lookup,
            enqueuePreflight: enqueue,
            markPreflight: mark,
        });

        expect(result).toMatchObject({
            scanned: 1,
            recovered: 1,
            failed: 0,
        });
        expect(enqueue).toHaveBeenCalledWith(PREFLIGHT_ID, 4, expect.objectContaining({
            reservationToken: TOKEN,
        }));
        expect(mark).toHaveBeenCalledTimes(2);
        // The old release RPC is intentionally absent: generation-bearing reservations never
        // return to an unreserved/generation-zero shape.
    });

    it('does not release an ordinary reservation after a definitive create refusal', async () => {
        const enqueue = vi.fn().mockRejectedValue(new PreflightTaskEnqueueError('terminal'));
        const mark = vi.fn();
        const result = await recoverAnalysisCapacityDispatches({
            client: client({ list_analysis_preflight_dispatch_recovery_v2: [{
                preflight_id: PREFLIGHT_ID,
                dispatch_generation: 3,
                dispatch_token: TOKEN,
            }]}),
            workloadRole: 'preflight',
            preflightConfig,
            paidConfig: null,
            lookupPreflight: vi.fn().mockResolvedValue('not_found'),
            enqueuePreflight: enqueue,
            markPreflight: mark,
        });

        expect(result).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
        expect(mark).not.toHaveBeenCalled();
    });

    it('retains a B-lite enqueuing fence after terminal create refusal for the next recovery pass', async () => {
        const enqueue = vi.fn()
            .mockRejectedValueOnce(new PreflightTaskEnqueueError('terminal'))
            .mockResolvedValueOnce('enqueued');
        const lookup = vi.fn().mockResolvedValue('not_found');
        const mark = vi.fn().mockResolvedValue(true);
        const rpc = client({
            list_precheckout_blite_dispatch_recovery_v2: [{
                preflight_id: PREFLIGHT_ID,
                dispatch_generation: 8,
                dispatch_token: TOKEN,
            }],
        });
        const first = await recoverAnalysisCapacityDispatches({
            client: rpc,
            workloadRole: 'preflight',
            preflightConfig,
            paidConfig: null,
            lookupBlite: lookup,
            enqueueBlite: enqueue,
            markBlite: mark,
        });
        expect(first).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
        expect(mark).not.toHaveBeenCalled();

        const second = await recoverAnalysisCapacityDispatches({
            client: rpc,
            workloadRole: 'preflight',
            preflightConfig,
            paidConfig: null,
            lookupBlite: lookup,
            enqueueBlite: enqueue,
            markBlite: mark,
        });
        expect(second).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
        expect(enqueue).toHaveBeenCalledTimes(2);
        expect(enqueue).toHaveBeenNthCalledWith(2, PREFLIGHT_ID, expect.objectContaining({
            dispatchGeneration: 8,
            dispatchToken: TOKEN,
        }));
    });

    it('retains a fresh paid admission fence after terminal create refusal for the next recovery pass', async () => {
        const enqueue = vi.fn()
            .mockRejectedValueOnce(new AnalysisV2TaskEnqueueError('terminal'))
            .mockResolvedValueOnce('enqueued');
        const lookup = vi.fn().mockResolvedValue('not_found');
        const mark = vi.fn().mockResolvedValue('marked' as const);
        const rpc = client({
            list_analysis_v2_preflight_admission_dispatch_recovery_v2: [{
                preflight_id: PREFLIGHT_ID,
                user_id: USER_ID,
                admission_generation: 9,
                dispatch_generation: 4,
                dispatch_token: TOKEN,
            }],
        });
        const first = await recoverAnalysisCapacityDispatches({
            client: rpc,
            workloadRole: 'paid',
            preflightConfig: null,
            paidConfig,
            lookupFresh: lookup,
            enqueueFresh: enqueue,
            markFresh: mark,
        });
        expect(first).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
        expect(mark).not.toHaveBeenCalled();

        const second = await recoverAnalysisCapacityDispatches({
            client: rpc,
            workloadRole: 'paid',
            preflightConfig: null,
            paidConfig,
            lookupFresh: lookup,
            enqueueFresh: enqueue,
            markFresh: mark,
        });
        expect(second).toMatchObject({ scanned: 1, recovered: 1, failed: 0 });
        expect(enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({
            dispatchGeneration: 4,
            dispatchToken: TOKEN,
            workloadRole: 'paid',
        }), { config: paidConfig });
    });

    it('recovers B-lite and fresh reservations without creating a second deterministic task', async () => {
        const lookupBlite = vi.fn().mockResolvedValue('exists');
        const lookupFresh = vi.fn().mockResolvedValue('exists');
        const markBlite = vi.fn().mockResolvedValue(true);
        const markFresh = vi.fn().mockResolvedValue('already_marked' as const);
        const enqueueBlite = vi.fn();
        const enqueueFresh = vi.fn();
        const preflightResult = await recoverAnalysisCapacityDispatches({
            client: client({
                list_precheckout_blite_dispatch_recovery_v2: [{
                    preflight_id: PREFLIGHT_ID,
                    dispatch_generation: 2,
                    dispatch_token: TOKEN,
                }],
            }),
            preflightConfig,
            paidConfig: null,
            workloadRole: 'preflight',
            lookupPreflight: vi.fn().mockResolvedValue('not_found'),
            lookupBlite,
            enqueuePreflight: vi.fn().mockResolvedValue('enqueued'),
            enqueueBlite,
            markPreflight: vi.fn().mockResolvedValue(true),
            markBlite,
        });
        const paidResult = await recoverAnalysisCapacityDispatches({
            client: client({
                list_analysis_v2_preflight_admission_dispatch_recovery_v2: [{
                    preflight_id: PREFLIGHT_ID,
                    user_id: USER_ID,
                    admission_generation: 3,
                    dispatch_generation: 5,
                    dispatch_token: TOKEN,
                }],
            }),
            paidConfig,
            workloadRole: 'paid',
            lookupFresh,
            enqueueFresh,
            markFresh,
        });

        // This assertion proves all three exact mark choreographies can be replayed without
        // duplicate enqueues.
        expect(preflightResult.scanned + paidResult.scanned).toBe(2);
        expect(markBlite).toHaveBeenCalledWith({
            preflightId: PREFLIGHT_ID,
            dispatchGeneration: 2,
            dispatchToken: TOKEN,
        });
        expect(markFresh).toHaveBeenCalledWith(expect.objectContaining({
            userId: USER_ID,
            dispatchGeneration: 5,
        }));
        expect(enqueueBlite).not.toHaveBeenCalled();
        expect(enqueueFresh).not.toHaveBeenCalled();
    });

    it('never discovers the other role queue during a role-scoped maintenance pass', async () => {
        const rpc = vi.fn(async () => ({ data: [], error: null }));
        await recoverAnalysisCapacityDispatches({
            client: { rpc } as never,
            workloadRole: 'preflight',
            preflightConfig,
            paidConfig,
        });
        expect(rpc).toHaveBeenCalledWith(
            'list_analysis_preflight_dispatch_recovery_v2',
            { p_limit: 64 },
        );
        expect(rpc).toHaveBeenCalledWith(
            'list_precheckout_blite_dispatch_recovery_v2',
            { p_limit: 64 },
        );
        expect(rpc).not.toHaveBeenCalledWith(
            'list_analysis_v2_preflight_admission_dispatch_recovery_v2',
            expect.anything(),
        );
    });
});
