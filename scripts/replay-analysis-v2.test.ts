import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createReplayKeyFile,
    writeReplayBundle,
    type AnalysisV2ReplayBundle,
} from '../lib/services/analysis/replay/replay-bundle';
import { parseReplayCliArgs, runReplayCli } from './replay-analysis-v2';

const temporaryPaths: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryPaths.splice(0).map(path => (
        rm(path, { recursive: true, force: true })
    )));
});

function replayBundle(now: number): AnalysisV2ReplayBundle {
    return {
        schemaVersion: 1,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        capture: {
            requestFingerprint: 'a'.repeat(64),
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2',
                    aiStage: 'ai-stage-policy-v2.7',
                    risk: 'risk-policy-v2.4',
                },
            },
        },
        profiles: [],
        evidence: {
            relationship: [],
            targetInteractions: [],
            reverseInteractions: [],
        },
    };
}

async function artifacts(now: number) {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-cli-'));
    temporaryPaths.push(directory);
    const bundlePath = join(directory, 'bundle.enc');
    const keyPath = join(directory, 'bundle.key');
    await createReplayKeyFile(keyPath);
    await writeReplayBundle({
        bundle: replayBundle(now),
        bundlePath,
        keyPath,
        now,
    });
    return { bundlePath, keyPath };
}

describe('analysis V2 replay CLI', () => {
    it('parses an exact capture selector and artifact paths', () => {
        expect(parseReplayCliArgs([
            '--capture', '--target=target', '--request-id=10000000-0000-4000-8000-000000000001',
            '--bundle=/private/bundle.enc', '--key=/private/key.key',
        ])).toEqual({
            command: 'capture', target: 'target',
            requestId: '10000000-0000-4000-8000-000000000001',
            bundlePath: '/private/bundle.enc', keyPath: '/private/key.key',
        });
    });

    it('defaults run to dry-run and requires both paid-AI confirmations', () => {
        expect(parseReplayCliArgs(['--run', '--bundle=/private/bundle.enc', '--key=/private/key.key']))
            .toEqual({ command: 'run', mode: 'dry-run', bundlePath: '/private/bundle.enc', keyPath: '/private/key.key' });
        expect(() => parseReplayCliArgs(['--run', '--paid-ai', '--bundle=a.enc', '--key=a.key']))
            .toThrow('ANALYSIS_V2_REPLAY_PAID_AI_DOUBLE_CONFIRM_REQUIRED');
        expect(parseReplayCliArgs(['--run', '--paid-ai', '--confirm-paid-ai', '--bundle=a.enc', '--key=a.key']))
            .toEqual({ command: 'run', mode: 'paid-ai', bundlePath: 'a.enc', keyPath: 'a.key' });
    });

    it.each([
        '--paid-ai=false',
        '--paid-ai=true',
        '--paid-ai=1',
        '--confirm-paid-ai=false',
        '--confirm-paid-ai=true',
        '--confirm-paid-ai=confirmed',
        '--dry-run=false',
        '--run=true',
    ])('rejects value-bearing boolean flag %s', flag => {
        expect(() => parseReplayCliArgs([
            '--run',
            '--paid-ai',
            '--confirm-paid-ai',
            flag,
            '--bundle=a.enc',
            '--key=a.key',
        ])).toThrow('ANALYSIS_V2_REPLAY_CLI_USAGE');
    });

    it('exposes exact artifact cleanup without directory arguments', () => {
        expect(parseReplayCliArgs(['--cleanup', '--bundle=a.enc', '--key=a.key']))
            .toEqual({ command: 'cleanup', bundlePath: 'a.enc', keyPath: 'a.key' });
        expect(() => parseReplayCliArgs(['--cleanup', '--bundle=a.enc', '--key=a.key', '--directory=/tmp']))
            .toThrow('ANALYSIS_V2_REPLAY_CLI_USAGE');
    });

    it('always removes the exact pair after a successful run', async () => {
        const paths = await artifacts(Date.now());
        await runReplayCli([
            '--run',
            `--bundle=${paths.bundlePath}`,
            `--key=${paths.keyPath}`,
        ]);

        await expect(stat(paths.bundlePath)).rejects.toThrow();
        await expect(stat(paths.keyPath)).rejects.toThrow();
    });

    it('removes the exact pair when run rejects an expired bundle', async () => {
        const paths = await artifacts(Date.now() - 120_000);
        await expect(runReplayCli([
            '--run',
            `--bundle=${paths.bundlePath}`,
            `--key=${paths.keyPath}`,
        ])).rejects.toThrow('ANALYSIS_V2_REPLAY_BUNDLE_EXPIRED');

        await expect(stat(paths.bundlePath)).rejects.toThrow();
        await expect(stat(paths.keyPath)).rejects.toThrow();
    });
});
