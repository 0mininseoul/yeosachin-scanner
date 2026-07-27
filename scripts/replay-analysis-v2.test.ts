import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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
    it('loads replay capture without React server module conditions', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                '--eval',
                "import('./lib/services/analysis/replay/replay-capture.ts').then(() => process.stdout.write('ok'))",
            ],
            { cwd: process.cwd(), encoding: 'utf8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('ok');
        expect(result.stderr).not.toContain('server-only');
    });

    it('requires the UUID-only historical official E2E capability on both capture and paid run', () => {
        const capture = [
            '--capture', '--historical-official-e2e',
            '--request-id=10000000-0000-4000-8000-000000000001',
            '--evaluation-ai-policy=ai-stage-policy-v2.9',
            '--bundle=/private/bundle.enc', '--key=/private/key.key',
        ];
        expect(parseReplayCliArgs(capture)).toMatchObject({
            command: 'capture',
            historicalOfficialE2E: true,
            requestId: '10000000-0000-4000-8000-000000000001',
            evaluationPolicy: { aiStage: 'ai-stage-policy-v2.9' },
        });
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai', '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.9',
            '--bundle=a.enc', '--key=a.key',
        ])).toMatchObject({
            command: 'run', mode: 'paid-ai', historicalOfficialE2E: true,
            evaluationPolicy: { aiStage: 'ai-stage-policy-v2.9' },
        });
        expect(() => parseReplayCliArgs([
            '--capture', '--historical-official-e2e', '--target=ambient_target',
            '--request-id=10000000-0000-4000-8000-000000000001',
            '--evaluation-ai-policy=ai-stage-policy-v2.9', '--bundle=a.enc', '--key=a.key',
        ])).toThrow('ANALYSIS_V2_REPLAY_CLI_USAGE');
        expect(() => parseReplayCliArgs([
            '--capture', '--historical-official-e2e',
            '--request-id=10000000-0000-4000-8000-000000000001',
            '--bundle=a.enc', '--key=a.key',
        ])).toThrow('ANALYSIS_V2_REPLAY_HISTORICAL_E2E_CAPABILITY_REQUIRED');
    });

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

    it('rejects capture paths in different directories before creating either artifact', async () => {
        const bundleDirectory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-cli-bundle-'));
        const keyDirectory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-cli-key-'));
        temporaryPaths.push(bundleDirectory, keyDirectory);
        const bundlePath = join(bundleDirectory, 'bundle.enc');
        const keyPath = join(keyDirectory, 'bundle.key');

        const args = [
            '--capture',
            '--target=target',
            `--bundle=${bundlePath}`,
            `--key=${keyPath}`,
        ];
        expect(() => parseReplayCliArgs(args))
            .toThrow('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
        await expect(runReplayCli(args))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');

        await expect(stat(bundlePath)).rejects.toThrow();
        await expect(stat(keyPath)).rejects.toThrow();
    });

    it('defaults run to dry-run and requires both paid-AI confirmations', () => {
        expect(parseReplayCliArgs(['--run', '--bundle=/private/bundle.enc', '--key=/private/key.key']))
            .toEqual({ command: 'run', mode: 'dry-run', bundlePath: '/private/bundle.enc', keyPath: '/private/key.key' });
        expect(() => parseReplayCliArgs(['--run', '--paid-ai', '--bundle=a.enc', '--key=a.key']))
            .toThrow('ANALYSIS_V2_REPLAY_PAID_AI_DOUBLE_CONFIRM_REQUIRED');
        expect(parseReplayCliArgs(['--run', '--paid-ai', '--confirm-paid-ai', '--bundle=a.enc', '--key=a.key']))
            .toEqual({ command: 'run', mode: 'paid-ai', bundlePath: 'a.enc', keyPath: 'a.key' });
    });

    it('requires the exact v2.9 evaluation flag alongside both paid confirmations', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--evaluation-ai-policy=ai-stage-policy-v2.9',
            '--bundle=a.enc', '--key=a.key',
        ])).toMatchObject({
            command: 'run',
            mode: 'paid-ai',
            evaluationPolicy: {
                aiStage: 'ai-stage-policy-v2.9',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--evaluation-ai-policy=ai-stage-policy-v2.8',
            '--bundle=a.enc', '--key=a.key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai',
            '--evaluation-ai-policy=ai-stage-policy-v2.9',
            '--bundle=a.enc', '--key=a.key',
        ])).toThrow('ANALYSIS_V2_REPLAY_PAID_AI_DOUBLE_CONFIRM_REQUIRED');
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
        '--paid-ai=',
        '--confirm-paid-ai=',
        '--dry-run=',
        '--run=',
        '--capture=',
        '--cleanup=',
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

    it('rejects empty assignments for both paid-AI confirmations', () => {
        expect(() => parseReplayCliArgs([
            '--run',
            '--paid-ai=',
            '--confirm-paid-ai=',
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

    it('preserves replacement inodes swapped in after authenticated run read', async () => {
        const paths = await artifacts(Date.now());
        const originalBundlePath = `${paths.bundlePath}.original`;
        const originalKeyPath = `${paths.keyPath}.original`;
        await runReplayCli([
            '--run',
            `--bundle=${paths.bundlePath}`,
            `--key=${paths.keyPath}`,
        ], {
            beforeOwnedArtifactRemoval: async () => {
                await rename(paths.bundlePath, originalBundlePath);
                await rename(paths.keyPath, originalKeyPath);
                await writeFile(paths.bundlePath, 'replacement bundle', { mode: 0o600 });
                await writeFile(paths.keyPath, 'replacement key', { mode: 0o600 });
            },
        });

        await expect(readFile(paths.bundlePath, 'utf8')).resolves.toBe('replacement bundle');
        await expect(readFile(paths.keyPath, 'utf8')).resolves.toBe('replacement key');
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
