import type { z } from 'zod';
import { analyzeWithGemini } from './gemini';
import type { ReplayStatelessCapability } from './replay-stateless-capability';
import type { AiStagePolicyVersion } from './stage-policy';
import type { StagedAiAuditContext } from './v2-staged-analysis';

export interface PreparedGenderResolutionGeneration<T> {
    prompt: string;
    images: string[];
    schema: z.ZodType<T>;
    policyVersion: AiStagePolicyVersion;
    audit: StagedAiAuditContext;
    startingAttempt: number;
    abortSignal?: AbortSignal;
    admissionDeadlineAtMs?: number;
    replayCapability?: ReplayStatelessCapability;
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
            ...(input.admissionDeadlineAtMs !== undefined
                ? { admissionDeadlineAtMs: input.admissionDeadlineAtMs }
                : {}),
            onBeforeAttempt: input.audit.onBeforeAttempt,
            onProviderDispatch: input.audit.onProviderDispatch,
            onAttemptTelemetry: input.audit.onAttemptTelemetry,
            ...(input.replayCapability
                ? { skipTokenLog: true, replayCapability: input.replayCapability }
                : {}),
        },
    ));
}

export const runCanonicalGenderResolutionGeneration = <T>(
    input: PreparedGenderResolutionGeneration<T>,
) => run(input);
