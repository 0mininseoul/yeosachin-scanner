import { describe, expect, it, vi } from 'vitest';
import {
    finalizeProfileProviderCanary,
    parseFinalizeProfileProviderCanaryArgs,
    runFinalizeProfileProviderCanaryCli,
    type FinalizeProfileProviderCanaryDependencies,
} from '../../../../scripts/finalize-profile-provider-canary';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';

function args(): string[] {
    return [
        '--source-request-id', SOURCE_REQUEST_ID,
        '--confirm-cleanup-only',
    ];
}

function setup(input: { settled?: boolean; retained?: boolean } = {}) {
    const events: string[] = [];
    const startActor = vi.fn();
    const resources = new Map<string, {
        delete: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
    }>();
    const resource = (runId: string, storage: string) => {
        const key = `${runId}:${storage}`;
        if (!resources.has(key)) {
            resources.set(key, {
                delete: vi.fn(async () => { events.push(`delete:${key}`); }),
                get: vi.fn(async () => input.retained ? { id: 'retained' } : undefined),
            });
        }
        return resources.get(key)!;
    };
    const deps = {
        loadFinalizationContext: vi.fn(async () => ({
            canaryRuns: [1, 2].map(repetition => ({
                repetition: repetition as 1 | 2,
                runId: `SensitivePaidRun${repetition}`,
                actualCostSettled: input.settled ?? true,
                cleanup: {
                    keyValueStore: false,
                    dataset: false,
                    requestQueue: false,
                },
            })),
            sourceRunIds: Array.from({ length: 8 }, (_, index) => `SensitiveSourceRun${index}`),
            sourceCleanup: {
                keyValueStore: false,
                dataset: false,
                requestQueue: false,
            },
        })),
        resumeFinalization: vi.fn(async () => null),
        getApifyClient: vi.fn(() => ({
            run: (runId: string) => ({
                keyValueStore: () => resource(runId, 'keyValueStore'),
                dataset: () => resource(runId, 'dataset'),
                requestQueue: () => resource(runId, 'requestQueue'),
            }),
        })),
        beginTerminalization: vi.fn(async () => { events.push('begin-terminalization'); }),
        markCanaryStorageCleaned: vi.fn(async ({ repetition, storage }) => {
            events.push(`clean:${repetition}:${storage}`);
        }),
        markSourceStorageCleaned: vi.fn(async ({ storage }) => {
            events.push(`source-clean:${storage}`);
        }),
        markExperimentTerminal: vi.fn(async () => { events.push('experiment-terminal'); }),
        writeStdout: vi.fn(),
        startActor,
    } as FinalizeProfileProviderCanaryDependencies & { startActor: typeof startActor };
    return { deps, events };
}

describe('profile provider canary finalizer arguments', () => {
    it('requires an exact valueless cleanup-only confirmation', () => {
        expect(parseFinalizeProfileProviderCanaryArgs(args())).toEqual({
            sourceRequestId: SOURCE_REQUEST_ID,
            confirmCleanupOnly: true,
        });
        expect(() => parseFinalizeProfileProviderCanaryArgs(args().slice(0, -1)))
            .toThrow('required');
        expect(() => parseFinalizeProfileProviderCanaryArgs([
            ...args().slice(0, -1), '--confirm-cleanup-only=true',
        ])).toThrow('exact and valueless');
        expect(() => parseFinalizeProfileProviderCanaryArgs([
            ...args(), '--confirm-paid-api-call',
        ])).toThrow('unknown argument');
    });
});

describe('profile provider canary cleanup-only finalizer', () => {
    it('verifies three storages for every paid and source run before terminalizing', async () => {
        const { deps, events } = setup();

        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs(args()), deps
        )).resolves.toEqual({
            mode: 'finalize_profile_provider_canary',
            canary_run_count: 2,
            source_run_count: 8,
            storage_delete_verification_count: 30,
            source_cleanup_complete: true,
            experiment_status: 'aborted_by_operator',
            actor_start_count: 0,
        });
        expect(events.filter(event => event.startsWith('delete:'))).toHaveLength(30);
        expect(events.filter(event => event.startsWith('clean:'))).toHaveLength(6);
        expect(events.filter(event => event.startsWith('source-clean:'))).toEqual([
            'source-clean:keyValueStore',
            'source-clean:dataset',
            'source-clean:requestQueue',
        ]);
        expect(events.at(-1)).toBe('experiment-terminal');
        expect(events[0]).toBe('begin-terminalization');
        expect(deps.markExperimentTerminal).toHaveBeenCalledWith({
            sourceRequestId: SOURCE_REQUEST_ID,
            status: 'aborted_by_operator',
        });
        expect(deps.startActor).not.toHaveBeenCalled();
    });

    it('fails closed before deletion when any paid run lacks stable actual cost', async () => {
        const { deps, events } = setup({ settled: false });
        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs(args()), deps
        )).rejects.toThrow('ACTUAL_COST_NOT_SETTLED');
        expect(events).toEqual([]);
        expect(deps.markExperimentTerminal).not.toHaveBeenCalled();
        expect(deps.startActor).not.toHaveBeenCalled();
    });

    it('resumes an active terminalizing claim without loading source or overwriting its reason', async () => {
        const { deps, events } = setup();
        vi.mocked(deps.resumeFinalization).mockResolvedValue({
            state: 'terminalizing',
            terminalReason: 'strict_failure',
            context: {
                canaryRuns: [{
                    repetition: 1,
                    runId: 'SensitivePaidRun1',
                    actualCostSettled: true,
                    cleanup: {
                        keyValueStore: true,
                        dataset: false,
                        requestQueue: true,
                    },
                }],
                sourceRunIds: Array.from(
                    { length: 8 },
                    (_, index) => `SensitiveSourceRun${index}`
                ),
                sourceCleanup: {
                    keyValueStore: true,
                    dataset: false,
                    requestQueue: true,
                },
            },
        });

        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs(args()), deps
        )).resolves.toMatchObject({
            storage_delete_verification_count: 9,
            experiment_status: 'strict_failure',
            actor_start_count: 0,
        });
        expect(deps.loadFinalizationContext).not.toHaveBeenCalled();
        expect(deps.beginTerminalization).not.toHaveBeenCalled();
        expect(events.filter(event => event.startsWith('delete:'))).toHaveLength(9);
        expect(deps.markCanaryStorageCleaned).toHaveBeenCalledTimes(1);
        expect(deps.markSourceStorageCleaned).toHaveBeenCalledTimes(1);
        expect(deps.markExperimentTerminal).toHaveBeenCalledWith({
            sourceRequestId: SOURCE_REQUEST_ID,
            status: 'strict_failure',
        });
        expect(deps.startActor).not.toHaveBeenCalled();
    });

    it('returns idempotently after experiment_terminal response loss without source access', async () => {
        const { deps, events } = setup();
        vi.mocked(deps.resumeFinalization).mockResolvedValue({
            state: 'experiment_terminal',
            terminalReason: 'completed',
            canaryRunCount: 1,
        });

        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs(args()), deps
        )).resolves.toEqual({
            mode: 'finalize_profile_provider_canary',
            canary_run_count: 1,
            source_run_count: 8,
            storage_delete_verification_count: 0,
            source_cleanup_complete: true,
            experiment_status: 'completed',
            actor_start_count: 0,
        });
        expect(deps.loadFinalizationContext).not.toHaveBeenCalled();
        expect(deps.beginTerminalization).not.toHaveBeenCalled();
        expect(deps.markExperimentTerminal).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(deps.startActor).not.toHaveBeenCalled();
    });

    it('does not checkpoint or terminalize an unverified storage deletion', async () => {
        const { deps } = setup({ retained: true });
        await expect(finalizeProfileProviderCanary(
            parseFinalizeProfileProviderCanaryArgs(args()), deps
        )).rejects.toThrow('STORAGE_CLEANUP_UNVERIFIED');
        expect(deps.markCanaryStorageCleaned).not.toHaveBeenCalled();
        expect(deps.markSourceStorageCleaned).not.toHaveBeenCalled();
        expect(deps.markExperimentTerminal).not.toHaveBeenCalled();
    });

    it('writes only fixed aggregate cleanup counts to stdout', async () => {
        const { deps } = setup();
        await runFinalizeProfileProviderCanaryCli(args(), deps);
        const stdout = vi.mocked(deps.writeStdout!).mock.calls.flat().join('');
        expect(JSON.parse(stdout)).toMatchObject({
            mode: 'finalize_profile_provider_canary',
            storage_delete_verification_count: 30,
            actor_start_count: 0,
        });
        expect(stdout).not.toMatch(
            /Sensitive|run_?id|dataset_?id|token|hmac|hash|url|email|provider.*message/i
        );
    });
});
