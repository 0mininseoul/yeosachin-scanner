import {
    PRO_GENDER_SECOND_LOOK_CONFIG_V219,
} from './replay-v219-gender-second-look';

export const V219_REPLAY_BUDGET_STAGES = [
    'genderTriage',
    'featureAnalysis',
    'privateAccountName',
    'genderResolution',
    'proGenderSecondLook',
] as const;

export type V219ReplayBudgetStage =
    typeof V219_REPLAY_BUDGET_STAGES[number];

export const V219_CONTROL_LOGICAL_CALL_CEILING = 710;
export const V219_CONTROL_PROVIDER_DISPATCH_CEILING = 2_840;
export const V219_MAX_TREATMENT_LOGICAL_CALLS = 235;
export const V219_MAX_ATTEMPTS_PER_LOGICAL_CALL =
    PRO_GENDER_SECOND_LOOK_CONFIG_V219.maxAttemptsPerLogicalCall;

const NANO_USD_PER_USD = 1_000_000_000;

type StageDefinition = {
    model: 'gemini-3.1-flash-lite'
        | 'gemini-3-flash-preview'
        | 'gemini-3.1-pro-preview';
    logicalCallCeiling: number;
    inputUnitsPerDispatch: number;
    outputUnitsPerDispatch: number;
    inputNanoUsdPerUnit: number;
    outputNanoUsdPerUnit: number;
};

const CONTROL_STAGE_DEFINITIONS = Object.freeze({
    genderTriage: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        logicalCallCeiling: 235,
        // Fixed 32,768 text/schema/envelope allowance plus ten LOW images.
        inputUnitsPerDispatch: 32_768 + 10 * 280,
        outputUnitsPerDispatch: 1_024,
        inputNanoUsdPerUnit: 250,
        outputNanoUsdPerUnit: 1_500,
    }),
    featureAnalysis: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        logicalCallCeiling: 235,
        // Fixed 65,536 text/schema/envelope allowance plus eleven MEDIUM images.
        inputUnitsPerDispatch: 65_536 + 11 * 560,
        outputUnitsPerDispatch: 2_048,
        inputNanoUsdPerUnit: 250,
        outputNanoUsdPerUnit: 1_500,
    }),
    privateAccountName: Object.freeze({
        model: 'gemini-3.1-flash-lite',
        logicalCallCeiling: 5,
        inputUnitsPerDispatch: 65_536,
        outputUnitsPerDispatch: 8_192,
        inputNanoUsdPerUnit: 250,
        outputNanoUsdPerUnit: 1_500,
    }),
    genderResolution: Object.freeze({
        model: 'gemini-3-flash-preview',
        logicalCallCeiling: 235,
        // Fixed 16,384 text/schema/envelope allowance plus nine HIGH images.
        inputUnitsPerDispatch: 16_384 + 9 * 1_120,
        outputUnitsPerDispatch: 2_048,
        inputNanoUsdPerUnit: 500,
        outputNanoUsdPerUnit: 3_000,
    }),
} satisfies Record<
    Exclude<V219ReplayBudgetStage, 'proGenderSecondLook'>,
    Readonly<StageDefinition>
>);

export interface V219ReplayStageBudgetPlan {
    model: StageDefinition['model'];
    logicalCallCeiling: number;
    providerDispatchCeiling: number;
    inputUnitsPerDispatch: number;
    outputUnitsPerDispatch: number;
    costUsdPerDispatch: number;
    costCeilingUsd: number;
}

export interface V219ReplayBudgetPlan {
    controlLogicalCalls: number;
    controlProviderDispatches: number;
    treatmentLogicalCalls: number;
    treatmentProviderDispatches: number;
    totalLogicalCalls: number;
    totalProviderDispatches: number;
    costCeilingUsd: number;
    stages: Record<V219ReplayBudgetStage, V219ReplayStageBudgetPlan>;
}

function treatmentStageDefinition(
    treatmentLogicalCalls: number,
): Readonly<StageDefinition> {
    return Object.freeze({
        model: PRO_GENDER_SECOND_LOOK_CONFIG_V219.model,
        logicalCallCeiling: treatmentLogicalCalls,
        // Fixed 16,384 text/schema/envelope allowance plus nine HIGH images.
        inputUnitsPerDispatch: 16_384
            + (
                PRO_GENDER_SECOND_LOOK_CONFIG_V219.profileImageLimit
                + PRO_GENDER_SECOND_LOOK_CONFIG_V219.feedImageLimit
            ) * PRO_GENDER_SECOND_LOOK_CONFIG_V219.highImageInputUnits,
        outputUnitsPerDispatch:
            PRO_GENDER_SECOND_LOOK_CONFIG_V219.maxOutputUnits,
        inputNanoUsdPerUnit:
            PRO_GENDER_SECOND_LOOK_CONFIG_V219
                .inputUsdPerMillionUnits * 1_000,
        outputNanoUsdPerUnit:
            PRO_GENDER_SECOND_LOOK_CONFIG_V219
                .outputUsdPerMillionUnits * 1_000,
    });
}

function stageCostNanoUsdPerDispatch(
    definition: Readonly<StageDefinition>,
): number {
    return definition.inputUnitsPerDispatch
        * definition.inputNanoUsdPerUnit
        + definition.outputUnitsPerDispatch
            * definition.outputNanoUsdPerUnit;
}

function usd(nanoUsd: number): number {
    return Number((nanoUsd / NANO_USD_PER_USD).toFixed(9));
}

function stagePlan(
    definition: Readonly<StageDefinition>,
): V219ReplayStageBudgetPlan & { costNanoUsdPerDispatch: number } {
    const providerDispatchCeiling =
        definition.logicalCallCeiling * V219_MAX_ATTEMPTS_PER_LOGICAL_CALL;
    const costNanoUsdPerDispatch =
        stageCostNanoUsdPerDispatch(definition);
    return {
        model: definition.model,
        logicalCallCeiling: definition.logicalCallCeiling,
        providerDispatchCeiling,
        inputUnitsPerDispatch: definition.inputUnitsPerDispatch,
        outputUnitsPerDispatch: definition.outputUnitsPerDispatch,
        costUsdPerDispatch: usd(costNanoUsdPerDispatch),
        costCeilingUsd: usd(
            costNanoUsdPerDispatch * providerDispatchCeiling,
        ),
        costNanoUsdPerDispatch,
    };
}

function validTreatmentLogicalCalls(value: number): boolean {
    return Number.isSafeInteger(value)
        && value >= 0
        && value <= V219_MAX_TREATMENT_LOGICAL_CALLS;
}

function internalPlan(treatmentLogicalCalls: number) {
    if (!validTreatmentLogicalCalls(treatmentLogicalCalls)) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_V219_STATIC_COHORT_INVALID',
        );
    }
    const stages = {
        genderTriage: stagePlan(
            CONTROL_STAGE_DEFINITIONS.genderTriage,
        ),
        featureAnalysis: stagePlan(
            CONTROL_STAGE_DEFINITIONS.featureAnalysis,
        ),
        privateAccountName: stagePlan(
            CONTROL_STAGE_DEFINITIONS.privateAccountName,
        ),
        genderResolution: stagePlan(
            CONTROL_STAGE_DEFINITIONS.genderResolution,
        ),
        proGenderSecondLook: stagePlan(
            treatmentStageDefinition(treatmentLogicalCalls),
        ),
    };
    const controlLogicalCalls = Object.entries(stages)
        .filter(([stage]) => stage !== 'proGenderSecondLook')
        .reduce(
            (sum, [, value]) => sum + value.logicalCallCeiling,
            0,
        );
    const controlProviderDispatches = Object.entries(stages)
        .filter(([stage]) => stage !== 'proGenderSecondLook')
        .reduce(
            (sum, [, value]) => sum + value.providerDispatchCeiling,
            0,
        );
    const totalCostNanoUsd = Object.values(stages).reduce(
        (sum, value) => sum
            + value.costNanoUsdPerDispatch
                * value.providerDispatchCeiling,
        0,
    );
    return {
        controlLogicalCalls,
        controlProviderDispatches,
        treatmentLogicalCalls,
        treatmentProviderDispatches:
            stages.proGenderSecondLook.providerDispatchCeiling,
        totalLogicalCalls: controlLogicalCalls + treatmentLogicalCalls,
        totalProviderDispatches: controlProviderDispatches
            + stages.proGenderSecondLook.providerDispatchCeiling,
        costCeilingNanoUsd: totalCostNanoUsd,
        costCeilingUsd: usd(totalCostNanoUsd),
        stages,
    };
}

export function deriveV219ReplayBudgetPlan(
    treatmentLogicalCalls: number,
): V219ReplayBudgetPlan {
    const plan = internalPlan(treatmentLogicalCalls);
    return {
        controlLogicalCalls: plan.controlLogicalCalls,
        controlProviderDispatches: plan.controlProviderDispatches,
        treatmentLogicalCalls: plan.treatmentLogicalCalls,
        treatmentProviderDispatches: plan.treatmentProviderDispatches,
        totalLogicalCalls: plan.totalLogicalCalls,
        totalProviderDispatches: plan.totalProviderDispatches,
        costCeilingUsd: plan.costCeilingUsd,
        stages: Object.fromEntries(
            Object.entries(plan.stages).map(([stage, value]) => [
                stage,
                {
                    model: value.model,
                    logicalCallCeiling: value.logicalCallCeiling,
                    providerDispatchCeiling:
                        value.providerDispatchCeiling,
                    inputUnitsPerDispatch:
                        value.inputUnitsPerDispatch,
                    outputUnitsPerDispatch:
                        value.outputUnitsPerDispatch,
                    costUsdPerDispatch: value.costUsdPerDispatch,
                    costCeilingUsd: value.costCeilingUsd,
                },
            ]),
        ) as Record<V219ReplayBudgetStage, V219ReplayStageBudgetPlan>,
    };
}

export interface V219ReplayBudgetSnapshot {
    logicalCalls: number;
    providerDispatches: number;
    reservedCostUsd: number;
    costCeilingUsd: number;
    usageComplete: boolean;
    usageMissingDispatches: number;
    estimatedCostUsd: number | null;
    stages: Record<V219ReplayBudgetStage, {
        logicalCalls: number;
        providerDispatches: number;
        terminalDispatches: number;
    }>;
}

export interface V219ReplayBudget {
    startLogicalCall(stage: V219ReplayBudgetStage): void;
    reserveProviderDispatch(stage: V219ReplayBudgetStage): void;
    recordProviderTerminal(
        stage: V219ReplayBudgetStage,
        estimatedCostUsd: number | null,
    ): void;
    snapshot(): V219ReplayBudgetSnapshot;
}

const issuedBudgets = new WeakSet<object>();
const stageSet = new Set<string>(V219_REPLAY_BUDGET_STAGES);

function assertStage(value: unknown): asserts value is V219ReplayBudgetStage {
    if (typeof value !== 'string' || !stageSet.has(value)) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_V219_BUDGET_STAGE_INVALID',
        );
    }
}

export function createV219ReplayBudget(
    treatmentLogicalCalls: number,
): V219ReplayBudget {
    const plan = internalPlan(treatmentLogicalCalls);
    const stageState = Object.fromEntries(
        V219_REPLAY_BUDGET_STAGES.map(stage => [
            stage,
            {
                logicalCalls: 0,
                providerDispatches: 0,
                terminalDispatches: 0,
            },
        ]),
    ) as V219ReplayBudgetSnapshot['stages'];
    let totalLogicalCalls = 0;
    let totalProviderDispatches = 0;
    let reservedCostNanoUsd = 0;
    let usageMissingDispatches = 0;
    let estimatedCostNanoUsd = 0;

    const budget: V219ReplayBudget = Object.freeze({
        startLogicalCall(stage: V219ReplayBudgetStage) {
            assertStage(stage);
            const state = stageState[stage];
            const stageCeiling =
                plan.stages[stage].logicalCallCeiling;
            if (
                state.logicalCalls >= stageCeiling
                || totalLogicalCalls >= plan.totalLogicalCalls
            ) {
                throw new Error(
                    'ANALYSIS_V2_REPLAY_V219_LOGICAL_CALL_CEILING_EXCEEDED',
                );
            }
            state.logicalCalls++;
            totalLogicalCalls++;
        },
        reserveProviderDispatch(stage: V219ReplayBudgetStage) {
            assertStage(stage);
            const state = stageState[stage];
            const stagePlanValue = plan.stages[stage];
            const nextReserved = reservedCostNanoUsd
                + stagePlanValue.costNanoUsdPerDispatch;
            if (
                state.providerDispatches
                    >= stagePlanValue.providerDispatchCeiling
                || totalProviderDispatches
                    >= plan.totalProviderDispatches
            ) {
                throw new Error(
                    'ANALYSIS_V2_REPLAY_V219_DISPATCH_CEILING_EXCEEDED',
                );
            }
            if (nextReserved > plan.costCeilingNanoUsd) {
                throw new Error(
                    'ANALYSIS_V2_REPLAY_V219_COST_CEILING_EXCEEDED',
                );
            }
            state.providerDispatches++;
            totalProviderDispatches++;
            reservedCostNanoUsd = nextReserved;
        },
        recordProviderTerminal(
            stage: V219ReplayBudgetStage,
            estimatedCostUsdValue: number | null,
        ) {
            assertStage(stage);
            const state = stageState[stage];
            if (state.terminalDispatches >= state.providerDispatches) {
                throw new Error(
                    'ANALYSIS_V2_REPLAY_V219_TERMINAL_WITHOUT_DISPATCH',
                );
            }
            if (estimatedCostUsdValue === null) {
                usageMissingDispatches++;
            } else {
                if (
                    !Number.isFinite(estimatedCostUsdValue)
                    || estimatedCostUsdValue < 0
                    || estimatedCostUsdValue
                        > plan.stages[stage].costUsdPerDispatch
                ) {
                    throw new Error(
                        'ANALYSIS_V2_REPLAY_V219_COST_OBSERVATION_INVALID',
                    );
                }
                estimatedCostNanoUsd += Math.round(
                    estimatedCostUsdValue * NANO_USD_PER_USD,
                );
            }
            state.terminalDispatches++;
        },
        snapshot() {
            const terminalDispatches = Object.values(stageState).reduce(
                (sum, value) => sum + value.terminalDispatches,
                0,
            );
            const usageComplete = terminalDispatches
                === totalProviderDispatches
                && usageMissingDispatches === 0;
            return {
                logicalCalls: totalLogicalCalls,
                providerDispatches: totalProviderDispatches,
                reservedCostUsd: usd(reservedCostNanoUsd),
                costCeilingUsd: plan.costCeilingUsd,
                usageComplete,
                usageMissingDispatches,
                estimatedCostUsd: usageComplete
                    ? usd(estimatedCostNanoUsd)
                    : null,
                stages: Object.fromEntries(
                    Object.entries(stageState).map(([stage, value]) => [
                        stage,
                        { ...value },
                    ]),
                ) as V219ReplayBudgetSnapshot['stages'],
            };
        },
    });
    issuedBudgets.add(budget);
    return budget;
}

export function isIssuedV219ReplayBudget(
    value: unknown,
): value is V219ReplayBudget {
    return Boolean(value)
        && typeof value === 'object'
        && Object.isFrozen(value)
        && issuedBudgets.has(value as object);
}
