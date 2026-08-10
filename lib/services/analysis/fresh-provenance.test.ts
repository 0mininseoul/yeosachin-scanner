import { describe, expect, it } from 'vitest';
import { assertFreshProviderProvenance, assertFreshProviderSet, FreshProvenanceError, type FreshRevenueRun } from './fresh-provenance';

const run: FreshRevenueRun = {
    requestId: '123e4567-e89b-42d3-a456-426614174000', preflightId: '123e4567-e89b-42d3-a456-426614174001', userId: '123e4567-e89b-42d3-a456-426614174002',
    targetUsername: 'winglss1', planId: 'basic', accessMode: 'test_entitlement',
    preflightRefreshedAt: '2026-08-10T01:00:00.000Z', requestCreatedAt: '2026-08-10T01:00:01.000Z',
};
const provider = (overrides: Partial<Parameters<typeof assertFreshProviderProvenance>[1]> = {}) => ({
    operationKey: 'relationship:followers', provider: 'apify' as const, runId: 'run-1', datasetId: 'dataset-1',
    startedAt: '2026-08-10T01:00:02.000Z', preflightId: run.preflightId, requestId: run.requestId,
    reused: false as const, adopted: false as const, fromCache: false as const, ...overrides,
});

describe('fresh revenue provenance', () => {
    it('requires provider lineage to start after fresh preflight', () => {
        expect(() => assertFreshProviderProvenance(run, provider({ startedAt: '2026-07-10T01:00:00.000Z' }))).toThrowError(new FreshProvenanceError('NOT_FRESH'));
        expect(() => assertFreshProviderProvenance(run, provider({ fromCache: true as unknown as false }))).toThrowError(new FreshProvenanceError('REUSED_ARTIFACT'));
    });
    it('rejects duplicate operations and accepts a fresh provider set', () => {
        expect(() => assertFreshProviderSet(run, [provider(), provider()])).toThrowError(new FreshProvenanceError('REUSED_ARTIFACT'));
        expect(() => assertFreshProviderSet(run, [provider(), provider({ operationKey: 'relationship:following', runId: 'run-2' })])).not.toThrow();
    });
});
