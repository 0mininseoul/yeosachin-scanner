import { createHash } from 'node:crypto';
import { z } from 'zod';

export interface ReplayJobGcsClient {
    downloadBundle(): Promise<Buffer>;
    createClaim(raw: string): Promise<void>;
    createReport(raw: string): Promise<void>;
}

interface ReplayJobGcsDependencies {
    fetch?: typeof fetch;
    now?: () => number;
}

const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SAFE_OBJECT = /^[a-z0-9][a-z0-9._/-]{0,190}$/;
const MAX_ENCRYPTED_BUNDLE_BYTES =
    Math.ceil(272 * 1024 * 1024 * 4 / 3) + 4_096;
const ADC_REFRESH_SKEW_MS = 60_000;
const UNSAFE_KEY = /(?:user_?name|full_?name|bio|caption|url|prompt|base64|raw|error|token|secret|request_?id|^handle$|^terminal$)/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
const aggregateCount = z.number().int().min(0).max(100_000_000);
const aggregateRate = z.number().finite().min(0).max(1);
const replayOutcomeCounts = z.object({
    ok: aggregateCount.optional(),
    rate_limited: aggregateCount.optional(),
    retry_exhausted: aggregateCount.optional(),
    rejected: aggregateCount.optional(),
    failed: aggregateCount.optional(),
    capacity_skipped: aggregateCount.optional(),
}).strict();
const stageFailureDispositionCounts = z.object({
    success: aggregateCount.optional(),
    rate_limited: aggregateCount.optional(),
    ambiguous: aggregateCount.optional(),
    rejected: aggregateCount.optional(),
    response_rejected: aggregateCount.optional(),
    retry_exhausted: aggregateCount.optional(),
    failed: aggregateCount.optional(),
    capacity_skipped: aggregateCount.optional(),
    cutoff: aggregateCount.optional(),
    backoff_cutoff: aggregateCount.optional(),
}).strict();
const stageFailureKindCounts = z.object({
    http_408: aggregateCount.optional(),
    http_429: aggregateCount.optional(),
    http_4xx: aggregateCount.optional(),
    http_5xx: aggregateCount.optional(),
    transport: aggregateCount.optional(),
    unknown_sdk: aggregateCount.optional(),
}).strict();
const triageSourceCounts = z.object({
    checkpoint: aggregateCount.optional(),
    safe_fallback: aggregateCount.optional(),
    unknown: aggregateCount.optional(),
    non_ok: aggregateCount.optional(),
}).strict();
const genderConfidenceCounts = z.object({
    'female:low': aggregateCount.optional(),
    'female:medium': aggregateCount.optional(),
    'female:high': aggregateCount.optional(),
    'male:low': aggregateCount.optional(),
    'male:medium': aggregateCount.optional(),
    'male:high': aggregateCount.optional(),
    'unknown:low': aggregateCount.optional(),
    'unknown:medium': aggregateCount.optional(),
    'unknown:high': aggregateCount.optional(),
}).strict();
const triageAccountContextCounts = z.object({
    personal: aggregateCount.optional(),
    individual_creator: aggregateCount.optional(),
    official_group_or_brand: aggregateCount.optional(),
    uncertain: aggregateCount.optional(),
    absent: aggregateCount.optional(),
}).strict();
const featureAdmissionCounts = z.object({
    eligible: aggregateCount.optional(),
    nonpersonal_or_official: aggregateCount.optional(),
    unsupported_unknown: aggregateCount.optional(),
}).strict();
const featureFinalDecisionCounts = z.object({
    verified_female: aggregateCount.optional(),
    verified_non_female: aggregateCount.optional(),
    unresolved: aggregateCount.optional(),
    unresolved_stage_conflict: aggregateCount.optional(),
}).strict();
const featureAccountContextCounts = z.object({
    personal: aggregateCount.optional(),
    individual_creator: aggregateCount.optional(),
    official_group_or_brand: aggregateCount.optional(),
    uncertain: aggregateCount.optional(),
}).strict();
const featureRouteTerminalCounts = z.object({
    not_routed_high_male: aggregateCount.optional(),
    excluded_official: aggregateCount.optional(),
    completed: aggregateCount.optional(),
    provider_non_ok: aggregateCount.optional(),
    triage_non_ok: aggregateCount.optional(),
}).strict();
const resolverOutcomeCounts = replayOutcomeCounts.extend({
    official_excluded: aggregateCount.optional(),
    cutoff: aggregateCount.optional(),
}).strict();
const finalClassificationSourceCounts = z.object({
    triage: aggregateCount.optional(),
    feature: aggregateCount.optional(),
    gender_resolution: aggregateCount.optional(),
    unknown: aggregateCount.optional(),
    unavailable: aggregateCount.optional(),
    triage_non_ok: aggregateCount.optional(),
}).strict();
const stageMetricsSchema = z.object({
    calls: aggregateCount,
    rate_limited: aggregateCount,
    retries: aggregateCount,
    mean_latency_ms: z.number().finite().min(0).max(3_600_000),
    p50_latency_ms: z.number().finite().min(0).max(3_600_000),
    p95_latency_ms: z.number().finite().min(0).max(3_600_000),
    failure_disposition: stageFailureDispositionCounts,
    failure_kind: stageFailureKindCounts,
}).strict();
const replayAnalysisV2JobTerminalSchema = z.object({
    status: z.literal('ok'),
    benchmark_scope: z.literal('ai-only-historical-partial-available'),
    source_plan: z.literal('standard'),
    source_pipeline: z.literal('v2'),
    source_ai_policy: z.literal('ai-stage-policy-v2.7'),
    source_risk_policy: z.literal('risk-policy-v2.3'),
    evaluation_ai_policy: z.literal('ai-stage-policy-v2.12'),
    replay_ai_policy: z.literal('ai-stage-policy-v2.12'),
    full_e2e_evidence: z.literal(false),
    not_exact: z.literal(true),
    no_media_substitution: z.literal(true),
    diagnostic_partial_coverage_override: z.object({
        used: z.literal(true),
        retained_profiles: aggregateCount,
        source_profiles: aggregateCount,
        retained_media: aggregateCount,
        exact_selected_media: aggregateCount,
        profile_retention_bps: z.number().int().min(0).max(10_000),
        media_retention_bps: z.number().int().min(0).max(10_000),
    }).strict(),
    total_elapsed_ms: z.number().finite().min(0).max(86_400_000),
    stages: z.object({
        genderTriage: stageMetricsSchema,
        featureAnalysis: stageMetricsSchema,
        privateAccountName: stageMetricsSchema,
        genderResolution: stageMetricsSchema,
    }).strict(),
    gender: z.object({
        male: aggregateCount,
        female: aggregateCount,
        unknown: aggregateCount,
        unknownRate: aggregateRate,
    }).strict(),
    resolver: z.object({
        ready: aggregateCount,
        applied: aggregateCount,
        inconclusive: aggregateCount,
        cutoff: aggregateCount,
        capacitySkipped: aggregateCount,
        admission: z.object({
            eligible: aggregateCount,
            alreadyVerified: aggregateCount,
            officialOrGroup: aggregateCount,
            uncertainOrAbsent: aggregateCount,
            insufficientMedia: aggregateCount,
        }).strict(),
        outcomes: z.object({
            readyHighConfirmed: aggregateCount,
            evidenceInsufficient: aggregateCount,
            mixed: aggregateCount,
            unknown: aggregateCount,
            reconciliationApplied: aggregateCount,
            reconciliationInconclusive: aggregateCount,
            cutoff: aggregateCount,
            capacitySkipped: aggregateCount,
        }).strict(),
    }).strict(),
    gender_quality: z.object({
        triage: z.object({
            nonOk: aggregateCount,
            capacity: aggregateCount,
            outcome: replayOutcomeCounts,
            source: triageSourceCounts,
            genderConfidence: genderConfidenceCounts,
            accountContext: triageAccountContextCounts,
        }).strict(),
        feature: z.object({
            admission: featureAdmissionCounts,
            finalDecision: featureFinalDecisionCounts,
            accountContext: featureAccountContextCounts,
            routeTerminal: featureRouteTerminalCounts,
        }).strict(),
        resolver: z.object({
            earlyAdmission: aggregateCount,
            lateAdmission: aggregateCount,
            outcome: resolverOutcomeCounts,
        }).strict(),
        finalClassificationSource: finalClassificationSourceCounts,
        qualityGate: z.object({
            observedUnknownRate: aggregateRate,
            worstCaseUnknownRate: aggregateRate,
            observedPass: z.boolean(),
            worstCasePass: z.boolean(),
        }).strict(),
    }).strict(),
}).strict();

function unsafeJsonValue(value: unknown): boolean {
    if (typeof value === 'string') {
        return UUID.test(value)
            || /\bhttps?:\/\//i.test(value)
            || /\b(?:raw[-_ ]?error|token|secret|base64)\b/i.test(value);
    }
    if (Array.isArray(value)) return value.some(unsafeJsonValue);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => (
        UNSAFE_KEY.test(key) || unsafeJsonValue(child)
    ));
}

function assertSafeJson(raw: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || unsafeJsonValue(parsed)
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
}

export function validateReplayAnalysisV2JobTerminalLine(
    raw: string | undefined,
): string {
    if (!raw) throw new Error('ANALYSIS_V2_REPLAY_JOB_REPORT_MISSING');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    if (!replayAnalysisV2JobTerminalSchema.safeParse(parsed).success) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    return raw;
}

export function createReplayJobGcsClient(
    config: {
        bucket: string;
        bundleObject: string;
        bundleGeneration: string;
        bundleBytes: number;
        bundleSha256: string;
        claimObject: string;
        reportObject: string;
    },
    dependencies: ReplayJobGcsDependencies = {},
): ReplayJobGcsClient {
    if (
        !SAFE_BUCKET.test(config.bucket)
        || ![config.bundleObject, config.claimObject, config.reportObject]
            .every(value => SAFE_OBJECT.test(value) && !value.includes('..'))
        || new Set([
            config.bundleObject,
            config.claimObject,
            config.reportObject,
        ]).size !== 3
        || !/^[1-9][0-9]{0,19}$/.test(config.bundleGeneration)
        || !Number.isSafeInteger(config.bundleBytes)
        || config.bundleBytes < 1
        || config.bundleBytes > MAX_ENCRYPTED_BUNDLE_BYTES
        || !/^[a-f0-9]{64}$/.test(config.bundleSha256)
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_GCS_CONFIGURATION_INVALID');
    }
    const fetchImpl = dependencies.fetch ?? fetch;
    const now = dependencies.now ?? Date.now;
    let accessToken: {
        value: string;
        refreshAtMs: number;
    } | undefined;
    let tokenRequest: Promise<string> | undefined;
    const token = (): Promise<string> => {
        if (accessToken && now() < accessToken.refreshAtMs) {
            return Promise.resolve(accessToken.value);
        }
        tokenRequest ??= fetchImpl(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
            { headers: { 'Metadata-Flavor': 'Google' } },
        ).then(async response => {
            if (!response.ok) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_ADC_UNAVAILABLE');
            }
            const value = await response.json() as {
                access_token?: unknown;
                token_type?: unknown;
                expires_in?: unknown;
            };
            if (
                typeof value.access_token !== 'string'
                || value.access_token.length < 20
                || value.token_type !== 'Bearer'
                || !Number.isInteger(value.expires_in)
                || (value.expires_in as number) < 1
                || (value.expires_in as number) > 86_400
            ) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_ADC_UNAVAILABLE');
            }
            accessToken = {
                value: value.access_token,
                refreshAtMs: now() + Math.max(
                    0,
                    (value.expires_in as number) * 1_000
                        - ADC_REFRESH_SKEW_MS,
                ),
            };
            return accessToken.value;
        }).finally(() => {
            tokenRequest = undefined;
        });
        return tokenRequest;
    };
    const authorization = async () => ({
        authorization: `Bearer ${await token()}`,
    });
    const create = async (
        object: string,
        raw: string,
        kind: 'CLAIM' | 'REPORT',
    ): Promise<void> => {
        if (kind === 'REPORT') {
            validateReplayAnalysisV2JobTerminalLine(raw);
        } else {
            assertSafeJson(raw);
        }
        const url = new URL(
            `https://storage.googleapis.com/upload/storage/v1/b/${
                encodeURIComponent(config.bucket)
            }/o`,
        );
        url.searchParams.set('uploadType', 'media');
        url.searchParams.set('name', object);
        url.searchParams.set('ifGenerationMatch', '0');
        let response: Response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    ...await authorization(),
                    'content-type': 'application/json; charset=utf-8',
                },
                body: raw,
            });
        } catch {
            throw new Error(
                `ANALYSIS_V2_REPLAY_JOB_${kind}_CREATE_AMBIGUOUS`,
            );
        }
        if (kind === 'CLAIM' && response.status === 412) {
            throw new Error('ANALYSIS_V2_REPLAY_JOB_CLAIM_COLLISION');
        }
        if (!response.ok) {
            throw new Error(
                `ANALYSIS_V2_REPLAY_JOB_${kind}_CREATE_AMBIGUOUS`,
            );
        }
    };
    return Object.freeze({
        downloadBundle: async () => {
            const object = encodeURIComponent(config.bundleObject);
            const url = new URL(
                `https://storage.googleapis.com/download/storage/v1/b/${
                    encodeURIComponent(config.bucket)
                }/o/${object}`,
            );
            url.searchParams.set('alt', 'media');
            url.searchParams.set('generation', config.bundleGeneration);
            const response = await fetchImpl(url, {
                headers: await authorization(),
            });
            if (
                !response.ok
                || response.headers.get('x-goog-generation')
                    !== config.bundleGeneration
            ) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_BUNDLE_DOWNLOAD_FAILED');
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            if (
                bytes.byteLength !== config.bundleBytes
                || createHash('sha256').update(bytes).digest('hex')
                    !== config.bundleSha256
            ) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_BUNDLE_INTEGRITY_FAILED');
            }
            return bytes;
        },
        createClaim: (raw: string) => create(
            config.claimObject,
            raw,
            'CLAIM',
        ),
        createReport: (raw: string) => create(
            config.reportObject,
            raw,
            'REPORT',
        ),
    });
}
