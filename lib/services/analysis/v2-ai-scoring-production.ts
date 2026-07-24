import { makeApifyInteractionAdapter } from '@/lib/services/instagram/providers/apify-interactions';
import {
    selectAnalysisV2ApifyCredentialSlot,
    selectApifyApiToken,
} from '@/lib/services/instagram/providers/apify-relationship';
import { createDurableAnalysisV2AiStageRuntime } from './v2-ai-stage-runtime';
import {
    createAnalysisV2AiScoringExecutorRegistry,
    type AnalysisV2AiScoringExecutorDependencies,
} from './v2-ai-scoring-executors';
import {
    createAnalysisV2MediaNormalizer,
    createAnalysisV2ProfileBatchReadModel,
    createAnalysisV2RelationshipEvidenceReadModel,
    createAnalysisV2ReverseLikeCollector,
    createAnalysisV2TargetProfileReadModel,
} from './v2-ai-scoring-runtime-deps';
import { analysisV2AiScoringStageStore } from './v2-ai-scoring-stage-store';
import { createConfiguredAnalysisV2MediaArtifactStore } from './v2-media-artifact-store';
import { analysisV2ResultStore } from './v2-result-store';
import {
    captureResultImageSources,
} from '@/lib/services/media/result-image-capture';
import {
    createResultImageRegistry,
} from '@/lib/services/media/result-image-registry';
import {
    createResultImageR2Writer,
    loadResultImageR2Config,
} from '@/lib/services/media/r2-result-image-store';
import { supabaseAdmin } from '@/lib/supabase/admin';

export type AnalysisV2ProductionEnvironment = Record<string, string | undefined>;

function createProductionResultImageCapture(
    env: AnalysisV2ProductionEnvironment
): AnalysisV2AiScoringExecutorDependencies['resultImages'] {
    const enabled = env.ANALYSIS_V2_RESULT_IMAGES_ENABLED?.trim()
        ?? 'false';
    if (enabled === 'false') return undefined;
    if (enabled !== 'true') {
        throw new Error('ANALYSIS_V2_RESULT_IMAGE_CONFIG_ERROR');
    }
    const hmacSecret =
        env.ANALYSIS_V2_RESULT_IMAGE_OBJECT_HMAC_SECRET?.trim();
    if (!hmacSecret || hmacSecret.length < 32) {
        throw new Error('ANALYSIS_V2_RESULT_IMAGE_CONFIG_ERROR');
    }
    const registry = createResultImageRegistry(supabaseAdmin);
    const store = createResultImageR2Writer(
        loadResultImageR2Config(env)
    );
    return {
        async capture(input) {
            return captureResultImageSources({
                ...input,
                registry,
                store,
                hmacSecret,
            });
        },
    };
}

/**
 * Builds production AI/scoring executors only when the worker asks for them. This keeps module
 * import side-effect free while making a missing private bucket or selected Apify token fail fast.
 */
export function createProductionAnalysisV2AiScoringExecutorRegistry(
    env: AnalysisV2ProductionEnvironment = process.env
) {
    const credentialSlot = selectAnalysisV2ApifyCredentialSlot(env);
    selectApifyApiToken(env, credentialSlot);
    const mediaStore = createConfiguredAnalysisV2MediaArtifactStore(env);
    const dependencies: AnalysisV2AiScoringExecutorDependencies = {
        profileBatches: createAnalysisV2ProfileBatchReadModel(),
        evidence: createAnalysisV2RelationshipEvidenceReadModel(),
        targetProfiles: createAnalysisV2TargetProfileReadModel(),
        stageStore: analysisV2AiScoringStageStore,
        resultStore: analysisV2ResultStore,
        resultImages: createProductionResultImageCapture(env),
        mediaStore,
        ai: createDurableAnalysisV2AiStageRuntime(),
        reverseLikes: createAnalysisV2ReverseLikeCollector({
            adapter: makeApifyInteractionAdapter({ env }),
            env,
        }),
        normalizeMedia: createAnalysisV2MediaNormalizer(),
    };
    return createAnalysisV2AiScoringExecutorRegistry(dependencies);
}
