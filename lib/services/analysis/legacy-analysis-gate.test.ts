import { describe, expect, it } from 'vitest';
import { legacyAnalysisProducerGate } from './legacy-analysis-gate';

describe('legacy analysis producer gate', () => {
    it('keeps the pre-rollout and bootstrap contracts open', () => {
        expect(legacyAnalysisProducerGate({})).toBe('open');
        expect(legacyAnalysisProducerGate({ ANALYSIS_CAPACITY_STAGE: 'bootstrap' })).toBe('open');
    });

    it('freezes V1 producers only on the exact active drain contract', () => {
        expect(legacyAnalysisProducerGate({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
        })).toBe('frozen');
        expect(legacyAnalysisProducerGate({
            ANALYSIS_CAPACITY_STAGE: 'expanded',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'TRUE',
        })).toBe('frozen');
    });

    it('fails closed for an active stage without authoritative freeze evidence', () => {
        expect(legacyAnalysisProducerGate({ ANALYSIS_CAPACITY_STAGE: 'initial' })).toBe('misconfigured');
        expect(legacyAnalysisProducerGate({
            ANALYSIS_CAPACITY_STAGE: 'initial',
            ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
            ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'false',
        })).toBe('misconfigured');
    });
});
