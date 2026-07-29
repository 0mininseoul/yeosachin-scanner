import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
    access,
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    rename,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
    createReplayKeyFile,
    writeReplayBundle,
} from '../lib/services/analysis/replay/replay-bundle';
import { historicalPartialSourceUniverseDigest } from '../lib/services/analysis/replay/historical-partial-available-artifact';

const execFileAsync = promisify(execFile);
type NodeFileHandle = Awaited<ReturnType<typeof open>>;
const immutableImageDigest =
    `asia-northeast3-docker.pkg.dev/replay/jobs/analysis@sha256:${
        'a'.repeat(64)
    }`;

async function gateFileHandleStat(directory: string): Promise<{
    release: () => void;
    restore: () => void;
}> {
    const probePath = join(directory, 'file-handle-stat-probe');
    const probe = await open(probePath, 'wx', 0o600);
    const prototype = Object.getPrototypeOf(probe) as {
        stat: NodeFileHandle['stat'];
    };
    const originalStat = prototype.stat;
    await probe.close();
    await unlink(probePath);
    let release!: () => void;
    const gate = new Promise<void>(resolveGate => {
        release = resolveGate;
    });
    prototype.stat = (function (this: NodeFileHandle) {
        return gate.then(() => originalStat.call(this));
    }) as NodeFileHandle['stat'];
    return {
        release,
        restore: () => {
            prototype.stat = originalStat;
        },
    };
}

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
        ANALYSIS_V2_REPLAY_JOB_EXPECTED_IMAGE_DIGEST: immutableImageDigest,
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

function v213Bundle(now = Date.now()) {
    const bundle = v212Bundle(now);
    return {
        ...bundle,
        capture: {
            ...bundle.capture,
            evaluationPolicy: {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow' as const,
                aiStage: 'ai-stage-policy-v2.13' as const,
            },
        },
    };
}

async function actualV212SafeLine(): Promise<string> {
    const { runAnalysisV2AiReplay } = await import(
        '../lib/services/analysis/replay/replay-runner'
    );
    const lines: string[] = [];
    await runAnalysisV2AiReplay({
        bundle: v212Bundle(),
        mode: 'dry-run',
        evaluationPolicy: {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v212-gender-quality',
            aiStage: 'ai-stage-policy-v2.12',
        },
        write: line => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    return lines[0]!;
}

async function actualDiagnosticV212SafeLine(): Promise<string> {
    const actual = JSON.parse(await actualV212SafeLine());
    actual.diagnostic_partial_coverage_override = {
        used: true,
        retained_profiles: 49,
        source_profiles: 50,
        retained_media: 49,
        exact_selected_media: 50,
        profile_retention_bps: 9_800,
        media_retention_bps: 9_800,
    };
    return JSON.stringify(actual);
}

async function actualV213SafeLine(): Promise<string> {
    const { runAnalysisV2AiReplay } = await import(
        '../lib/services/analysis/replay/replay-runner'
    );
    const lines: string[] = [];
    await runAnalysisV2AiReplay({
        bundle: v213Bundle(),
        mode: 'dry-run',
        evaluationPolicy: {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow',
            aiStage: 'ai-stage-policy-v2.13',
        },
        write: line => lines.push(line),
    });
    expect(lines).toHaveLength(1);
    return lines[0]!;
}

async function actualDiagnosticV213SafeLine(): Promise<string> {
    const actual = JSON.parse(await actualV213SafeLine());
    actual.diagnostic_partial_coverage_override = {
        used: true,
        retained_profiles: 49,
        source_profiles: 50,
        retained_media: 49,
        exact_selected_media: 50,
        profile_retention_bps: 9_800,
        media_retention_bps: 9_800,
    };
    const missingPublic =
        actual.diagnostic_partial_coverage_override.source_profiles
        - actual.diagnostic_partial_coverage_override.retained_profiles;
    const observedTotal =
        actual.gender.male + actual.gender.female + actual.gender.unknown;
    const worstCaseUnknown = actual.gender.unknown + missingPublic;
    const worstCaseTotal = observedTotal + missingPublic;
    actual.gender_quality.shadow_rescue.missingPublic = missingPublic;
    actual.gender_quality.qualityGate.worstCaseUnknownRate =
        worstCaseTotal === 0
            ? 0
            : Number((worstCaseUnknown / worstCaseTotal).toFixed(4));
    actual.gender_quality.qualityGate.worstCasePass =
        worstCaseUnknown * 5 <= worstCaseTotal;
    return JSON.stringify(actual);
}

async function actualDiagnosticV216SafeLine(): Promise<string> {
    const actual = JSON.parse(await actualDiagnosticV213SafeLine());
    actual.evaluation_ai_policy = 'ai-stage-policy-v2.16';
    actual.replay_ai_policy = 'ai-stage-policy-v2.16';
    const emptyCohort = () => ({
        eligible: 0,
        attempted: 0,
        rescuedMale: 0,
        rescuedFemale: 0,
        unresolved: 0,
        providerNonOk: {
            rateLimited: 0,
            retryExhausted: 0,
            rejected: 0,
            failed: 0,
            capacitySkipped: 0,
        },
    });
    actual.gender_quality.shadow_rescue.admissionCohorts = {
        resolverMediaAtLeast2: emptyCohort(),
        singleProfileOnly: emptyCohort(),
    };
    return JSON.stringify(actual);
}

async function actualDiagnosticV217SafeLine(): Promise<string> {
    const actual = JSON.parse(await actualDiagnosticV212SafeLine());
    actual.evaluation_ai_policy = 'ai-stage-policy-v2.17';
    actual.replay_ai_policy = 'ai-stage-policy-v2.17';
    actual.gender_quality.qualityGate = {
        observedUnknownRate: 0,
        worstCaseUnknownRate: 1,
        observedPass: true,
        worstCasePass: false,
    };
    actual.public_name_fusion = {
        publicAnalyzed: 0,
        providerOk: true,
        calibration: {
            known: 0,
            predicted: 0,
            agreed: 0,
            disagreed: 0,
            male: { known: 0, predicted: 0, agreed: 0, disagreed: 0 },
            female: { known: 0, predicted: 0, agreed: 0, disagreed: 0 },
        },
        officialNegative: { known: 0, fusionAccepted: 0 },
        unknown: {
            eligible: 0,
            predicted: 0,
            rescuedMale: 0,
            rescuedFemale: 0,
            unresolved: 0,
        },
        baseline: { male: 0, female: 0, unknown: 0 },
        final: { male: 0, female: 0, unknown: 0 },
        missingPublic: 1,
        gates: {
            calibrationVolumePass: false,
            overallAgreementPass: false,
            maleVolumePass: false,
            maleAgreementPass: false,
            femaleVolumePass: false,
            femaleAgreementPass: false,
            officialNegativePass: true,
            observedUnknownRate: 0,
            observedUnknownPass: true,
            worstCaseUnknownRate: 1,
            worstCaseUnknownPass: false,
            adoptionPass: false,
        },
    };
    return JSON.stringify(actual);
}

interface V213TerminalReportFixture {
    diagnostic_partial_coverage_override: {
        retained_profiles: number;
    };
    gender: {
        female: number;
    };
    stages: {
        featureAnalysisShadowRescue: {
            calls: number;
        };
    };
    gender_quality: {
        qualityGate: {
            worstCaseUnknownRate: number;
            worstCasePass: boolean;
        };
        shadow_rescue: {
            [key: string]: unknown;
            baselineUnknown: number;
            insufficientMedia: number;
            eligible: number;
            unresolved: number;
            finalFemale: number;
            missingPublic: number;
        };
    };
}

interface V217TerminalReportFixture {
    public_name_fusion: {
        unknown: Record<string, unknown>;
        final: { unknown: number };
        gates: { adoptionPass: boolean };
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
        'GOOGLE_API_KEY',
        'GEMINI_API_KEY',
        'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET',
        'IMAGE_PROXY_SIGNING_SECRET',
        'DATABASE_URL',
        'DB_PASSWORD',
        'UNRELATED_SECRET',
        'UNRELATED_PASSWORD',
        'UNRELATED_TOKEN',
        'POSTGRES_URL',
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

    it('rejects a runtime image digest mismatch before GCS or provider creation', async () => {
        const { runReplayAnalysisV2Job } = await import(
            './replay-analysis-v2-job'
        );
        const createGcsClient = vi.fn();
        const createRunner = vi.fn();

        await expect(runReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest:
                `asia-northeast3-docker.pkg.dev/replay/jobs/analysis@sha256:${
                    'b'.repeat(64)
                }`,
            createGcsClient,
            createRunner,
        })).rejects.toThrow(
            'ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST_MISMATCH',
        );
        expect(createGcsClient).not.toHaveBeenCalled();
        expect(createRunner).not.toHaveBeenCalled();
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
            expect(line).toBe(`${safeLine}\n`);
        });
        const cleanup = vi.fn(async () => { events.push('cleanup'); });
        const safeLine = await actualDiagnosticV213SafeLine();

        await runReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
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
                                'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow',
                            aiStage: 'ai-stage-policy-v2.13',
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
                        aiStage: 'ai-stage-policy-v2.13',
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
        expect(createRunner).toHaveBeenCalledWith('ai-stage-policy-v2.13');
        expect(events).toEqual([
            'claim',
            'runner',
            'provider',
            'report',
            'cleanup',
            'stdout',
        ]);
    });

    it('runs the V2.14 job only with its own authenticated feature-model shadow bundle', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
            runV214ReplayAnalysisV2Job,
        } = await import(
            './replay-analysis-v214-job'
        );
        const v214Bundle = v213Bundle();
        v214Bundle.capture.evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v214-feature-model-shadow',
            aiStage: 'ai-stage-policy-v2.14',
        } as never;
        const safe = JSON.parse(await actualDiagnosticV213SafeLine());
        safe.evaluation_ai_policy = 'ai-stage-policy-v2.14';
        safe.replay_ai_policy = 'ai-stage-policy-v2.14';
        const createRunner = vi.fn(() => Object.freeze({}));

        await runV214ReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
            loadArtifacts: vi.fn(async () => ({
                bundle: { ...v214Bundle, expired: false },
                cleanup: async () => undefined,
            })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            }),
            createRunner,
            runReplay: vi.fn(async input => {
                expect(input.evaluationPolicy).toEqual(
                    REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
                );
                input.write(JSON.stringify(safe));
            }),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout: vi.fn(),
        });

        expect(createRunner).toHaveBeenCalledWith('ai-stage-policy-v2.14');
    });

    it('runs the V2.15 job only with its own authenticated output-cap shadow bundle', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
            runV215ReplayAnalysisV2Job,
        } = await import(
            './replay-analysis-v215-job'
        );
        const v215Bundle = v213Bundle();
        v215Bundle.capture.evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v215-feature-output-cap-shadow',
            aiStage: 'ai-stage-policy-v2.15',
        } as never;
        const safe = JSON.parse(await actualDiagnosticV213SafeLine());
        safe.evaluation_ai_policy = 'ai-stage-policy-v2.15';
        safe.replay_ai_policy = 'ai-stage-policy-v2.15';
        const createRunner = vi.fn(() => Object.freeze({}));

        await runV215ReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
            loadArtifacts: vi.fn(async () => ({
                bundle: { ...v215Bundle, expired: false },
                cleanup: async () => undefined,
            })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            }),
            createRunner,
            runReplay: vi.fn(async input => {
                expect(input.evaluationPolicy).toEqual(
                    REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
                );
                input.write(JSON.stringify(safe));
            }),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout: vi.fn(),
        });

        expect(createRunner).toHaveBeenCalledWith('ai-stage-policy-v2.15');
    });

    it('runs the V2.16 job only with its authenticated admission shadow bundle', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
            runV216ReplayAnalysisV2Job,
        } = await import(
            './replay-analysis-v216-job'
        );
        const v216Bundle = v213Bundle();
        v216Bundle.capture.evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v216-single-profile-admission-shadow',
            aiStage: 'ai-stage-policy-v2.16',
        } as never;
        const createRunner = vi.fn(() => Object.freeze({}));

        await runV216ReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
            loadArtifacts: vi.fn(async () => ({
                bundle: { ...v216Bundle, expired: false },
                cleanup: async () => undefined,
            })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            }),
            createRunner,
            runReplay: vi.fn(async input => {
                expect(input.evaluationPolicy).toEqual(
                    REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
                );
                input.write(await actualDiagnosticV216SafeLine());
            }),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout: vi.fn(),
        });

        expect(createRunner).toHaveBeenCalledWith('ai-stage-policy-v2.16');
    });

    it('runs the V2.17 job only with its authenticated public name fusion bundle', async () => {
        const {
            REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
            runV217ReplayAnalysisV2Job,
        } = await import(
            './replay-analysis-v217-job'
        );
        const v217Bundle = v213Bundle();
        v217Bundle.capture.evaluationPolicy = {
            capability:
                'historical-partial-available-standard-v27-risk-v23-to-ai-v217-public-name-visual-fusion-shadow',
            aiStage: 'ai-stage-policy-v2.17',
        } as never;
        const createRunner = vi.fn(() => Object.freeze({}));

        await runV217ReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
            loadArtifacts: vi.fn(async () => ({
                bundle: { ...v217Bundle, expired: false },
                cleanup: async () => undefined,
            })),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            }),
            createRunner,
            runReplay: vi.fn(async input => {
                expect(input.evaluationPolicy).toEqual(
                    REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY,
                );
                input.write(await actualDiagnosticV217SafeLine());
            }),
            installSignalCleanup: vi.fn(() => () => undefined),
            writeStdout: vi.fn(),
        });

        expect(createRunner).toHaveBeenCalledWith('ai-stage-policy-v2.17');
    });

    it('accepts the actual v2.12 diagnostic partial-coverage safe-line key', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const {
            validateReplayAnalysisV2JobTerminalLine: gcsValidator,
        } = await import(
            '../lib/services/analysis/replay/replay-job-gcs'
        );
        const raw = await actualDiagnosticV212SafeLine();

        expect(validateReplayAnalysisV2JobTerminalLine).toBe(gcsValidator);
        expect(validateReplayAnalysisV2JobTerminalLine(raw)).toBe(raw);
    });

    it('accepts the complete replay runner aggregate category sets', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const {
            REPLAY_STAGE_FAILURE_DISPOSITIONS,
        } = await import(
            '../lib/services/analysis/replay/replay-runner'
        );
        const actual = JSON.parse(await actualDiagnosticV212SafeLine());
        actual.stages.genderTriage.failure_disposition =
            Object.fromEntries(REPLAY_STAGE_FAILURE_DISPOSITIONS.map(
                disposition => [disposition, 1],
            ));
        actual.stages.genderTriage.failure_kind = {
            http_408: 1,
            http_429: 1,
            http_4xx: 1,
            http_5xx: 1,
            transport: 1,
            unknown_sdk: 1,
        };
        actual.gender_quality.triage.outcome = {
            ok: 1,
            rate_limited: 1,
            retry_exhausted: 1,
            rejected: 1,
            failed: 1,
            capacity_skipped: 1,
        };
        actual.gender_quality.triage.source = {
            checkpoint: 1,
            safe_fallback: 1,
            unknown: 1,
            non_ok: 1,
        };
        actual.gender_quality.triage.genderConfidence = {
            'female:low': 1,
            'female:medium': 1,
            'female:high': 1,
            'male:low': 1,
            'male:medium': 1,
            'male:high': 1,
            'unknown:low': 1,
            'unknown:medium': 1,
            'unknown:high': 1,
        };
        actual.gender_quality.triage.accountContext = {
            personal: 1,
            individual_creator: 1,
            official_group_or_brand: 1,
            uncertain: 1,
            absent: 1,
        };
        actual.gender_quality.feature.admission = {
            eligible: 1,
            nonpersonal_or_official: 1,
            unsupported_unknown: 1,
        };
        actual.gender_quality.feature.finalDecision = {
            verified_female: 1,
            verified_non_female: 1,
            unresolved: 1,
            unresolved_stage_conflict: 1,
        };
        actual.gender_quality.feature.accountContext = {
            personal: 1,
            individual_creator: 1,
            official_group_or_brand: 1,
            uncertain: 1,
        };
        actual.gender_quality.feature.routeTerminal = {
            not_routed_high_male: 1,
            excluded_official: 1,
            completed: 1,
            provider_non_ok: 1,
            triage_non_ok: 1,
        };
        actual.gender_quality.resolver.outcome = {
            official_excluded: 1,
            cutoff: 1,
            ok: 1,
            rate_limited: 1,
            retry_exhausted: 1,
            rejected: 1,
            failed: 1,
            capacity_skipped: 1,
        };
        actual.gender_quality.finalClassificationSource = {
            triage: 1,
            feature: 1,
            gender_resolution: 1,
            unknown: 1,
            unavailable: 1,
            triage_non_ok: 1,
        };
        actual.gender_quality.headroom = {
            finalUnknownWithResolverMediaAtLeast2: 1,
            highBinaryFeatureUnresolvedPersonalOrIndividualCreatorWithResolverMediaAtLeast2: 1,
            featureUnresolvedWithUncertainAccountContext: 1,
            capacitySkippedFinalUnknown: 1,
            earlyResolverReadyFeatureFinalKnown: 1,
        };
        const raw = JSON.stringify(actual);

        expect(validateReplayAnalysisV2JobTerminalLine(raw)).toBe(raw);
    });

    it.each([
        'private_handle',
        'victim.handle',
        'somehandle',
    ])('independently rejects terminal report key variant %s', async key => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualDiagnosticV212SafeLine());
        actual[key] = 1;

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    });

    it.each([
        ['stage disposition', ['stages', 'genderTriage', 'failure_disposition']],
        ['stage failure kind', ['stages', 'genderTriage', 'failure_kind']],
        ['triage outcome', ['gender_quality', 'triage', 'outcome']],
        ['triage source', ['gender_quality', 'triage', 'source']],
        ['triage confidence', ['gender_quality', 'triage', 'genderConfidence']],
        ['triage context', ['gender_quality', 'triage', 'accountContext']],
        ['feature admission', ['gender_quality', 'feature', 'admission']],
        ['feature decision', ['gender_quality', 'feature', 'finalDecision']],
        ['feature context', ['gender_quality', 'feature', 'accountContext']],
        ['feature terminal', ['gender_quality', 'feature', 'routeTerminal']],
        ['resolver outcome', ['gender_quality', 'resolver', 'outcome']],
        ['final source', ['gender_quality', 'finalClassificationSource']],
        ['resolver headroom', ['gender_quality', 'headroom']],
    ])('rejects handle-like aggregate keys in %s', async (
        _name,
        path,
    ) => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        for (const key of [
            'handle', 'name', 'bio', 'url', 'mediaId', 'rawEvidence', 'terminal',
        ]) {
            const actual = JSON.parse(
                await actualDiagnosticV212SafeLine(),
            );
            let target = actual;
            for (const segment of path) target = target[segment];
            target[key] = 1;

            expect(() => validateReplayAnalysisV2JobTerminalLine(
                JSON.stringify(actual),
            )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
        }
    });

    it.each([
        ['benchmark scope', (report: Record<string, unknown>) => {
            report.benchmark_scope = 'ai-only-exact-replay';
        }],
        ['source plan', (report: Record<string, unknown>) => {
            report.source_plan = 'plus';
        }],
        ['source pipeline', (report: Record<string, unknown>) => {
            report.source_pipeline = 'v3';
        }],
        ['source AI', (report: Record<string, unknown>) => {
            report.source_ai_policy = 'ai-stage-policy-v2.8';
        }],
        ['source risk', (report: Record<string, unknown>) => {
            report.source_risk_policy = 'risk-policy-v2.4';
        }],
        ['evaluation AI', (report: Record<string, unknown>) => {
            report.evaluation_ai_policy = null;
        }],
        ['replay AI', (report: Record<string, unknown>) => {
            report.replay_ai_policy = 'ai-stage-policy-v2.11';
        }],
        ['not exact', (report: Record<string, unknown>) => {
            delete report.not_exact;
        }],
        ['media substitution', (report: Record<string, unknown>) => {
            delete report.no_media_substitution;
        }],
        ['diagnostic override', (report: Record<string, unknown>) => {
            delete report.diagnostic_partial_coverage_override;
        }],
    ] as const)('rejects replay job provenance drift: %s', async (
        _name,
        mutate,
    ) => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualDiagnosticV212SafeLine());
        mutate(actual);

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    });

    it('rejects PII-shaped nested fields even when the top-level report is valid', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualV212SafeLine());
        actual.gender.label = 'private-person';

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    });

    it('accepts the strict V2.13 shadow-rescue aggregate report', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const line = await actualDiagnosticV213SafeLine();

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            line,
        )).not.toThrow();
    });

    it('accepts the same strict PII-free shadow-rescue report contract for V2.14', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualDiagnosticV213SafeLine());
        actual.evaluation_ai_policy = 'ai-stage-policy-v2.14';
        actual.replay_ai_policy = 'ai-stage-policy-v2.14';

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).not.toThrow();
    });

    it('accepts the same strict PII-free shadow-rescue report contract for V2.15', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualDiagnosticV213SafeLine());
        actual.evaluation_ai_policy = 'ai-stage-policy-v2.15';
        actual.replay_ai_policy = 'ai-stage-policy-v2.15';

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).not.toThrow();
    });

    it('accepts only the strict PII-free V2.17 public name fusion aggregate contract', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const line = await actualDiagnosticV217SafeLine();

        expect(validateReplayAnalysisV2JobTerminalLine(line)).toBe(line);
        const mutations: Array<(
            report: V217TerminalReportFixture,
        ) => void> = [
            report => {
                report.public_name_fusion.unknown.username = 'private';
            },
            report => {
                report.public_name_fusion.final.unknown += 1;
            },
            report => {
                report.public_name_fusion.gates.adoptionPass = true;
            },
        ];
        for (const mutate of mutations) {
            const report = JSON.parse(line) as V217TerminalReportFixture;
            mutate(report);
            expect(() => validateReplayAnalysisV2JobTerminalLine(
                JSON.stringify(report),
            )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
        }
    });

    it('rejects V2.15 shadow-rescue conservation drift', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(
            await actualDiagnosticV213SafeLine(),
        ) as V213TerminalReportFixture & {
            evaluation_ai_policy: string;
            replay_ai_policy: string;
        };
        actual.evaluation_ai_policy = 'ai-stage-policy-v2.15';
        actual.replay_ai_policy = 'ai-stage-policy-v2.15';
        actual.gender_quality.shadow_rescue.baselineUnknown += 1;

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    });

    it('accepts the strict V2.16 admission cohort conservation contract', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualDiagnosticV213SafeLine());
        actual.evaluation_ai_policy = 'ai-stage-policy-v2.16';
        actual.replay_ai_policy = 'ai-stage-policy-v2.16';
        actual.gender_quality.shadow_rescue.admissionCohorts = {
            resolverMediaAtLeast2: {
                eligible: 0,
                attempted: 0,
                rescuedMale: 0,
                rescuedFemale: 0,
                unresolved: 0,
                providerNonOk: {
                    rateLimited: 0,
                    retryExhausted: 0,
                    rejected: 0,
                    failed: 0,
                    capacitySkipped: 0,
                },
            },
            singleProfileOnly: {
                eligible: 0,
                attempted: 0,
                rescuedMale: 0,
                rescuedFemale: 0,
                unresolved: 0,
                providerNonOk: {
                    rateLimited: 0,
                    retryExhausted: 0,
                    rejected: 0,
                    failed: 0,
                    capacitySkipped: 0,
                },
            },
        };

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).not.toThrow();
    });

    it('rejects V2.16 admission cohort drift', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualDiagnosticV213SafeLine());
        actual.evaluation_ai_policy = 'ai-stage-policy-v2.16';
        actual.replay_ai_policy = 'ai-stage-policy-v2.16';
        actual.gender_quality.shadow_rescue.admissionCohorts = {
            resolverMediaAtLeast2: {
                eligible: 0,
                attempted: 0,
                rescuedMale: 0,
                rescuedFemale: 0,
                unresolved: 0,
                providerNonOk: {
                    rateLimited: 0,
                    retryExhausted: 0,
                    rejected: 0,
                    failed: 0,
                    capacitySkipped: 0,
                },
            },
            singleProfileOnly: {
                eligible: 1,
                attempted: 0,
                rescuedMale: 0,
                rescuedFemale: 0,
                unresolved: 0,
                providerNonOk: {
                    rateLimited: 0,
                    retryExhausted: 0,
                    rejected: 0,
                    failed: 0,
                    capacitySkipped: 0,
                },
            },
        };

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    });

    it('accepts a V2.13 worst-case gate derived from final counts and missing public', async () => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(
            await actualDiagnosticV213SafeLine(),
        ) as V213TerminalReportFixture;
        expect(actual.gender_quality.shadow_rescue.missingPublic).toBe(1);
        expect(actual.gender_quality.qualityGate).toMatchObject({
            worstCaseUnknownRate: 1,
            worstCasePass: false,
        });

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).not.toThrow();
    });

    it.each([
        ['baseline conservation', (report: V213TerminalReportFixture) => {
            report.gender_quality.shadow_rescue.baselineUnknown += 1;
        }],
        ['cohort partition', (report: V213TerminalReportFixture) => {
            report.gender_quality.shadow_rescue.insufficientMedia += 1;
        }],
        ['eligible attempted equality', (report: V213TerminalReportFixture) => {
            report.gender_quality.shadow_rescue.eligible += 1;
        }],
        ['attempt outcome partition', (report: V213TerminalReportFixture) => {
            report.gender_quality.shadow_rescue.unresolved += 1;
        }],
        ['final arithmetic', (report: V213TerminalReportFixture) => {
            report.gender_quality.shadow_rescue.finalFemale += 1;
        }],
        ['report gender equality', (report: V213TerminalReportFixture) => {
            report.gender.female += 1;
        }],
        ['provider dispatch bound', (report: V213TerminalReportFixture) => {
            report.stages.featureAnalysisShadowRescue.calls = 1;
        }],
        ['worst-case unknown rate', (report: V213TerminalReportFixture) => {
            report.gender_quality.qualityGate.worstCaseUnknownRate = 0.5;
        }],
        ['worst-case pass', (report: V213TerminalReportFixture) => {
            report.gender_quality.qualityGate.worstCasePass =
                !report.gender_quality.qualityGate.worstCasePass;
        }],
        ['missing-public provenance', (report: V213TerminalReportFixture) => {
            report.gender_quality.shadow_rescue.missingPublic = 0;
            report.gender_quality.qualityGate.worstCaseUnknownRate = 0;
            report.gender_quality.qualityGate.worstCasePass = true;
        }],
        ['retained-profile provenance', (report: V213TerminalReportFixture) => {
            report.diagnostic_partial_coverage_override.retained_profiles -= 1;
        }],
        ['nested PII', (report: V213TerminalReportFixture) => {
            report.gender_quality.shadow_rescue.account = 'private-person';
        }],
    ] as const)('rejects V2.13 shadow-rescue report drift: %s', async (
        _name,
        mutate,
    ) => {
        const {
            validateReplayAnalysisV2JobTerminalLine,
        } = await import('./replay-analysis-v2-job');
        const actual = JSON.parse(await actualDiagnosticV213SafeLine());
        mutate(actual);

        expect(() => validateReplayAnalysisV2JobTerminalLine(
            JSON.stringify(actual),
        )).toThrow('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    });

    it('boots the real ESM artifact from a platform-native physical dependency closure', async () => {
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            '.replay-job-image-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const outputDirectory = join(workspace, 'replay-job');
        const outfile = join(outputDirectory, 'job.mjs');
        const metafile = join(outputDirectory, 'meta.json');
        const runtimeManifest = join(outputDirectory, 'runtime.json');
        try {
            await mkdir(workspace, { mode: 0o700 });
            const {
                copyReplayAnalysisV2JobPhysicalDependencyClosure,
                createReplayAnalysisV2JobContainerLaunchContract,
                verifyReplayAnalysisV2JobContainerFilesystem,
                verifyReplayAnalysisV2JobRuntimeManifest,
            } = await import('./build-replay-analysis-v2-job.mjs');
            const closure =
                await copyReplayAnalysisV2JobPhysicalDependencyClosure({
                    sourceWorkspace: process.cwd(),
                    imageWorkspace: workspace,
                });
            expect(closure).toMatchObject({
                platform: process.platform,
                arch: process.arch,
            });
            expect(closure.packages.length).toBeGreaterThanOrEqual(45);
            expect((await lstat(join(workspace, 'node_modules')))
                .isSymbolicLink()).toBe(false);
            await execFileAsync(process.execPath, [
                'scripts/build-replay-analysis-v2-job.mjs',
                '--outfile',
                outfile,
                '--metafile',
                metafile,
                '--runtime-manifest',
                runtimeManifest,
                '--image-digest',
                immutableImageDigest,
            ], {
                cwd: process.cwd(),
                env: {
                    NODE_ENV: 'test',
                    PATH: process.env.PATH,
                },
            });
            const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
                inputs: Record<string, unknown>;
            };
            expect(metadata.inputs).toHaveProperty(
                'scripts/replay-analysis-v2-job.ts',
            );
            expect(metadata.inputs).not.toHaveProperty(
                'scripts/replay-analysis-v214-job.ts',
            );
            expect(metadata.inputs).not.toHaveProperty(
                'scripts/replay-analysis-v215-job.ts',
            );
            expect(metadata.inputs).not.toHaveProperty(
                'scripts/replay-analysis-v216-job.ts',
            );
            const runtime = JSON.parse(await readFile(
                runtimeManifest,
                'utf8',
            ));
            const lockfile = JSON.parse(await readFile(
                join(process.cwd(), 'package-lock.json'),
                'utf8',
            ));
            expect(() => verifyReplayAnalysisV2JobRuntimeManifest(
                runtime,
                lockfile,
                immutableImageDigest,
            )).not.toThrow();
            const contract =
                createReplayAnalysisV2JobContainerLaunchContract({
                    imageDigest: immutableImageDigest,
                    entrypoint: '/workspace/replay-job/job.mjs',
                });
            await expect(
                verifyReplayAnalysisV2JobContainerFilesystem({
                    imageRoot,
                    contract,
                    manifest: runtime,
                }),
            ).resolves.toBeUndefined();
            expect(Object.keys(metadata.inputs)).toHaveLength(41);
            const graph = JSON.stringify(metadata);
            expect(graph).not.toMatch(
                /supabase\/admin|supabase-js|result-store|attempt-store|lease-store|apify|(?:^|[/_-])r2(?:[/_.-]|$)|@google-cloud\/tasks|cloud-tasks|analysis-tasks|tasks-client|tasks-store|app\/api/i,
            );
            expect(runtime).toMatchObject({
                node: '24.x',
                conditions: ['react-server'],
                externalPackages: {
                    '@google/genai': { version: '2.7.0' },
                    sharp: { version: '0.35.3' },
                    zod: { version: '4.3.6' },
                },
            });
            for (const path of [outfile, metafile, runtimeManifest]) {
                expect((await lstat(path)).mode & 0o777).toBe(0o600);
            }

            const boot = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                outfile,
            ], {
                cwd: workspace,
                env: {
                    NODE_ENV: 'test',
                    PATH: process.env.PATH,
                },
            }).then(() => {
                throw new Error('Expected replay job boot to fail closed');
            }).catch(error => error as {
                code: number;
                stdout: string;
                stderr: string;
            });
            expect(boot.code).toBe(1);
            expect(boot.stdout).toBe('');
            expect(boot.stderr).toBe(
                '{"status":"failed","errorCode":"ANALYSIS_V2_REPLAY_JOB_TASK_CONFIGURATION_INVALID"}\n',
            );
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    }, 30_000);

    it('builds and boots the immutable V2.14 entry instead of the V2.13 default entry', async () => {
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            '.replay-job-v214-image-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const outputDirectory = join(workspace, 'replay-job');
        const outfile = join(outputDirectory, 'job.mjs');
        const metafile = join(outputDirectory, 'meta.json');
        const runtimeManifest = join(outputDirectory, 'runtime.json');
        try {
            await mkdir(workspace, { mode: 0o700 });
            const {
                copyReplayAnalysisV2JobPhysicalDependencyClosure,
            } = await import('./build-replay-analysis-v2-job.mjs');
            await copyReplayAnalysisV2JobPhysicalDependencyClosure({
                sourceWorkspace: process.cwd(),
                imageWorkspace: workspace,
            });
            await execFileAsync(process.execPath, [
                'scripts/build-replay-analysis-v2-job.mjs',
                '--outfile', outfile,
                '--metafile', metafile,
                '--runtime-manifest', runtimeManifest,
                '--image-digest', immutableImageDigest,
                '--evaluation-ai-policy=ai-stage-policy-v2.14',
            ], {
                cwd: process.cwd(),
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
                inputs: Record<string, unknown>;
            };
            expect(metadata.inputs).toHaveProperty(
                'scripts/replay-analysis-v214-job.ts',
            );
            const marker = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                '--eval',
                `import(${JSON.stringify(pathToFileURL(outfile).href)}).then(m => process.stdout.write(m.REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY.aiStage))`,
            ], {
                cwd: workspace,
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            expect(marker.stdout).toBe('ai-stage-policy-v2.14');

            const loaded = await import(
                `${pathToFileURL(outfile).href}?bootstrap-contract`
            );
            const runBuiltJob: unknown = Reflect.get(
                loaded,
                'runReplayAnalysisV2Job',
            );
            expect(runBuiltJob).toBeTypeOf('function');
            if (typeof runBuiltJob !== 'function') {
                throw new Error('V2.14 common bootstrap export missing');
            }
            const v214Bundle = v213Bundle();
            v214Bundle.capture.evaluationPolicy = {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v214-feature-model-shadow',
                aiStage: 'ai-stage-policy-v2.14',
            } as never;
            const safe = JSON.parse(await actualDiagnosticV213SafeLine());
            safe.evaluation_ai_policy = 'ai-stage-policy-v2.14';
            safe.replay_ai_policy = 'ai-stage-policy-v2.14';
            const createRunner = vi.fn(() => Object.freeze({}));
            await runBuiltJob({
                env: validEnv(),
                runtimeImageDigest: immutableImageDigest,
                bindLocalCleanup: () => async () => undefined,
                loadArtifacts: async () => ({
                    bundle: { ...v214Bundle, expired: false },
                    cleanup: async () => undefined,
                }),
                createGcsClient: () => ({
                    downloadBundle: vi.fn(),
                    createClaim: vi.fn(),
                    createReport: vi.fn(),
                }),
                createRunner,
                runReplay: async (input: {
                    evaluationPolicy: { aiStage: string };
                    write(line: string): void;
                }) => {
                    expect(input.evaluationPolicy.aiStage).toBe(
                        'ai-stage-policy-v2.14',
                    );
                    input.write(JSON.stringify(safe));
                },
                installSignalCleanup: () => () => undefined,
                writeStdout: vi.fn(),
            });
            expect(createRunner).toHaveBeenCalledOnce();
            expect(createRunner).toHaveBeenCalledWith(
                'ai-stage-policy-v2.14',
            );

            const boot = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                outfile,
            ], {
                cwd: workspace,
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            }).then(() => {
                throw new Error('Expected V2.14 replay job boot to fail closed');
            }).catch(error => error as { code: number; stderr: string });
            expect(boot.code).toBe(1);
            expect(boot.stderr).toBe(
                '{"status":"failed","errorCode":"ANALYSIS_V2_REPLAY_JOB_TASK_CONFIGURATION_INVALID"}\n',
            );
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    }, 30_000);

    it('builds and invokes the immutable V2.15 common bootstrap entry', async () => {
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            '.replay-job-v215-image-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const outputDirectory = join(workspace, 'replay-job');
        const outfile = join(outputDirectory, 'job.mjs');
        const metafile = join(outputDirectory, 'meta.json');
        const runtimeManifest = join(outputDirectory, 'runtime.json');
        try {
            await mkdir(workspace, { mode: 0o700 });
            const {
                copyReplayAnalysisV2JobPhysicalDependencyClosure,
            } = await import('./build-replay-analysis-v2-job.mjs');
            await copyReplayAnalysisV2JobPhysicalDependencyClosure({
                sourceWorkspace: process.cwd(),
                imageWorkspace: workspace,
            });
            await execFileAsync(process.execPath, [
                'scripts/build-replay-analysis-v2-job.mjs',
                '--outfile', outfile,
                '--metafile', metafile,
                '--runtime-manifest', runtimeManifest,
                '--image-digest', immutableImageDigest,
                '--evaluation-ai-policy=ai-stage-policy-v2.15',
            ], {
                cwd: process.cwd(),
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
                inputs: Record<string, unknown>;
            };
            expect(metadata.inputs).toHaveProperty(
                'scripts/replay-analysis-v215-job.ts',
            );
            expect(metadata.inputs).not.toHaveProperty(
                'scripts/replay-analysis-v214-job.ts',
            );
            const marker = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                '--eval',
                `import(${JSON.stringify(pathToFileURL(outfile).href)}).then(m => process.stdout.write(m.REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY.aiStage))`,
            ], {
                cwd: workspace,
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            expect(marker.stdout).toBe('ai-stage-policy-v2.15');

            const loaded = await import(
                `${pathToFileURL(outfile).href}?bootstrap-v215-contract`
            );
            const runBuiltJob: unknown = Reflect.get(
                loaded,
                'runReplayAnalysisV2Job',
            );
            expect(runBuiltJob).toBeTypeOf('function');
            if (typeof runBuiltJob !== 'function') {
                throw new Error('V2.15 common bootstrap export missing');
            }
            const v215Bundle = v213Bundle();
            v215Bundle.capture.evaluationPolicy = {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v215-feature-output-cap-shadow',
                aiStage: 'ai-stage-policy-v2.15',
            } as never;
            const safe = JSON.parse(await actualDiagnosticV213SafeLine());
            safe.evaluation_ai_policy = 'ai-stage-policy-v2.15';
            safe.replay_ai_policy = 'ai-stage-policy-v2.15';
            const createRunner = vi.fn(() => Object.freeze({}));
            await runBuiltJob({
                env: validEnv(),
                runtimeImageDigest: immutableImageDigest,
                bindLocalCleanup: () => async () => undefined,
                loadArtifacts: async () => ({
                    bundle: { ...v215Bundle, expired: false },
                    cleanup: async () => undefined,
                }),
                createGcsClient: () => ({
                    downloadBundle: vi.fn(),
                    createClaim: vi.fn(),
                    createReport: vi.fn(),
                }),
                createRunner,
                runReplay: async (input: {
                    evaluationPolicy: { aiStage: string };
                    write(line: string): void;
                }) => {
                    expect(input.evaluationPolicy.aiStage).toBe(
                        'ai-stage-policy-v2.15',
                    );
                    input.write(JSON.stringify(safe));
                },
                installSignalCleanup: () => () => undefined,
                writeStdout: vi.fn(),
            });
            expect(createRunner).toHaveBeenCalledOnce();
            expect(createRunner).toHaveBeenCalledWith(
                'ai-stage-policy-v2.15',
            );

            const boot = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                outfile,
            ], {
                cwd: workspace,
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            }).then(() => {
                throw new Error('Expected V2.15 replay job boot to fail closed');
            }).catch(error => error as { code: number; stderr: string });
            expect(boot.code).toBe(1);
            expect(boot.stderr).toBe(
                '{"status":"failed","errorCode":"ANALYSIS_V2_REPLAY_JOB_TASK_CONFIGURATION_INVALID"}\n',
            );
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    }, 30_000);

    it('builds and invokes the immutable V2.16 common bootstrap entry', async () => {
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            '.replay-job-v216-image-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const outputDirectory = join(workspace, 'replay-job');
        const outfile = join(outputDirectory, 'job.mjs');
        const metafile = join(outputDirectory, 'meta.json');
        const runtimeManifest = join(outputDirectory, 'runtime.json');
        try {
            await mkdir(workspace, { mode: 0o700 });
            const {
                copyReplayAnalysisV2JobPhysicalDependencyClosure,
            } = await import('./build-replay-analysis-v2-job.mjs');
            await copyReplayAnalysisV2JobPhysicalDependencyClosure({
                sourceWorkspace: process.cwd(),
                imageWorkspace: workspace,
            });
            await execFileAsync(process.execPath, [
                'scripts/build-replay-analysis-v2-job.mjs',
                '--outfile', outfile,
                '--metafile', metafile,
                '--runtime-manifest', runtimeManifest,
                '--image-digest', immutableImageDigest,
                '--evaluation-ai-policy=ai-stage-policy-v2.16',
            ], {
                cwd: process.cwd(),
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
                inputs: Record<string, unknown>;
            };
            expect(metadata.inputs).toHaveProperty(
                'scripts/replay-analysis-v216-job.ts',
            );
            expect(metadata.inputs).not.toHaveProperty(
                'scripts/replay-analysis-v214-job.ts',
            );
            expect(metadata.inputs).not.toHaveProperty(
                'scripts/replay-analysis-v215-job.ts',
            );
            const marker = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                '--eval',
                `import(${JSON.stringify(pathToFileURL(outfile).href)}).then(m => process.stdout.write(m.REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY.aiStage))`,
            ], {
                cwd: workspace,
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            expect(marker.stdout).toBe('ai-stage-policy-v2.16');

            const loaded = await import(
                `${pathToFileURL(outfile).href}?bootstrap-v216-contract`
            );
            const runBuiltJob: unknown = Reflect.get(
                loaded,
                'runReplayAnalysisV2Job',
            );
            expect(runBuiltJob).toBeTypeOf('function');
            if (typeof runBuiltJob !== 'function') {
                throw new Error('V2.16 common bootstrap export missing');
            }
            const v216Bundle = v213Bundle();
            v216Bundle.capture.evaluationPolicy = {
                capability:
                    'historical-partial-available-standard-v27-risk-v23-to-ai-v216-single-profile-admission-shadow',
                aiStage: 'ai-stage-policy-v2.16',
            } as never;
            const safe = JSON.parse(await actualDiagnosticV216SafeLine());
            const createRunner = vi.fn(() => Object.freeze({}));
            await runBuiltJob({
                env: validEnv(),
                runtimeImageDigest: immutableImageDigest,
                bindLocalCleanup: () => async () => undefined,
                loadArtifacts: async () => ({
                    bundle: { ...v216Bundle, expired: false },
                    cleanup: async () => undefined,
                }),
                createGcsClient: () => ({
                    downloadBundle: vi.fn(),
                    createClaim: vi.fn(),
                    createReport: vi.fn(),
                }),
                createRunner,
                runReplay: async (input: {
                    evaluationPolicy: { aiStage: string };
                    write(line: string): void;
                }) => {
                    expect(input.evaluationPolicy.aiStage).toBe(
                        'ai-stage-policy-v2.16',
                    );
                    input.write(JSON.stringify(safe));
                },
                installSignalCleanup: () => () => undefined,
                writeStdout: vi.fn(),
            });
            expect(createRunner).toHaveBeenCalledOnce();
            expect(createRunner).toHaveBeenCalledWith(
                'ai-stage-policy-v2.16',
            );

            const boot = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                outfile,
            ], {
                cwd: workspace,
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            }).then(() => {
                throw new Error('Expected V2.16 replay job boot to fail closed');
            }).catch(error => error as { code: number; stderr: string });
            expect(boot.code).toBe(1);
            expect(boot.stderr).toBe(
                '{"status":"failed","errorCode":"ANALYSIS_V2_REPLAY_JOB_TASK_CONFIGURATION_INVALID"}\n',
            );
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    }, 30_000);

    it('builds the immutable V2.17 entry with its pinned common bootstrap export', async () => {
        const imageRoot = await mkdtemp(join(
            tmpdir(),
            '.replay-job-v217-image-',
        ));
        const workspace = join(imageRoot, 'workspace');
        const outputDirectory = join(workspace, 'replay-job');
        const outfile = join(outputDirectory, 'job.mjs');
        const metafile = join(outputDirectory, 'meta.json');
        const runtimeManifest = join(outputDirectory, 'runtime.json');
        try {
            await mkdir(workspace, { mode: 0o700 });
            const {
                copyReplayAnalysisV2JobPhysicalDependencyClosure,
            } = await import('./build-replay-analysis-v2-job.mjs');
            await copyReplayAnalysisV2JobPhysicalDependencyClosure({
                sourceWorkspace: process.cwd(),
                imageWorkspace: workspace,
            });
            await execFileAsync(process.execPath, [
                'scripts/build-replay-analysis-v2-job.mjs',
                '--outfile', outfile,
                '--metafile', metafile,
                '--runtime-manifest', runtimeManifest,
                '--image-digest', immutableImageDigest,
                '--evaluation-ai-policy=ai-stage-policy-v2.17',
            ], {
                cwd: process.cwd(),
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            const metadata = JSON.parse(await readFile(metafile, 'utf8')) as {
                inputs: Record<string, unknown>;
            };
            expect(metadata.inputs).toHaveProperty(
                'scripts/replay-analysis-v217-job.ts',
            );
            expect(metadata.inputs).toHaveProperty(
                'lib/services/analysis/replay/replay-public-name-fusion.ts',
            );
            expect(metadata.inputs).not.toHaveProperty(
                'scripts/replay-analysis-v216-job.ts',
            );
            const marker = await execFileAsync(process.execPath, [
                '--conditions=react-server',
                '--eval',
                `import(${JSON.stringify(pathToFileURL(outfile).href)}).then(m => process.stdout.write(m.REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY.aiStage))`,
            ], {
                cwd: workspace,
                env: { NODE_ENV: 'test', PATH: process.env.PATH },
            });
            expect(marker.stdout).toBe('ai-stage-policy-v2.17');

            const loaded = await import(
                `${pathToFileURL(outfile).href}?bootstrap-v217-contract`
            );
            expect(Reflect.get(loaded, 'runReplayAnalysisV2Job'))
                .toBeTypeOf('function');
        } finally {
            await rm(imageRoot, { recursive: true, force: true });
        }
    }, 30_000);

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

    it('exposes actual loader bundle ownership to signal cleanup before FileHandle.stat can resolve', async () => {
        const {
            loadReplayAnalysisV2JobArtifacts,
        } = await import('./replay-analysis-v2-job');
        const directory = await mkdtemp(join(
            tmpdir(),
            'replay-job-signal-open-',
        ));
        await chmod(directory, 0o700);
        const bundlePath = join(directory, 'input.enc');
        const keyPath = join(directory, 'input.key');
        let releaseStat: () => void = () => undefined;
        let restoreStat: () => void = () => undefined;
        let settled = Promise.resolve();
        try {
            await createReplayKeyFile(keyPath);
            await writeReplayBundle({
                bundle: v212Bundle(),
                bundlePath,
                keyPath,
            });
            const ciphertext = await readFile(bundlePath);
            await unlink(bundlePath);
            const gate = await gateFileHandleStat(directory);
            releaseStat = gate.release;
            restoreStat = gate.restore;
            let signalCleanup: (() => Promise<void>) | undefined;
            const loading = loadReplayAnalysisV2JobArtifacts(
                validateConfigPaths(bundlePath, keyPath),
                {
                    downloadBundle: vi.fn(async () => ciphertext),
                    createClaim: vi.fn(),
                    createReport: vi.fn(),
                },
                cleanup => {
                    signalCleanup = cleanup;
                },
            );
            settled = loading.then(
                () => undefined,
                () => undefined,
            );

            await vi.waitFor(async () => {
                await expect(access(bundlePath)).resolves.toBeUndefined();
            });
            expect(signalCleanup).toBeDefined();
            await signalCleanup!();
            await expect(access(bundlePath)).rejects.toThrow();
            await expect(access(keyPath)).rejects.toThrow();
        } finally {
            releaseStat();
            await settled;
            restoreStat();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('keeps a replacement inode when actual loader signal cleanup detects a race', async () => {
        const {
            loadReplayAnalysisV2JobArtifacts,
        } = await import('./replay-analysis-v2-job');
        const directory = await mkdtemp(join(
            tmpdir(),
            'replay-job-signal-replacement-',
        ));
        await chmod(directory, 0o700);
        const bundlePath = join(directory, 'input.enc');
        const keyPath = join(directory, 'input.key');
        const movedOwnerPath = join(directory, 'original.enc');
        let releaseStat: () => void = () => undefined;
        let restoreStat: () => void = () => undefined;
        let settled = Promise.resolve();
        try {
            await createReplayKeyFile(keyPath);
            await writeReplayBundle({
                bundle: v212Bundle(),
                bundlePath,
                keyPath,
            });
            const ciphertext = await readFile(bundlePath);
            await unlink(bundlePath);
            const gate = await gateFileHandleStat(directory);
            releaseStat = gate.release;
            restoreStat = gate.restore;
            let signalCleanup: (() => Promise<void>) | undefined;
            const loading = loadReplayAnalysisV2JobArtifacts(
                validateConfigPaths(bundlePath, keyPath),
                {
                    downloadBundle: vi.fn(async () => ciphertext),
                    createClaim: vi.fn(),
                    createReport: vi.fn(),
                },
                cleanup => {
                    signalCleanup = cleanup;
                },
            );
            settled = loading.then(
                () => undefined,
                () => undefined,
            );

            await vi.waitFor(async () => {
                await expect(access(bundlePath)).resolves.toBeUndefined();
            });
            await rename(bundlePath, movedOwnerPath);
            await writeFile(bundlePath, 'replacement', { mode: 0o600 });

            await expect(signalCleanup!()).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE',
            );
            await expect(readFile(bundlePath, 'utf8'))
                .resolves.toBe('replacement');
            await expect(access(movedOwnerPath)).resolves.toBeUndefined();
        } finally {
            releaseStat();
            await settled;
            restoreStat();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('quarantines before inode verification and reports a cleanup race', async () => {
        const {
            removeReplayAnalysisV2JobLocalArtifact,
        } = await import('./replay-analysis-v2-job');
        const directory = await mkdtemp(join(tmpdir(), 'replay-job-race-'));
        const artifactPath = join(directory, 'input.key');
        const movedOwnerPath = join(directory, 'original.key');
        try {
            await writeFile(artifactPath, 'owned', { mode: 0o600 });
            const owned = await lstat(artifactPath);
            await rename(artifactPath, movedOwnerPath);
            await writeFile(artifactPath, 'replacement', { mode: 0o600 });

            await expect(removeReplayAnalysisV2JobLocalArtifact(
                artifactPath,
                { device: owned.dev, inode: owned.ino },
            )).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE',
            );
            await expect(readFile(artifactPath, 'utf8'))
                .resolves.toBe('replacement');
            await expect(readFile(movedOwnerPath, 'utf8'))
                .resolves.toBe('owned');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('makes exact owned local cleanup idempotent without deleting a replacement', async () => {
        const {
            removeReplayAnalysisV2JobLocalArtifact,
        } = await import('./replay-analysis-v2-job');
        const directory = await mkdtemp(join(
            tmpdir(),
            'replay-job-idempotent-cleanup-',
        ));
        const artifactPath = join(directory, 'input.key');
        try {
            await writeFile(artifactPath, 'owned', { mode: 0o600 });
            const owned = await lstat(artifactPath);
            const identity = {
                device: owned.dev,
                inode: owned.ino,
            };

            await removeReplayAnalysisV2JobLocalArtifact(
                artifactPath,
                identity,
            );
            await expect(removeReplayAnalysisV2JobLocalArtifact(
                artifactPath,
                identity,
            )).resolves.toBeUndefined();

            await writeFile(artifactPath, 'replacement', { mode: 0o600 });
            await expect(removeReplayAnalysisV2JobLocalArtifact(
                artifactPath,
                identity,
            )).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE',
            );
            await expect(readFile(artifactPath, 'utf8'))
                .resolves.toBe('replacement');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('does not swallow a failure-cleanup inode race', async () => {
        const {
            loadReplayAnalysisV2JobArtifacts,
        } = await import('./replay-analysis-v2-job');
        const directory = await mkdtemp(join(
            tmpdir(),
            'replay-job-failure-race-',
        ));
        await chmod(directory, 0o700);
        const bundlePath = join(directory, 'input.enc');
        const keyPath = join(directory, 'input.key');
        const movedOwnerPath = join(directory, 'original.key');
        try {
            await createReplayKeyFile(keyPath);
            await expect(loadReplayAnalysisV2JobArtifacts(
                validateConfigPaths(bundlePath, keyPath),
                {
                    downloadBundle: vi.fn(async () => {
                        await rename(keyPath, movedOwnerPath);
                        await writeFile(keyPath, 'replacement', {
                            mode: 0o600,
                        });
                        throw new Error(
                            'ANALYSIS_V2_REPLAY_JOB_BUNDLE_DOWNLOAD_FAILED',
                        );
                    }),
                    createClaim: vi.fn(),
                    createReport: vi.fn(),
                },
            )).rejects.toThrow(
                'ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE',
            );
            await expect(readFile(keyPath, 'utf8'))
                .resolves.toBe('replacement');
            await expect(access(movedOwnerPath)).resolves.toBeUndefined();
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it('installs signal cleanup before artifact loading starts', async () => {
        const { runReplayAnalysisV2Job } = await import(
            './replay-analysis-v2-job'
        );
        const events: string[] = [];
        const cleanup = vi.fn();
        const safeLine = await actualDiagnosticV213SafeLine();

        await runReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
            installSignalCleanup: vi.fn(() => {
                events.push('signals');
                return () => undefined;
            }),
            loadArtifacts: vi.fn(async () => {
                events.push('load');
                return {
                    bundle: { ...v213Bundle(), expired: false },
                    cleanup,
                };
            }),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            }),
            createRunner: vi.fn(() => Object.freeze({})),
            runReplay: vi.fn(async input => input.write(safeLine)),
            writeStdout: vi.fn(),
        });

        expect(events.slice(0, 2)).toEqual(['signals', 'load']);
    });

    it('binds owned cleanup before load and awaits final cleanup before uninstall', async () => {
        const { runReplayAnalysisV2Job } = await import(
            './replay-analysis-v2-job'
        );
        const events: string[] = [];
        const initialOwnedCleanup = vi.fn(async () => {
            events.push('initial-cleanup');
        });
        const loadedCleanup = vi.fn(async () => {
            events.push('loaded-cleanup');
        });
        let signalCleanup: (() => Promise<void>) | undefined;
        const safeLine = await actualDiagnosticV213SafeLine();

        await runReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: vi.fn(() => {
                events.push('bind');
                return initialOwnedCleanup;
            }),
            installSignalCleanup: vi.fn(input => {
                events.push('signals');
                signalCleanup = input.cleanup;
                return () => {
                    events.push('uninstall');
                };
            }),
            loadArtifacts: vi.fn(async () => {
                events.push('load');
                await signalCleanup?.();
                events.push('after-initial-signal');
                return {
                    bundle: { ...v213Bundle(), expired: false },
                    cleanup: loadedCleanup,
                };
            }),
            createGcsClient: () => ({
                downloadBundle: vi.fn(),
                createClaim: vi.fn(),
                createReport: vi.fn(),
            }),
            createRunner: vi.fn(() => Object.freeze({})),
            runReplay: vi.fn(async input => input.write(safeLine)),
            writeStdout: vi.fn(),
        });

        expect(initialOwnedCleanup).toHaveBeenCalledOnce();
        expect(loadedCleanup).toHaveBeenCalledOnce();
        expect(events).toEqual([
            'bind',
            'signals',
            'load',
            'initial-cleanup',
            'after-initial-signal',
            'loaded-cleanup',
            'uninstall',
        ]);
    });

    it('uses a fail-closed persistence stub in the replay build', async () => {
        const { supabaseAdmin } = await import(
            './replay-analysis-v2-job-supabase-stub'
        );
        expect(() => (
            supabaseAdmin as { from: unknown }
        ).from).toThrow('ANALYSIS_V2_REPLAY_JOB_FORBIDDEN_PERSISTENCE');
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
        ['sealed V2.12 evaluation', {
            capture: {
                evaluationPolicy: v212Bundle().capture.evaluationPolicy,
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
            ...v213Bundle(),
            expired: false,
        };
        const bundle = 'capture' in override
            ? { ...base, capture: { ...base.capture, ...override.capture } }
            : { ...base, ...override };

        await expect(runReplayAnalysisV2Job({
            env: validEnv(),
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
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
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
            loadArtifacts: vi.fn(async () => ({
                bundle: { ...v213Bundle(), expired: false },
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
            runtimeImageDigest: immutableImageDigest,
            bindLocalCleanup: () => async () => undefined,
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
                                'historical-partial-available-standard-v27-risk-v23-to-ai-v213-feature-high-resolution-shadow',
                            aiStage: 'ai-stage-policy-v2.13',
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
