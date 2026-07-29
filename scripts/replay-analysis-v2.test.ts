import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock(
    '../lib/services/analysis/replay/replay-v219-approved-source',
    async importOriginal => {
        const actual = await importOriginal<
            typeof import(
                '../lib/services/analysis/replay/replay-v219-approved-source'
            )
        >();
        return {
            ...actual,
            V219_APPROVED_REPLAY_SOURCE_MANIFEST: Object.freeze({
                schema:
                    'analysis-v2-replay-v219-approved-source-v1',
                manifestId: 'synthetic-v219-source-test-v1',
                parentSourceContentSha256:
                    '83ae21a5fd01b4311d1e2981fe199322435d8ed24403042242d2f107a4eeee3a',
                witnessSourceContentSha256:
                    '83ae21a5fd01b4311d1e2981fe199322435d8ed24403042242d2f107a4eeee3a',
            }),
        };
    },
);
import {
    createReplayKeyFile,
    writeReplayBundle,
    type AnalysisV2ReplayBundle,
} from '../lib/services/analysis/replay/replay-bundle';
import { parseReplayCliArgs, runReplayCli } from './replay-analysis-v2';
import { historicalPartialSourceUniverseDigest } from '../lib/services/analysis/replay/historical-partial-available-artifact';
import {
    createV219SealedSourceTestBundle,
} from '../lib/services/analysis/replay/replay-v219-preflight.test-fixture';
import packageJson from '../package.json';

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

function partialReplayBundle(now: number): AnalysisV2ReplayBundle {
    const exact = replayBundle(now);
    return {
        ...exact,
        schemaVersion: 2,
        capture: {
            ...exact.capture,
            scope: 'ai-only-historical-partial-available',
            notExact: true,
            fullE2eEvidence: false,
            noMediaSubstitution: true,
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29',
                aiStage: 'ai-stage-policy-v2.9',
            },
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: { pipeline: 'v2', aiStage: 'ai-stage-policy-v2.7', risk: 'risk-policy-v2.3' },
            },
            partial: { sourceUniverseDigest: historicalPartialSourceUniverseDigest([]), sourceIdentities: [], mediaUnavailable: [] },
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

async function partialArtifacts(now: number) {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-v2-replay-partial-cli-'));
    temporaryPaths.push(directory);
    const bundlePath = join(directory, 'bundle.enc');
    const keyPath = join(directory, 'bundle.key');
    await createReplayKeyFile(keyPath);
    await writeReplayBundle({ bundle: partialReplayBundle(now), bundlePath, keyPath, now });
    return { bundlePath, keyPath };
}

async function v219Artifacts(now: number) {
    const directory = await mkdtemp(join(
        tmpdir(),
        'analysis-v2-replay-v219-cli-',
    ));
    temporaryPaths.push(directory);
    const bundlePath = join(directory, 'bundle.enc');
    const keyPath = join(directory, 'bundle.key');
    await createReplayKeyFile(keyPath);
    await writeReplayBundle({
        bundle: createV219SealedSourceTestBundle(now),
        bundlePath,
        keyPath,
        now,
    });
    return { bundlePath, keyPath };
}

async function v219SourceOnlyArtifacts(now: number) {
    const parentDirectory = await mkdtemp(join(
        tmpdir(),
        'analysis-v2-replay-v219-parent-cli-',
    ));
    const witnessDirectory = await mkdtemp(join(
        tmpdir(),
        'analysis-v2-replay-v219-witness-cli-',
    ));
    temporaryPaths.push(parentDirectory, witnessDirectory);
    const parentBundlePath = join(parentDirectory, 'input.enc');
    const parentKeyPath = join(parentDirectory, 'input.key');
    const witnessBundlePath = join(witnessDirectory, 'input.enc');
    const witnessKeyPath = join(witnessDirectory, 'input.key');
    const parent = createV219SealedSourceTestBundle(now);
    const witness = structuredClone(parent);
    parent.capture.evaluationPolicy = {
        capability:
            'historical-partial-available-standard-v27-risk-v23-to-ai-v217-public-name-visual-fusion-shadow',
        aiStage: 'ai-stage-policy-v2.17',
    } as never;
    witness.capture.evaluationPolicy = {
        capability:
            'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality',
        aiStage: 'ai-stage-policy-v2.12',
    } as never;
    await Promise.all([
        createReplayKeyFile(parentKeyPath),
        createReplayKeyFile(witnessKeyPath),
    ]);
    await Promise.all([
        writeReplayBundle({
            bundle: parent,
            bundlePath: parentBundlePath,
            keyPath: parentKeyPath,
            now,
        }),
        writeReplayBundle({
            bundle: witness,
            bundlePath: witnessBundlePath,
            keyPath: witnessKeyPath,
            now,
        }),
    ]);
    return {
        parentBundlePath,
        parentKeyPath,
        witnessBundlePath,
        witnessKeyPath,
    };
}

describe('analysis V2 replay CLI', () => {
    it('parses a read-only V2.19 source preflight with independent V2.17 parent and V2.12 witness artifacts', () => {
        expect(parseReplayCliArgs([
            '--v219-source-only-preflight',
            '--bundle=/private/v217/input.enc',
            '--key=/private/v217/input.key',
            '--witness-bundle=/private/v212/input.enc',
            '--witness-key=/private/v212/input.key',
        ])).toEqual({
            command: 'v219-source-only-preflight',
            bundlePath: '/private/v217/input.enc',
            keyPath: '/private/v217/input.key',
            witnessBundlePath: '/private/v212/input.enc',
            witnessKeyPath: '/private/v212/input.key',
        });
    });

    it('authenticates both retained artifacts and emits only the V2.19 source-only preflight without deleting or entering replay', async () => {
        const artifacts = await v219SourceOnlyArtifacts(Date.now());
        const output: string[] = [];
        const original = process.stdout.write;
        const createPaidRunner = vi.fn(() => {
            throw new Error('PAID_RUNNER_CONSTRUCTED');
        });
        const runReplay = vi.fn(() => {
            throw new Error('REPLAY_EXECUTION_ENTERED');
        });
        const beforeOwnedArtifactRemoval = vi.fn();
        process.stdout.write = ((line: string) => {
            output.push(line);
            return true;
        }) as typeof process.stdout.write;
        try {
            await runReplayCli([
                '--v219-source-only-preflight',
                `--bundle=${artifacts.parentBundlePath}`,
                `--key=${artifacts.parentKeyPath}`,
                `--witness-bundle=${artifacts.witnessBundlePath}`,
                `--witness-key=${artifacts.witnessKeyPath}`,
            ], {
                createPaidRunner,
                runReplay,
                beforeOwnedArtifactRemoval,
            });
        } finally {
            process.stdout.write = original;
        }

        expect(JSON.parse(output.join(''))).toMatchObject({
            schema: 'analysis-v2-replay-v219-preflight-v1',
            sourceBinding: 'v217-parent-with-v212-witness',
            sourceWitness: {
                aiPolicy: 'ai-stage-policy-v2.12',
                identityAgreement: true,
            },
            externalEffects: {
                geminiClientsConstructed: 0,
                providerDispatches: 0,
                apifyClientsConstructed: 0,
                instagramTransportsConstructed: 0,
                productionStoresConstructed: 0,
                resultWritersConstructed: 0,
                cloudRunExecutionsCreated: 0,
            },
        });
        expect(createPaidRunner).not.toHaveBeenCalled();
        expect(runReplay).not.toHaveBeenCalled();
        expect(beforeOwnedArtifactRemoval).not.toHaveBeenCalled();
        await expect(stat(artifacts.parentBundlePath)).resolves
            .toMatchObject({ isFile: expect.any(Function) });
        await expect(stat(artifacts.parentKeyPath)).resolves
            .toMatchObject({ isFile: expect.any(Function) });
        await expect(stat(artifacts.witnessBundlePath)).resolves
            .toMatchObject({ isFile: expect.any(Function) });
        await expect(stat(artifacts.witnessKeyPath)).resolves
            .toMatchObject({ isFile: expect.any(Function) });
    });

    it('seals v2.11 gender-quality replay behind its historical partial capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.11',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v211-gender-quality',
                aiStage: 'ai-stage-policy-v2.11',
            },
        });
    });
    it('seals v2.12 behind distinct official and partial evaluation capabilities', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.12',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality',
                aiStage: 'ai-stage-policy-v2.12',
            },
        });
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.12',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v212-gender-quality',
                aiStage: 'ai-stage-policy-v2.12',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--evaluation-ai-policy=ai-stage-policy-v2.12',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('seals evaluation-only v2.13 behind its partial shadow capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.13',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow',
                aiStage: 'ai-stage-policy-v2.13',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.13',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('seals evaluation-only v2.14 behind its own partial feature-model shadow capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.14',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v214-feature-model-shadow',
                aiStage: 'ai-stage-policy-v2.14',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.14',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('seals evaluation-only v2.15 behind its own partial output-cap shadow capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.15',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v215-feature-output-cap-shadow',
                aiStage: 'ai-stage-policy-v2.15',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.15',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('seals evaluation-only v2.16 behind its single-profile admission shadow capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.16',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v216-single-profile-admission-shadow',
                aiStage: 'ai-stage-policy-v2.16',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.16',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('seals evaluation-only v2.17 behind its public name-visual fusion shadow capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.17',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v217-public-name-visual-fusion-shadow',
                aiStage: 'ai-stage-policy-v2.17',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.17',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('seals evaluation-only v2.18 behind its public-gender headroom diagnostic capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.18',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v218-public-gender-headroom-diagnostic',
                aiStage: 'ai-stage-policy-v2.18',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.18',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('seals evaluation-only v2.19 behind its Pro second-look partial capability', () => {
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.19',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v219-pro-gender-second-look-shadow',
                aiStage: 'ai-stage-policy-v2.19',
            },
        });
        expect(parseReplayCliArgs([
            '--capture',
            '--historical-partial-available',
            '--request-id=00000000-0000-4000-8000-000000000000',
            '--evaluation-ai-policy=ai-stage-policy-v2.19',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toMatchObject({
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v219-pro-gender-second-look-shadow',
                aiStage: 'ai-stage-policy-v2.19',
            },
        });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai',
            '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.19',
            '--bundle=/tmp/bundle', '--key=/tmp/key',
        ])).toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });
    it('runs the canonical replay command under the React server condition', () => {
        expect(packageJson.scripts['replay:analysis-v2']).toBe(
            'tsx --conditions=react-server --env-file=.env.local scripts/replay-analysis-v2.ts',
        );
    });

    it('creates the real frozen v2.9 paid adapter under canonical runtime conditions without invoking AI', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--conditions=react-server',
                '--import',
                'tsx',
                '--eval',
                "import('./scripts/replay-analysis-v2.ts').then(async m => { const create = m.createPaidReplayRunner ?? m.default?.createPaidReplayRunner; if (typeof create !== 'function') throw new Error('ANALYSIS_V2_REPLAY_MODULE_EXPORT_MISSING'); const runner = await create('ai-stage-policy-v2.9'); process.stdout.write(JSON.stringify({ frozen: Object.isFrozen(runner), stages: Object.keys(runner).sort() })); })",
            ],
            { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            frozen: true,
            stages: ['feature', 'privateNames', 'resolveGender', 'triage'],
        });
        expect(result.stderr).toBe('');
    });

    it('pins global before importing the V2.19 paid adapter even when the CLI ambient location is regional', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--conditions=react-server',
                '--import',
                'tsx',
                '--eval',
                "import('./scripts/replay-analysis-v2.ts').then(async m => { const create = m.createPaidReplayRunner ?? m.default?.createPaidReplayRunner; if (typeof create !== 'function') throw new Error('ANALYSIS_V2_REPLAY_MODULE_EXPORT_MISSING'); const runner = await create('ai-stage-policy-v2.19', { v219TreatmentLogicalCalls: 0 }); process.stdout.write(JSON.stringify({ frozen: Object.isFrozen(runner), location: process.env.GOOGLE_CLOUD_LOCATION })); })",
            ],
            {
                cwd: process.cwd(),
                encoding: 'utf8',
                timeout: 10_000,
                env: {
                    ...process.env,
                    GOOGLE_CLOUD_LOCATION: 'us-central1',
                },
            },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual({
            frozen: true,
            location: 'global',
        });
        expect(result.stderr).toBe('');
    });

    it('maps a missing React server condition to a bounded paid-runtime error', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                '--eval',
                "import('./scripts/replay-analysis-v2.ts').then(m => { const create = m.createPaidReplayRunner ?? m.default?.createPaidReplayRunner; if (typeof create !== 'function') throw new Error('ANALYSIS_V2_REPLAY_MODULE_EXPORT_MISSING'); return create('ai-stage-policy-v2.9'); }).catch(error => { process.stderr.write(error.message); process.exitCode = 1; })",
            ],
            { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toBe('ANALYSIS_V2_REPLAY_SERVER_RUNTIME_REQUIRED');
        expect(result.stderr).not.toContain('Client Component');
    });

    it('loads replay CLI without React server module conditions', () => {
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                '--eval',
                "import('./scripts/replay-analysis-v2.ts').then(() => process.stdout.write('ok'))",
            ],
            { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        expect(result.stdout).toBe('ok');
        expect(result.stderr).not.toContain('server-only');
    });

    it('runs an authenticated dry replay without React server module conditions', async () => {
        const { bundlePath, keyPath } = await artifacts(Date.now());
        const result = spawnSync(
            process.execPath,
            [
                '--import',
                'tsx',
                'scripts/replay-analysis-v2.ts',
                '--run',
                '--dry-run',
                `--bundle=${bundlePath}`,
                `--key=${keyPath}`,
            ],
            { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
        );
        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            status: 'ok',
            benchmark_scope: 'ai-only-exact-replay',
        });
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

    it('seals the v2.10 target to the historical official E2E capability', () => {
        const args = [
            '--run', '--paid-ai', '--confirm-paid-ai', '--historical-official-e2e',
            '--evaluation-ai-policy=ai-stage-policy-v2.10',
            '--bundle=a.enc', '--key=a.key',
        ];
        expect(parseReplayCliArgs(args)).toMatchObject({
            command: 'run',
            mode: 'paid-ai',
            historicalOfficialE2E: true,
            evaluationPolicy: {
                capability: 'historical-official-e2e-standard-v27-risk-v23-to-ai-v210',
                aiStage: 'ai-stage-policy-v2.10',
            },
        });
        expect(() => parseReplayCliArgs(args.filter(arg => arg !== '--historical-official-e2e')))
            .toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    });

    it('seals historical partial capture and replay behind its explicit scope and v2.9 capability', () => {
        expect(parseReplayCliArgs([
            '--capture', '--historical-partial-available',
            '--request-id=10000000-0000-4000-8000-000000000001',
            '--evaluation-ai-policy=ai-stage-policy-v2.9', '--bundle=a.enc', '--key=a.key',
        ])).toMatchObject({ command: 'capture', historicalPartialAvailable: true });
        expect(parseReplayCliArgs([
            '--run', '--dry-run', '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.9', '--bundle=a.enc', '--key=a.key',
        ])).toMatchObject({ command: 'run', mode: 'dry-run', historicalPartialAvailable: true });
        expect(parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai', '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.9', '--bundle=a.enc', '--key=a.key',
        ])).toMatchObject({ command: 'run', mode: 'paid-ai', historicalPartialAvailable: true });
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.9', '--bundle=a.enc', '--key=a.key',
        ])).toThrow('ANALYSIS_V2_REPLAY_PAID_AI_DOUBLE_CONFIRM_REQUIRED');
        expect(() => parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai', '--historical-partial-available',
            '--bundle=a.enc', '--key=a.key',
        ])).toThrow('ANALYSIS_V2_REPLAY_PARTIAL_CAPABILITY_REQUIRED');
    });

    it('seals partial v2.10 capture and run behind a distinct capability', () => {
        const capture = parseReplayCliArgs([
            '--capture', '--historical-partial-available',
            '--request-id=10000000-0000-4000-8000-000000000001',
            '--evaluation-ai-policy=ai-stage-policy-v2.10',
            '--bundle=a.enc', '--key=a.key',
        ]);
        const run = parseReplayCliArgs([
            '--run', '--paid-ai', '--confirm-paid-ai', '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.10',
            '--bundle=a.enc', '--key=a.key',
        ]);

        for (const parsed of [capture, run]) {
            expect(parsed).toMatchObject({
                historicalPartialAvailable: true,
                evaluationPolicy: {
                    capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v210',
                    aiStage: 'ai-stage-policy-v2.10',
                },
            });
        }
    });

    it('double-confirms the diagnostic partial-coverage override only for paid partial runs', () => {
        const base = [
            '--run', '--paid-ai', '--confirm-paid-ai', '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.10',
            '--bundle=a.enc', '--key=a.key',
        ];
        const approved = parseReplayCliArgs([
            ...base,
            '--allow-low-partial-coverage',
            '--confirm-low-partial-coverage',
        ]);
        expect(approved).toMatchObject({
            command: 'run',
            mode: 'paid-ai',
            historicalPartialAvailable: true,
            diagnosticPartialCoverageCapability: expect.any(Object),
        });
        expect(approved).not.toHaveProperty('allowLowPartialCoverage');
        expect(() => parseReplayCliArgs([
            ...base,
            '--allow-low-partial-coverage',
        ])).toThrow('ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_DOUBLE_CONFIRM_REQUIRED');
        expect(() => parseReplayCliArgs([
            ...base.filter(arg => arg !== '--paid-ai' && arg !== '--confirm-paid-ai'),
            '--allow-low-partial-coverage',
            '--confirm-low-partial-coverage',
        ])).toThrow('ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_SCOPE_REQUIRED');
        expect(() => parseReplayCliArgs([
            ...base.filter(arg => arg !== '--historical-partial-available'),
            '--allow-low-partial-coverage',
            '--confirm-low-partial-coverage',
        ])).toThrow('ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_SCOPE_REQUIRED');
    });

    it('rejects partial artifacts from exact runs and exact artifacts from partial dry-runs', async () => {
        const partial = await partialArtifacts(Date.now());
        await expect(runReplayCli(['--run', `--bundle=${partial.bundlePath}`, `--key=${partial.keyPath}`]))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_ARTIFACT_SCOPE_MISMATCH');
        const exact = await artifacts(Date.now());
        await expect(runReplayCli([
            '--run', '--dry-run', '--historical-partial-available',
            '--evaluation-ai-policy=ai-stage-policy-v2.9', `--bundle=${exact.bundlePath}`, `--key=${exact.keyPath}`,
        ])).rejects.toThrow('ANALYSIS_V2_REPLAY_ARTIFACT_SCOPE_MISMATCH');
    });

    it('runs a partial artifact only in explicit dry-run mode and reports its non-exact scope', async () => {
        const partial = await partialArtifacts(Date.now());
        const output: string[] = [];
        const original = process.stdout.write;
        process.stdout.write = ((line: string) => { output.push(line); return true; }) as typeof process.stdout.write;
        try {
            await runReplayCli([
                '--run', '--dry-run', '--historical-partial-available',
                '--evaluation-ai-policy=ai-stage-policy-v2.9', `--bundle=${partial.bundlePath}`, `--key=${partial.keyPath}`,
            ]);
        } finally { process.stdout.write = original; }
        expect(JSON.parse(output.join(''))).toMatchObject({
            benchmark_scope: 'ai-only-historical-partial-available',
            not_exact: true,
            full_e2e_evidence: false,
            no_media_substitution: true,
        });
        await expect(stat(partial.bundlePath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(partial.keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('runs V2.19 dry preflight without constructing a paid runner or entering replay execution', async () => {
        const artifacts = await v219Artifacts(Date.now());
        const output: string[] = [];
        const original = process.stdout.write;
        const createPaidRunner = () => {
            throw new Error('PAID_RUNNER_CONSTRUCTED');
        };
        const runReplay = () => {
            throw new Error('REPLAY_EXECUTION_ENTERED');
        };
        process.stdout.write = ((line: string) => {
            output.push(line);
            return true;
        }) as typeof process.stdout.write;
        try {
            await runReplayCli([
                '--run',
                '--dry-run',
                '--historical-partial-available',
                '--evaluation-ai-policy=ai-stage-policy-v2.19',
                `--bundle=${artifacts.bundlePath}`,
                `--key=${artifacts.keyPath}`,
            ], {
                createPaidRunner,
                runReplay,
            });
        } finally {
            process.stdout.write = original;
        }

        expect(JSON.parse(output.join(''))).toMatchObject({
            schema: 'analysis-v2-replay-v219-preflight-v1',
            treatment: { staticCohort: 235 },
            budget: {
                totalLogicalCalls: 945,
                totalProviderDispatches: 3_780,
                costCeilingUsd: 121.1792,
            },
            externalEffects: {
                geminiClientsConstructed: 0,
                providerDispatches: 0,
                apifyClientsConstructed: 0,
                instagramTransportsConstructed: 0,
                productionStoresConstructed: 0,
                resultWritersConstructed: 0,
                cloudRunExecutionsCreated: 0,
            },
        });
        await expect(stat(artifacts.bundlePath)).rejects.toThrow();
        await expect(stat(artifacts.keyPath)).rejects.toThrow();
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
