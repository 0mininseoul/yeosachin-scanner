import { describe, expect, it, vi } from 'vitest';
import { runAnalysisV2AiReplay, type ReplayAiRunner } from './replay-runner';

const bundle = {
    schemaVersion: 1 as const,
    createdAt: '2026-07-27T00:00:00.000Z', expiresAt: '2026-07-27T01:00:00.000Z',
    capture: { requestFingerprint: 'a'.repeat(64), plan: 'standard' as const },
    profiles: [
        { ordinal: 1, isPrivate: false, bio: null, media: [{ selectionId: 'm1', caption: null, jpegBase64: '/9j/2Q==' }] },
        { ordinal: 2, isPrivate: true, bio: null, media: [] },
    ], evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
};

describe('AI-only replay runner', () => {
    it('dry-run validates inputs without calling AI and emits only safe aggregate metrics', async () => {
        const triage = vi.fn();
        const lines: string[] = [];
        const report = await runAnalysisV2AiReplay({ bundle, runner: { triage }, mode: 'dry-run', write: line => lines.push(line) });
        expect(triage).not.toHaveBeenCalled();
        expect(report.stages.genderTriage.calls).toBe(0);
        expect(lines.join('\n')).not.toContain('m1');
        expect(lines.join('\n')).not.toContain('a'.repeat(64));
    });

    it('requires explicit paid-ai mode, summarizes retry/rate-limit/outcome metrics, and has no persistence dependency', async () => {
        const runner: ReplayAiRunner = {
            triage: vi.fn(async () => ({ outcome: 'ok' as const, value: { inferredGender: 'female' as const, routeToFeature: true }, attempts: 2, retries: 1, elapsedMs: 20 })),
            feature: vi.fn(async () => ({ outcome: 'rate_limited' as const, attempts: 1, retries: 0, elapsedMs: 30 })),
            privateName: vi.fn(async () => ({ outcome: 'ok' as const, attempts: 1, retries: 0, elapsedMs: 10 })),
        };
        await expect(runAnalysisV2AiReplay({ bundle, runner, mode: 'paid-ai' })).rejects.toThrow('ANALYSIS_V2_REPLAY_PAID_AI_OPT_IN_REQUIRED');
        const report = await runAnalysisV2AiReplay({ bundle, runner, mode: 'paid-ai', paidAiOptIn: true });
        expect(report.stages.genderTriage).toMatchObject({ calls: 1, retries: 1, meanLatencyMs: 20 });
        expect(report.stages.featureAnalysis).toMatchObject({ calls: 1, rateLimited: 1, failureDisposition: { rate_limited: 1 } });
        expect(report.gender).toEqual({ male: 0, female: 1, unknown: 0, unknownRate: 0 });
        expect(report.stages.privateAccountName.calls).toBe(1);
    });
});
