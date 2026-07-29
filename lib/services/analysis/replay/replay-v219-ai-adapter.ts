import { z } from 'zod';
import {
    analyzeWithGemini,
    type AnalyzeWithGeminiOptions,
    type GeminiAttemptStartTelemetry,
    type GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';
import type { ReplayStatelessCapability } from '@/lib/services/ai/replay-stateless-capability';
import {
    AI_STAGE_POLICY_V219_VERSION,
} from '@/lib/services/ai/stage-policy';
import type { StagedAiAuditContext } from '@/lib/services/ai/v2-staged-analysis';
import {
    analysisV2AiResultIdentitiesEqual,
    createAnalysisV2AiMediaSnapshotHashFromParts,
    createAnalysisV2AiResultIdentity,
    createAnalysisV2AiResultInputHash,
} from '@/lib/services/analysis/v2-ai-result-identity';
import {
    PRO_GENDER_SECOND_LOOK_CONFIG_V219,
    projectProGenderSecondLookV219,
    type ProGenderSecondLookMediaV219,
    type ProGenderSecondLookResultV219,
} from './replay-v219-gender-second-look';

const PRO_GENDER_SECOND_LOOK_PROMPT_VERSION_V219 =
    'pro-gender-second-look-v1';
const PRO_GENDER_SECOND_LOOK_SCHEMA_VERSION_V219 = 1;
const REQUEST_UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const V219_PREDISPATCH_HARD_ERRORS = new Set([
    'ANALYSIS_V2_REPLAY_V219_DISPATCH_CEILING_EXCEEDED',
    'ANALYSIS_V2_REPLAY_V219_COST_CEILING_EXCEEDED',
    'ANALYSIS_V2_REPLAY_V219_LOCATION_MISMATCH',
]);

export function createProGenderSecondLookResultIdentityV219(
    media: readonly ProGenderSecondLookMediaV219[],
) {
    const projected = projectProGenderSecondLookV219(media);
    return createAnalysisV2AiResultIdentity({
        stage: 'featureAnalysis',
        modelName: PRO_GENDER_SECOND_LOOK_CONFIG_V219.model,
        thinkingLevel:
            PRO_GENDER_SECOND_LOOK_CONFIG_V219.thinkingLevel,
        mediaResolution:
            PRO_GENDER_SECOND_LOOK_CONFIG_V219.mediaResolution,
        promptVersion: PRO_GENDER_SECOND_LOOK_PROMPT_VERSION_V219,
        schemaVersion: PRO_GENDER_SECOND_LOOK_SCHEMA_VERSION_V219,
        maxOutputTokens:
            PRO_GENDER_SECOND_LOOK_CONFIG_V219.maxOutputUnits,
        inputHash: createAnalysisV2AiResultInputHash(projected.prompt),
        mediaSnapshotHash: createAnalysisV2AiMediaSnapshotHashFromParts(
            projected.projectedMedia.map(item => ({
                selectionId: item.selectionId,
                kind: item.kind,
                normalizedJpegBase64: item.jpegBase64,
            })),
        ),
        cacheScope: 'request',
    });
}

function assertAudit(
    audit: StagedAiAuditContext,
    expectedIdentity: ReturnType<
        typeof createProGenderSecondLookResultIdentityV219
    >,
): void {
    if (
        !REQUEST_UUID_PATTERN.test(audit.requestId)
        || audit.operationKey !== expectedIdentity.operationKey
        || !analysisV2AiResultIdentitiesEqual(
            audit.resultIdentity,
            expectedIdentity,
        )
        || typeof audit.prepare !== 'function'
        || typeof audit.onBeforeAttempt !== 'function'
        || typeof audit.onAttemptTelemetry !== 'function'
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_V219_INVALID_AI_AUDIT');
    }
}

function proAttemptStartTelemetry(
    value: GeminiAttemptStartTelemetry,
): GeminiAttemptStartTelemetry {
    return {
        ...value,
        location: PRO_GENDER_SECOND_LOOK_CONFIG_V219.location,
        promptVersion: PRO_GENDER_SECOND_LOOK_PROMPT_VERSION_V219,
        schemaVersion: PRO_GENDER_SECOND_LOOK_SCHEMA_VERSION_V219,
    };
}

function proAttemptTelemetry(
    value: GeminiAttemptTelemetry,
): GeminiAttemptTelemetry {
    return {
        ...value,
        location: PRO_GENDER_SECOND_LOOK_CONFIG_V219.location,
        promptVersion: PRO_GENDER_SECOND_LOOK_PROMPT_VERSION_V219,
        schemaVersion: PRO_GENDER_SECOND_LOOK_SCHEMA_VERSION_V219,
    };
}

function assertGlobalProviderLocation(
    value: GeminiAttemptStartTelemetry,
): void {
    if (
        value.location
            !== PRO_GENDER_SECOND_LOOK_CONFIG_V219.location
        || value.location !== 'global'
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_V219_LOCATION_MISMATCH',
        );
    }
}

function predispatchHardError(error: unknown): Error | undefined {
    return error instanceof Error
        && V219_PREDISPATCH_HARD_ERRORS.has(error.message)
        ? error
        : undefined;
}

export async function runProGenderSecondLookGenerationV219(input: {
    media: readonly ProGenderSecondLookMediaV219[];
    replayCapability: ReplayStatelessCapability;
    audit: StagedAiAuditContext;
    abortSignal?: AbortSignal;
    runProviderAttempt?: <T>(task: () => Promise<T>) => Promise<T>;
}): Promise<ProGenderSecondLookResultV219> {
    const projected = projectProGenderSecondLookV219(input.media);
    const identity = createProGenderSecondLookResultIdentityV219(input.media);
    assertAudit(input.audit, identity);
    const prepared = await input.audit.prepare();
    let rejectedBeforeDispatch: Error | undefined;
    let raw: z.output<typeof projected.schema>;
    if (prepared.result === null) {
        try {
            raw = await analyzeWithGemini(
                projected.prompt,
                projected.projectedMedia.map(item => item.jpegBase64),
                {
                    schema: projected.schema,
                    analysisType: 'v2_pro_gender_second_look_v219',
                    stage: 'featureAnalysis',
                    aiStagePolicyVersion: AI_STAGE_POLICY_V219_VERSION,
                    requestId: input.audit.requestId,
                    startingAttempt: prepared.startingAttempt,
                    model: PRO_GENDER_SECOND_LOOK_CONFIG_V219.model,
                    thinkingLevel:
                        PRO_GENDER_SECOND_LOOK_CONFIG_V219.thinkingLevel,
                    mediaResolution:
                        PRO_GENDER_SECOND_LOOK_CONFIG_V219.mediaResolution,
                    maxOutputTokens:
                        PRO_GENDER_SECOND_LOOK_CONFIG_V219
                            .maxOutputUnits,
                    skipTokenLog: true,
                    replayCapability: input.replayCapability,
                    onBeforeAttempt: value => (
                        input.audit.onBeforeAttempt(
                            proAttemptStartTelemetry(value),
                        )
                    ),
                    onProviderDispatch: value => {
                        try {
                            assertGlobalProviderLocation(value);
                            input.audit.onProviderDispatch?.(
                                proAttemptStartTelemetry(value),
                            );
                        } catch (error) {
                            rejectedBeforeDispatch =
                                predispatchHardError(error);
                            throw error;
                        }
                    },
                    onAttemptTelemetry: (value, parsedResult) => {
                        if (rejectedBeforeDispatch) return;
                        return input.audit.onAttemptTelemetry(
                            proAttemptTelemetry(value),
                            parsedResult,
                        );
                    },
                    ...(input.abortSignal
                        ? { abortSignal: input.abortSignal }
                        : {}),
                    ...(input.runProviderAttempt
                        ? {
                            runProviderAttempt:
                                input.runProviderAttempt,
                        }
                        : {}),
                } satisfies AnalyzeWithGeminiOptions<
                    z.output<typeof projected.schema>
                >,
            );
        } catch (error) {
            if (rejectedBeforeDispatch) {
                throw rejectedBeforeDispatch;
            }
            throw error;
        }
        if (rejectedBeforeDispatch) {
            throw rejectedBeforeDispatch;
        }
    } else {
        raw = projected.schema.parse(prepared.result);
    }

    return projected.finalize(projected.schema.parse(raw));
}
