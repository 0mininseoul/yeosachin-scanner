import {
    createAnalysisV2CollectionExecutorRegistry,
    type AnalysisV2CollectionExecutorDependencies,
} from './v2-collection-executors';
import { createProductionAnalysisV2AiScoringExecutorRegistry } from './v2-ai-scoring-production';
import { createRevenueGenderRoutingInputPreparer } from './revenue-gender-routing-input-preparer';
import type { AnalysisV2StageExecutorRegistry } from './v2-worker';

let cachedProductionRegistry: AnalysisV2StageExecutorRegistry | null = null;

export interface AnalysisV2ProductionExecutorDependencies {
    revenueGenderRoutingInputPreparer?: AnalysisV2CollectionExecutorDependencies['revenueGenderRoutingInputPreparer'];
}

/** Production supplies image preparation only; the stage-one Gemini assessor remains unset. */
export function createAnalysisV2ProductionCollectionDependencies(
    env: Record<string, string | undefined> = process.env,
    dependencies: AnalysisV2ProductionExecutorDependencies = {},
): AnalysisV2CollectionExecutorDependencies {
    return {
        env,
        revenueGenderRoutingInputPreparer: dependencies.revenueGenderRoutingInputPreparer
            ?? createRevenueGenderRoutingInputPreparer(),
    };
}

export function createAnalysisV2ProductionExecutorRegistry(
    env: Record<string, string | undefined> = process.env,
    dependencies: AnalysisV2ProductionExecutorDependencies = {},
): AnalysisV2StageExecutorRegistry {
    return Object.freeze({
        ...createAnalysisV2CollectionExecutorRegistry(
            createAnalysisV2ProductionCollectionDependencies(env, dependencies),
        ),
        ...createProductionAnalysisV2AiScoringExecutorRegistry(env),
    });
}

/** Lazily validates production credentials and reuses one immutable registry per worker process. */
export function getAnalysisV2ProductionExecutorRegistry(): AnalysisV2StageExecutorRegistry {
    cachedProductionRegistry ??= createAnalysisV2ProductionExecutorRegistry();
    return cachedProductionRegistry;
}
