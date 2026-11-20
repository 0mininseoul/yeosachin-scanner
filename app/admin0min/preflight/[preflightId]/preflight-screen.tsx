'use client';

import type { PreflightStatusV1 } from '@/lib/contracts/analysis-v2';
import { AnalysisTargetCard } from '@/components/analysis-preflight-presentation';
import { AnalysisPlanCards, AnalysisPlanSection } from '@/components/analysis-plan-selection';

type ReadyPreflight = Extract<PreflightStatusV1, { status: 'ready' }>;

/** Read-only replay of the preflight result the user saw on /analyze. No checkout actions. */
export function PreflightScreen({ preflight }: { preflight: ReadyPreflight }) {
    return <>
        <AnalysisTargetCard target={preflight.target} />
        <AnalysisPlanSection>
            <AnalysisPlanCards plans={preflight.plans} requiredPlan={preflight.requiredPlan} selectedPlan={preflight.requiredPlan} />
        </AnalysisPlanSection>
    </>;
}
