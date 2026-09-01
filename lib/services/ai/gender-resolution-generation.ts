import type { z } from 'zod';
import { analyzeWithGemini } from './gemini';
import type { ReplayStatelessCapability } from './replay-stateless-capability';
import type { AiStagePolicyVersion } from './stage-policy';
import type { StagedAiAuditContext } from './v2-staged-analysis';
import type {
    VertexAiMediaResolution,
    VertexAiThinkingLevel,
} from './vertex-ai-cost-policy';

export interface PreparedGenderResolutionGeneration<T> {
    prompt: string;
    images: string[];
    schema: z.ZodType<T>;
    policyVersion: AiStagePolicyVersion;
    audit: StagedAiAuditContext;
    startingAttempt: number;
    abortSignal?: AbortSignal;
    replayCapability?: ReplayStatelessCapability;
    model?: string;
    thinkingLevel?: VertexAiThinkingLevel;
    mediaResolution?: VertexAiMediaResolution;
    maxOutputTokens?: number;
    maxAttempts?: number;
    retryResponseRejections?: boolean;
}

async function run<T>(
    input: PreparedGenderResolutionGeneration<T>,
): Promise<T> {
    return input.schema.parse(await analyzeWithGemini(
        input.prompt,
        input.images,
        {
            schema: input.schema,
            analysisType: 'v2_gender_resolution',
            stage: 'genderResolution',
            aiStagePolicyVersion: input.policyVersion,
            requestId: input.audit.requestId,
            startingAttempt: input.startingAttempt,
            abortSignal: input.abortSignal,
            onBeforeAttempt: input.audit.onBeforeAttempt,
            onAttemptTelemetry: input.audit.onAttemptTelemetry,
            ...(input.audit.onTelemetry ? { onTelemetry: input.audit.onTelemetry } : {}),
            ...(input.audit.budgetGuard ? { budgetGuard: input.audit.budgetGuard } : {}),
            ...(input.audit.budgetOrderId !== undefined
                ? { budgetOrderId: input.audit.budgetOrderId }
                : {}),
            budgetRunId: input.audit.requestId,
            budgetOperationKey: input.audit.operationKey,
            ...(input.model ? {
                model: input.model,
                thinkingLevel: input.thinkingLevel,
                mediaResolution: input.mediaResolution,
                maxOutputTokens: input.maxOutputTokens,
                maxAttempts: input.maxAttempts,
                retryResponseRejections: input.retryResponseRejections,
            } : {}),
            ...(input.replayCapability
                ? { replayCapability: input.replayCapability }
                : {}),
        },
    ));
}

export const runCanonicalGenderResolutionGeneration = <T>(
    input: PreparedGenderResolutionGeneration<T>,
) => run(input);
