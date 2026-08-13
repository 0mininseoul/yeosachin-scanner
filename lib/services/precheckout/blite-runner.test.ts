import { describe, expect, it, vi } from 'vitest';
import { runPrecheckoutBlite } from './blite-runner';

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

describe('runPrecheckoutBlite', () => {
    function observability() {
        return {
            completed: vi.fn(),
            profileCollectionFailed: vi.fn(),
            inferenceFailed: vi.fn(),
            inferenceAttempt: vi.fn(),
            fallbackLatched: vi.fn(),
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
            infer,
            observability: telemetry,
            now: () => Date.parse(submittedAt) + 1_000,
        })).resolves.toBe('complete');
        expect(infer).toHaveBeenCalledWith(source, expect.objectContaining({
            submittedAtMs: Date.parse(submittedAt),
            deadlineAtMs: Date.parse(submittedAt) + 56_000,
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

    it('terminalizes an expired original T+56 deadline without starting inference', async () => {
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
            now: () => Date.parse(submittedAt) + 56_000,
        })).resolves.toBe('failed');
        expect(infer).not.toHaveBeenCalled();
        expect(terminal.fail).toHaveBeenCalledWith({
            preflightId: PREFLIGHT,
            leaseToken: LEASE,
            reason: 'inference_timeout',
        });
        expect(telemetry.inferenceFailed).toHaveBeenCalledWith('timeout');
    });
});
