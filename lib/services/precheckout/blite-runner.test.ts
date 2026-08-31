import { describe, expect, it, vi } from 'vitest';
import { runPrecheckoutBlite } from './blite-runner';
import { AnalysisV2AiCapacityPendingError } from '@/lib/services/analysis/v2-gemini-lease-store';

const PREFLIGHT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LEASE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const submittedAt = '2026-08-13T00:00:00.000Z';
const source = { schemaVersion: 1 as const, fullName: null, posts: [], media: [] };
const dto = {
    schemaVersion: 1 as const,
    persona: { headline: '요약', summary: '요약 설명' },
    signals: [
        { claim: '신호 하나', category: '성향', confidence: 0.8, band: 'high' as const },
        { claim: '신호 둘', category: '성향', confidence: 0.6, band: 'medium' as const },
        { claim: '신호 셋', category: '성향', confidence: 0.4, band: 'low' as const },
        { claim: '신호 넷', category: '성향', confidence: 0.7, band: 'high' as const },
    ],
    candidateRange: { min: 3, max: 9 },
    genderRead: { likelyFemale: false, confidence: 0.5, reasons: ['근거 하나', '근거 둘', '근거 셋'] },
    postCount: 0,
    evidenceFields: [],
};

const GEMINI_LEASE = {
    slot: 3,
    claimToken: '33333333-3333-4333-8333-333333333333',
    fence: 7,
    expiresAt: '2026-08-13T00:02:00.000Z',
} as const;

function sharedGeminiLeaseStore() {
    return {
        acquire: vi.fn(async () => GEMINI_LEASE),
        renew: vi.fn(async (lease: typeof GEMINI_LEASE) => lease),
        release: vi.fn(async () => undefined),
    };
}

describe('runPrecheckoutBlite', () => {
    function observability() {
        return {
            completed: vi.fn(),
            profileCollectionFailed: vi.fn(),
            inferenceFailed: vi.fn(),
            inferenceAttempt: vi.fn(),
            demoCompleted: vi.fn(),
            demoFailed: vi.fn(),
        };
    }

    it('claims durable source, infers once, and completes without any collection dependency', async () => {
        const terminal = {
            claim: vi.fn(async () => ({
                disposition: 'claimed' as const,
                leaseToken: LEASE,
                source,
                submittedAt,
                deadlineAt: '2026-08-13T00:01:00.000Z',
                followersCount: 1_200,
                followingCount: 900,
            })),
            complete: vi.fn(async () => true),
            fail: vi.fn(async () => true),
        };
        const infer = vi.fn(async () => dto);
        const telemetry = observability();

        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: terminal,
            geminiLeaseStore: sharedGeminiLeaseStore() as never,
            infer,
            observability: telemetry,
            now: () => Date.parse(submittedAt) + 1_000,
        })).resolves.toBe('complete');
        expect(infer).toHaveBeenCalledWith(source, expect.objectContaining({
            submittedAtMs: Date.parse(submittedAt),
            deadlineAtMs: Date.parse(submittedAt) + 86_000,
            candidateRange: expect.any(Object),
        }));
        expect(terminal.complete).toHaveBeenCalledWith({ preflightId: PREFLIGHT, leaseToken: LEASE, dto });
        expect(terminal.fail).not.toHaveBeenCalled();
    });

    it('emits one completion event only for the owner that durably checkpoints success', async () => {
        const terminal = {
            claim: vi.fn()
                .mockResolvedValueOnce({
                    disposition: 'claimed' as const,
                    leaseToken: LEASE,
                    source,
                    submittedAt,
                    deadlineAt: '2026-08-13T00:01:00.000Z',
                    followersCount: 1_200,
                    followingCount: 900,
                })
                .mockResolvedValueOnce({ disposition: 'complete' as const, dto }),
            complete: vi.fn(async () => true),
            fail: vi.fn(async () => true),
        };
        const infer = vi.fn(async () => dto);
        const telemetry = observability();

        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: terminal,
            geminiLeaseStore: sharedGeminiLeaseStore() as never,
            infer,
            observability: telemetry,
            now: () => Date.parse(submittedAt) + 1_000,
        })).resolves.toBe('complete');
        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: terminal,
            infer,
            observability: telemetry,
            now: () => Date.parse(submittedAt) + 2_000,
        })).resolves.toBe('complete');

        expect(telemetry.completed).toHaveBeenCalledTimes(1);
        expect(terminal.complete).toHaveBeenCalledTimes(1);
        const inferenceOptions = (infer.mock.calls[0] as unknown[])[1] as {
            onAttemptTelemetry?: (value: unknown) => void;
        };
        expect(inferenceOptions.onAttemptTelemetry).toEqual(expect.any(Function));
        inferenceOptions.onAttemptTelemetry?.({ disposition: 'success' });
        expect(telemetry.inferenceAttempt).toHaveBeenCalledWith({ disposition: 'success' });
        expect(infer).toHaveBeenCalledTimes(1);
    });

    it('emits an inference failure only after a null result is durably failed', async () => {
        const terminal = {
            claim: vi.fn(async () => ({
                disposition: 'claimed' as const,
                leaseToken: LEASE,
                source,
                submittedAt,
                deadlineAt: '2026-08-13T00:01:00.000Z',
                followersCount: 1_200,
                followingCount: 900,
            })),
            complete: vi.fn(async () => true),
            fail: vi.fn(async () => true),
        };
        const telemetry = observability();

        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: terminal,
            geminiLeaseStore: sharedGeminiLeaseStore() as never,
            infer: vi.fn(async () => null),
            observability: telemetry,
            now: () => Date.parse(submittedAt) + 1_000,
        })).resolves.toBe('failed');

        expect(terminal.fail).toHaveBeenCalledWith({
            preflightId: PREFLIGHT,
            leaseToken: LEASE,
            reason: 'inference_response_invalid',
        });
        expect(telemetry.inferenceFailed).toHaveBeenCalledWith('invalid');
    });

    it('terminalizes an expired original T+86 deadline without starting inference', async () => {
        const terminal = {
            claim: vi.fn(async () => ({
                disposition: 'claimed' as const,
                leaseToken: LEASE,
                source,
                submittedAt,
                deadlineAt: '2026-08-13T00:01:00.000Z',
                followersCount: 1_200,
                followingCount: 900,
            })),
            complete: vi.fn(async () => true),
            fail: vi.fn(async () => true),
        };
        const infer = vi.fn();
        const telemetry = observability();

        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: terminal,
            infer,
            observability: telemetry,
            now: () => Date.parse(submittedAt) + 86_000,
        })).resolves.toBe('failed');
        expect(infer).not.toHaveBeenCalled();
        expect(terminal.fail).toHaveBeenCalledWith({
            preflightId: PREFLIGHT,
            leaseToken: LEASE,
            reason: 'inference_timeout',
        });
        expect(telemetry.inferenceFailed).toHaveBeenCalledWith('timeout');
    });

    it('returns retryable capacity_pending after each durable rearm and eventually completes within T+86', async () => {
        const claims = [1, 2, 3].map((index) => ({
            disposition: 'claimed' as const,
            leaseToken: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}`,
            source,
            submittedAt,
            deadlineAt: '2026-08-13T00:01:00.000Z',
            followersCount: 1_200,
            followingCount: 900,
        }));
        const events: string[] = [];
        const terminal = {
            claim: vi.fn(async () => claims.shift() ?? { disposition: 'pending' as const }),
            complete: vi.fn(async () => {
                events.push('complete');
                return true;
            }),
            fail: vi.fn(async () => true),
            deferCapacity: vi.fn(async ({ leaseToken }: { leaseToken: string }) => {
                events.push(`defer:${leaseToken.slice(-1)}`);
                return true;
            }),
        };
        const geminiLeaseStore = {
            acquire: vi.fn()
                .mockRejectedValueOnce(new AnalysisV2AiCapacityPendingError())
                .mockRejectedValueOnce(new AnalysisV2AiCapacityPendingError())
                .mockResolvedValueOnce(GEMINI_LEASE),
            release: vi.fn(async () => {
                events.push('release');
            }),
        };
        const infer = vi.fn(async () => {
            events.push('infer');
            return dto;
        });

        const options = {
            terminalStore: terminal,
            geminiLeaseStore: geminiLeaseStore as never,
            infer,
            env: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            now: () => Date.parse(submittedAt) + 1_000,
        };
        await expect(runPrecheckoutBlite(PREFLIGHT, options)).resolves.toBe('capacity_pending');
        await expect(runPrecheckoutBlite(PREFLIGHT, options)).resolves.toBe('capacity_pending');
        await expect(runPrecheckoutBlite(PREFLIGHT, options)).resolves.toBe('complete');

        expect(terminal.deferCapacity).toHaveBeenCalledTimes(2);
        expect(infer).toHaveBeenCalledTimes(1);
        expect(terminal.complete).toHaveBeenCalledTimes(1);
        expect(geminiLeaseStore.release).toHaveBeenCalledOnce();
        expect(events).toEqual([
            'defer:1',
            'defer:2',
            'infer',
            'complete',
            'release',
        ]);
    });

    it('keeps the Gemini fence when complete returns false or throws an ambiguous persistence error', async () => {
        const makeTerminal = (complete: () => Promise<boolean>) => ({
            claim: vi.fn(async () => ({
                disposition: 'claimed' as const,
                leaseToken: LEASE,
                source,
                submittedAt,
                deadlineAt: '2026-08-13T00:01:00.000Z',
                followersCount: 1_200,
                followingCount: 900,
            })),
            complete: vi.fn(complete),
            fail: vi.fn(async () => true),
        });

        const falseTerminal = makeTerminal(async () => false);
        const falseStore = {
            acquire: vi.fn(async () => GEMINI_LEASE),
            release: vi.fn(async () => undefined),
        };
        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: falseTerminal,
            geminiLeaseStore: falseStore as never,
            infer: vi.fn(async () => dto),
            env: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            now: () => Date.parse(submittedAt) + 1_000,
        })).resolves.toBe('pending');
        expect(falseStore.release).not.toHaveBeenCalled();

        const persistenceError = new Error('unknown checkpoint response');
        const unknownTerminal = makeTerminal(async () => {
            throw persistenceError;
        });
        const unknownStore = {
            acquire: vi.fn(async () => GEMINI_LEASE),
            release: vi.fn(async () => undefined),
        };
        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: unknownTerminal,
            geminiLeaseStore: unknownStore as never,
            infer: vi.fn(async () => dto),
            env: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true' },
            now: () => Date.parse(submittedAt) + 1_000,
        })).rejects.toBe(persistenceError);
        expect(unknownStore.release).not.toHaveBeenCalled();
    });

    it('returns retryable pending and keeps the Gemini fence when failure CAS is ambiguous', async () => {
        const makeTerminal = (fail: () => Promise<boolean>) => ({
            claim: vi.fn(async () => ({
                disposition: 'claimed' as const,
                leaseToken: LEASE,
                source,
                submittedAt,
                deadlineAt: '2026-08-13T00:01:00.000Z',
                followersCount: 1_200,
                followingCount: 900,
            })),
            complete: vi.fn(async () => true),
            fail: vi.fn(fail),
        });

        const falseTerminal = makeTerminal(async () => false);
        const falseStore = {
            acquire: vi.fn(async () => GEMINI_LEASE),
            release: vi.fn(async () => undefined),
        };
        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: falseTerminal,
            geminiLeaseStore: falseStore as never,
            infer: vi.fn(async () => null),
            now: () => Date.parse(submittedAt) + 1_000,
        })).resolves.toBe('pending');
        expect(falseTerminal.fail).toHaveBeenCalledOnce();
        expect(falseStore.release).not.toHaveBeenCalled();

        const unknownTerminal = makeTerminal(async () => {
            throw new Error('unknown terminal persistence result');
        });
        const unknownStore = {
            acquire: vi.fn(async () => GEMINI_LEASE),
            release: vi.fn(async () => undefined),
        };
        await expect(runPrecheckoutBlite(PREFLIGHT, {
            terminalStore: unknownTerminal,
            geminiLeaseStore: unknownStore as never,
            infer: vi.fn(async () => null),
            now: () => Date.parse(submittedAt) + 86_000,
        })).resolves.toBe('pending');
        expect(unknownTerminal.fail).toHaveBeenCalledOnce();
        expect(unknownStore.release).not.toHaveBeenCalled();
    });
});
