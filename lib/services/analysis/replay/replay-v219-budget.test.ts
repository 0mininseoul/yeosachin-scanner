import { describe, expect, it } from 'vitest';
import {
    createV219ReplayBudget,
    deriveV219ReplayBudgetPlan,
    isIssuedV219ReplayBudget,
    V219_CONTROL_LOGICAL_CALL_CEILING,
    V219_CONTROL_PROVIDER_DISPATCH_CEILING,
} from './replay-v219-budget';

describe('V2.19 replay paid budget', () => {
    it('derives exact control and maximum treatment ceilings', () => {
        const plan = deriveV219ReplayBudgetPlan(235);

        expect(plan.controlLogicalCalls).toBe(710);
        expect(plan.controlProviderDispatches).toBe(2_840);
        expect(plan.treatmentLogicalCalls).toBe(235);
        expect(plan.treatmentProviderDispatches).toBe(940);
        expect(plan.totalLogicalCalls).toBe(945);
        expect(plan.totalProviderDispatches).toBe(3_780);
        expect(plan.costCeilingUsd).toBe(121.1792);
        expect(V219_CONTROL_LOGICAL_CALL_CEILING).toBe(710);
        expect(V219_CONTROL_PROVIDER_DISPATCH_CEILING).toBe(2_840);
        expect(plan.stages.proGenderSecondLook).toMatchObject({
            model: 'gemini-3.1-pro-preview',
            logicalCallCeiling: 235,
            providerDispatchCeiling: 940,
            inputUnitsPerDispatch: 26_464,
            outputUnitsPerDispatch: 2_048,
            costUsdPerDispatch: 0.077504,
        });
    });

    it('derives treatment calls from the exact static cohort', () => {
        const plan = deriveV219ReplayBudgetPlan(44);

        expect(plan.totalLogicalCalls).toBe(754);
        expect(plan.totalProviderDispatches).toBe(3_016);
        expect(plan.costCeilingUsd).toBe(61.966144);
    });

    it.each([-1, 1.5, 236, Number.NaN])(
        'rejects invalid treatment cohort %s',
        value => {
            expect(() => deriveV219ReplayBudgetPlan(value))
                .toThrow('ANALYSIS_V2_REPLAY_V219_STATIC_COHORT_INVALID');
        },
    );

    it('enforces logical and provider ceilings before work is admitted', () => {
        const budget = createV219ReplayBudget(0);
        for (let index = 0; index < 235; index++) {
            budget.startLogicalCall('genderTriage');
        }
        expect(() => budget.startLogicalCall('genderTriage'))
            .toThrow('ANALYSIS_V2_REPLAY_V219_LOGICAL_CALL_CEILING_EXCEEDED');

        for (let index = 0; index < 940; index++) {
            budget.reserveProviderDispatch('genderTriage');
        }
        expect(() => budget.reserveProviderDispatch('genderTriage'))
            .toThrow('ANALYSIS_V2_REPLAY_V219_DISPATCH_CEILING_EXCEEDED');
        expect(budget.snapshot()).toMatchObject({
            logicalCalls: 235,
            providerDispatches: 940,
            reservedCostUsd: 9.80232,
            costCeilingUsd: 48.32544,
        });
    });

    it('issues a non-forgeable budget and never fabricates missing usage', () => {
        const budget = createV219ReplayBudget(1);
        expect(isIssuedV219ReplayBudget(budget)).toBe(true);
        expect(isIssuedV219ReplayBudget({
            ...budget,
        })).toBe(false);

        budget.startLogicalCall('proGenderSecondLook');
        budget.reserveProviderDispatch('proGenderSecondLook');
        budget.recordProviderTerminal('proGenderSecondLook', null);
        expect(budget.snapshot()).toMatchObject({
            usageComplete: false,
            usageMissingDispatches: 1,
            estimatedCostUsd: null,
        });
        budget.reserveProviderDispatch('proGenderSecondLook');
        budget.recordProviderTerminal('proGenderSecondLook', 0.01);
        expect(budget.snapshot()).toMatchObject({
            usageComplete: false,
            usageMissingDispatches: 1,
            estimatedCostUsd: null,
        });
    });

    it('fails closed before reserving a forged stage or excess USD', () => {
        const budget = createV219ReplayBudget(1);
        expect(() => budget.startLogicalCall('not-a-stage' as never))
            .toThrow('ANALYSIS_V2_REPLAY_V219_BUDGET_STAGE_INVALID');
        expect(() => budget.reserveProviderDispatch('not-a-stage' as never))
            .toThrow('ANALYSIS_V2_REPLAY_V219_BUDGET_STAGE_INVALID');
        expect(budget.snapshot()).toMatchObject({
            logicalCalls: 0,
            providerDispatches: 0,
            reservedCostUsd: 0,
        });
    });
});
