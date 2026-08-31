export type LegacyAnalysisProducerGateState = 'open' | 'frozen' | 'misconfigured';

/**
 * Returns the durable rollout gate for the old /analysis V1 producer surface.
 * An unset capacity stage preserves the pre-rollout local contract; once a
 * stage is explicitly selected, only the exact drain-and-block observation
 * may close the old producer.  Anything else fails closed so a typo cannot
 * silently reopen provider-spending V1 work during promotion.
 */
export function legacyAnalysisProducerGate(
    env: Record<string, string | undefined> = process.env,
): LegacyAnalysisProducerGateState {
    const stage = env.ANALYSIS_CAPACITY_STAGE?.trim().toLowerCase();
    if (!stage) return 'open';
    if (stage === 'bootstrap') return 'open';
    if (stage !== 'initial' && stage !== 'expanded') return 'misconfigured';
    const freezeMode = env.ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE?.trim().toLowerCase();
    const producersFrozen = env.ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN
        ?.trim().toLowerCase();
    if (freezeMode === 'drain-and-block' && producersFrozen === 'true') return 'frozen';
    return 'misconfigured';
}

export function legacyAnalysisProducerGateResponse(
    env: Record<string, string | undefined> = process.env,
): { status: number; code: 'LEGACY_ANALYSIS_FROZEN' | 'LEGACY_ANALYSIS_GATE_NOT_READY' } | null {
    const state = legacyAnalysisProducerGate(env);
    if (state === 'open') return null;
    return state === 'frozen'
        ? { status: 410, code: 'LEGACY_ANALYSIS_FROZEN' }
        : { status: 503, code: 'LEGACY_ANALYSIS_GATE_NOT_READY' };
}
