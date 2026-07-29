import { z } from 'zod';
import {
    analyzeWithGemini,
    type AnalyzeWithGeminiOptions,
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
    const raw = prepared.result === null
        ? await analyzeWithGemini(
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
                    PRO_GENDER_SECOND_LOOK_CONFIG_V219.maxOutputUnits,
                skipTokenLog: true,
                replayCapability: input.replayCapability,
                onBeforeAttempt: input.audit.onBeforeAttempt,
                onProviderDispatch: input.audit.onProviderDispatch,
                onAttemptTelemetry: input.audit.onAttemptTelemetry,
                ...(input.abortSignal
                    ? { abortSignal: input.abortSignal }
                    : {}),
                ...(input.runProviderAttempt
                    ? { runProviderAttempt: input.runProviderAttempt }
                    : {}),
            } satisfies AnalyzeWithGeminiOptions<
                z.output<typeof projected.schema>
            >,
        )
        : projected.schema.parse(prepared.result);

    return projected.finalize(projected.schema.parse(raw));
}
