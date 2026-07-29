import { createHash } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    createReplayKeyFile,
    writeReplayBundle,
} from '../lib/services/analysis/replay/replay-bundle';
import { historicalPartialSourceUniverseDigest } from '../lib/services/analysis/replay/historical-partial-available-artifact';

const falseGates = {
    ANALYSIS_TASKS_ENABLED: 'false',
    ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'false',
    ANALYSIS_V2_ADMISSION_ENABLED: 'false',
    ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT: 'false',
    ANALYSIS_V2_AI_SCHEDULER_ROLLOUT: 'false',
    ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'false',
    ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT: 'false',
    ANALYSIS_V2_NARRATIVE_V28_ROLLOUT: 'false',
    ANALYSIS_V2_REPLAY_CAPTURE_ENABLED: 'false',
    ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'false',
    ANALYSIS_V2_TASKS_ENABLED: 'false',
    ANALYSIS_V2_WORKER_ENABLED: 'false',
    ANALYSIS_V2_WORKER_EXECUTION_ENABLED: 'false',
    ANALYSIS_V2_RECOVERY_ENABLED: 'false',
    DEMO_ANALYSIS_ENABLED: 'false',
    EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED: 'false',
    PREFLIGHT_LOCAL_AFTER_ENABLED: 'false',
    PREFLIGHT_TASKS_ENABLED: 'false',
} as const;

function validEnv(): Record<string, string> {
    return {
        ...falseGates,
        CLOUD_RUN_TASK_COUNT: '1',
        CLOUD_RUN_TASK_INDEX: '0',
        CLOUD_RUN_TASK_ATTEMPT: '0',
        CLOUD_RUN_EXECUTION: 'replay-job-abc123',
        ANALYSIS_V2_REPLAY_JOB_EXPECTED_EXECUTION: 'replay-job-abc123',
        ANALYSIS_V2_REPLAY_JOB_TOKEN: 'a'.repeat(43),
        ANALYSIS_V2_REPLAY_JOB_EXPECTED_TOKEN: 'a'.repeat(43),
        ANALYSIS_V2_REPLAY_JOB_BUNDLE_PATH: '/tmp/private-replay/input.enc',
        ANALYSIS_V2_REPLAY_JOB_KEY_PATH: '/tmp/private-replay/input.key',
        ANALYSIS_V2_REPLAY_JOB_BUNDLE_BYTES: '123',
        ANALYSIS_V2_REPLAY_JOB_BUNDLE_SHA256: 'b'.repeat(64),
        ANALYSIS_V2_REPLAY_JOB_GCS_BUCKET: 'replay-safe-output',
        ANALYSIS_V2_REPLAY_JOB_BUNDLE_OBJECT: 'inputs/bundle.enc',
        ANALYSIS_V2_REPLAY_JOB_BUNDLE_GENERATION: '123456789',
        ANALYSIS_V2_REPLAY_JOB_CLAIM_OBJECT:
            'claims/claim-0123456789abcdef.json',
        ANALYSIS_V2_REPLAY_JOB_REPORT_OBJECT:
            'reports/report-0123456789abcdef.json',
    };
}

function v212Bundle(now = Date.now()) {
    return {
        schemaVersion: 2 as const,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
        capture: {
            scope: 'ai-only-historical-partial-available' as const,
            notExact: true as const,
            fullE2eEvidence: false as const,
            noMediaSubstitution: true as const,
            requestFingerprint: 'a'.repeat(64),
            sourceLineage: {
                selectedPlanId: 'standard' as const,
                policyVersions: {
                    pipeline: 'v2' as const,
                    aiStage: 'ai-stage-policy-v2.7' as const,
                    risk: 'risk-policy-v2.3' as const,
                },
            },
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality' as const,
                aiStage: 'ai-stage-policy-v2.12' as const,
            },
            partial: {
                sourceUniverseDigest:
                    historicalPartialSourceUniverseDigest([]),
                sourceIdentities: [],
                mediaUnavailable: [],
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

describe('Cloud Run analysis V2 replay job', () => {
    it.each([
        ['CLOUD_RUN_TASK_COUNT', '2'],
        ['CLOUD_RUN_TASK_INDEX', '1'],
        ['CLOUD_RUN_TASK_ATTEMPT', '1'],
        ['CLOUD_RUN_EXECUTION', ''],
        ['ANALYSIS_V2_REPLAY_JOB_EXPECTED_EXECUTION', 'other-execution'],
        ['ANALYSIS_V2_REPLAY_JOB_EXPECTED_TOKEN', 'c'.repeat(43)],
        ['ANALYSIS_V2_ADMISSION_ENABLED', 'true'],
        ['PREFLIGHT_TASKS_ENABLED', '0'],
        ['EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED', 'FALSE'],
        ['ANALYSIS_V2_RESULT_IMAGES_ENABLED', ''],
        ['ANALYSIS_TEST_ENTITLEMENTS_ENABLED', 'true'],
    ])('rejects invalid task or exact-false gate %s before provider work', async (
        key,
        value,
    ) => {
        const { validateReplayAnalysisV2JobEnvironment } = await import(
            './replay-analysis-v2-job'
        );
        const env = { ...validEnv(), [key]: value };

        expect(() => validateReplayAnalysisV2JobEnvironment(env))
            .toThrow(/^ANALYSIS_V2_REPLAY_JOB_/);
    });

    it.each([
        'NEXT_PUBLIC_SUPABASE_URL',
        'SUPABASE_SERVICE_ROLE_KEY',
        'APIFY_API_TOKEN',
        'APIFY_SECONDARY_API_TOKEN',
        'ANALYSIS_V2_RESULT_IMAGE_R2_ENDPOINT',
        'R2_SECRET_ACCESS_KEY',
        'ANALYSIS_V2_TASKS_TARGET_URL',
        'ANALYSIS_V2_MAINTENANCE_OIDC_AUDIENCE',
        'GOOGLE_APPLICATION_CREDENTIALS',
        'GOOGLE_SERVICE_ACCOUNT_KEY_BASE64',
    ])('rejects forbidden non-ADC environment %s', async key => {
        const { validateReplayAnalysisV2JobEnvironment } = await import(
            './replay-analysis-v2-job'
        );
        expect(() => validateReplayAnalysisV2JobEnvironment({
            ...validEnv(),
            [key]: 'forbidden-secret-or-url',
        })).toThrow('ANALYSIS_V2_REPLAY_JOB_FORBIDDEN_ENVIRONMENT');
    });

    it('does not import the capture CLI or forbidden lifecycle boundaries', async () => {
        const source = await readFile(
            new URL('./replay-analysis-v2-job.ts', import.meta.url),
            'utf8',
        );
        const imports = source.split('\n')
            .filter(line => line.startsWith('import '))
            .join('\n');

        expect(source).not.toContain("from './replay-analysis-v2'");
        expect(imports).not.toMatch(
            /supabase|apify|provider-run|result-store|archive|r2|cloud.*tasks|app\/api/i,
        );
        expect(source).toContain('readAuthenticatedReplayBundle');
        expect(source).toContain('createReplayStagedAiAdapter');
        expect(source).toContain('runAnalysisV2AiReplay');
    });

    it('creates the claim before exactly one runner and uploads before stdout', async () => {
        const { runReplayAnalysisV2Job } = await import(
            './replay-analysis-v2-job'
        );
        const events: string[] = [];
        const createRunner = vi.fn(() => {
            events.push('runner');
            return Object.freeze({});
        });
        const writeStdout = vi.fn((line: string) => {
            events.push('stdout');
            expect(line).toBe('{"status":"ok"}\n');
        });
        const cleanup = vi.fn(async () => { events.push('cleanup'); });
        const safeLine = '{"status":"ok"}';

        await runReplayAnalysisV2Job({
            env: validEnv(),
            loadArtifacts: vi.fn(async () => ({
                bundle: {
                    schemaVersion: 2,
                    capture: {
                        scope: 'ai-only-historical-partial-available',
                        sourceLineage: {
                            selectedPlanId: 'standard',
                            policyVersions: {
                                pipeline: 'v2',
                                aiStage: 'ai-stage-policy-v2.7',
                                risk: 'risk-policy-v2.3',
                            },
                        },
                        evaluationPolicy: {
                            capability:
                                'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality',
                            aiStage: 'ai-stage-policy-v2.12',
                        },
                    },
                    expired: false,
                },
                cleanup,
            })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(async () => { events.push('claim'); }),
                createReport: vi.fn(async raw => {
                    events.push('report');
                    expect(raw).toBe(safeLine);
                }),
            }),
            createRunner,
            runReplay: vi.fn(async input => {
                events.push('provider');
                expect(input).toMatchObject({
                    mode: 'paid-ai',
                    paidAiOptIn: true,
                    evaluationPolicy: {
                        aiStage: 'ai-stage-policy-v2.12',
                    },
                    runner: createRunner.mock.results[0]!.value,
                });
                expect(input.diagnosticPartialCoverageCapability).toBeTruthy();
                input.write(safeLine);
            }),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout,
        });

        expect(createRunner).toHaveBeenCalledOnce();
        expect(events).toEqual([
            'claim',
            'runner',
            'provider',
            'report',
            'cleanup',
            'stdout',
        ]);
    });

    it('downloads into one private temp directory and deletes authenticated inodes', async () => {
        const {
            loadReplayAnalysisV2JobArtifacts,
        } = await import('./replay-analysis-v2-job');
        const directory = await mkdtemp(join(tmpdir(), 'replay-job-'));
        await chmod(directory, 0o700);
        const bundlePath = join(directory, 'input.enc');
        const keyPath = join(directory, 'input.key');
        try {
            await createReplayKeyFile(keyPath);
            await writeReplayBundle({
                bundle: v212Bundle(),
                bundlePath,
                keyPath,
            });
            const ciphertext = await readFile(bundlePath);
            await unlink(bundlePath);
            const config = {
                ...validateConfigPaths(bundlePath, keyPath),
                bundleBytes: ciphertext.byteLength,
                bundleSha256:
                    createHash('sha256').update(ciphertext).digest('hex'),
            };
            const loaded = await loadReplayAnalysisV2JobArtifacts(config, {
                downloadBundle: vi.fn(async () => ciphertext),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            });

            expect((loaded.bundle as { schemaVersion: number }).schemaVersion)
                .toBe(2);
            await loaded.cleanup();
            await expect(access(bundlePath)).rejects.toThrow();
            await expect(access(keyPath)).rejects.toThrow();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.each([
        ['expired', { expired: true }],
        ['schema', { schemaVersion: 1 }],
        ['evaluation', {
            capture: {
                evaluationPolicy: {
                    capability: 'wrong',
                    aiStage: 'ai-stage-policy-v2.11',
                },
            },
        }],
    ])('rejects %s bundle before runner and cleans up', async (
        _name,
        override,
    ) => {
        const { runReplayAnalysisV2Job } = await import(
            './replay-analysis-v2-job'
        );
        const createRunner = vi.fn();
        const cleanup = vi.fn();
        const base = {
            ...v212Bundle(),
            expired: false,
        };
        const bundle = 'capture' in override
            ? { ...base, capture: { ...base.capture, ...override.capture } }
            : { ...base, ...override };

        await expect(runReplayAnalysisV2Job({
            env: validEnv(),
            loadArtifacts: vi.fn(async () => ({ bundle, cleanup })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            }),
            createRunner,
            runReplay: vi.fn(),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout: vi.fn(),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_JOB_BUNDLE_CAPABILITY_MISMATCH');
        expect(createRunner).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('rejects a non-aggregate report before upload and cleans up', async () => {
        const { runReplayAnalysisV2Job } = await import(
            './replay-analysis-v2-job'
        );
        const createReport = vi.fn();
        const cleanup = vi.fn();
        await expect(runReplayAnalysisV2Job({
            env: validEnv(),
            loadArtifacts: vi.fn(async () => ({
                bundle: { ...v212Bundle(), expired: false },
                cleanup,
            })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport,
            }),
            createRunner: vi.fn(() => Object.freeze({})),
            runReplay: vi.fn(async input => {
                input.write('{"status":"ok","unexpected_detail":"value"}');
            }),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout: vi.fn(),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
        expect(createReport).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('fails a claim collision before provider creation and still cleans up', async () => {
        const { runReplayAnalysisV2Job } = await import(
            './replay-analysis-v2-job'
        );
        const createRunner = vi.fn();
        const cleanup = vi.fn();

        await expect(runReplayAnalysisV2Job({
            env: validEnv(),
            loadArtifacts: vi.fn(async () => ({
                bundle: {
                    schemaVersion: 2,
                    capture: {
                        scope: 'ai-only-historical-partial-available',
                        sourceLineage: {
                            selectedPlanId: 'standard',
                            policyVersions: {
                                pipeline: 'v2',
                                aiStage: 'ai-stage-policy-v2.7',
                                risk: 'risk-policy-v2.3',
                            },
                        },
                        evaluationPolicy: {
                            capability:
                                'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality',
                            aiStage: 'ai-stage-policy-v2.12',
                        },
                    },
                    expired: false,
                },
                cleanup,
            })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(async () => {
                    throw new Error('ANALYSIS_V2_REPLAY_JOB_CLAIM_COLLISION');
                }),
                createReport: vi.fn(),
            }),
            createRunner,
            runReplay: vi.fn(),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout: vi.fn(),
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_JOB_CLAIM_COLLISION');

        expect(createRunner).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
    });
});

function validateConfigPaths(bundlePath: string, keyPath: string) {
    return {
        bundlePath,
        keyPath,
        bucket: 'replay-safe-output',
        bundleObject: 'inputs/bundle.enc',
        bundleGeneration: '123456789',
        bundleBytes: 1,
        bundleSha256: 'a'.repeat(64),
        claimObject: 'claims/claim-0123456789abcdef.json',
        reportObject: 'reports/report-0123456789abcdef.json',
    };
}
