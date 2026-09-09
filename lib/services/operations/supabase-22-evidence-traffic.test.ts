import { describe, expect, it } from 'vitest';
import {
    collectSupabase22RollbackEvidence,
    evaluateSupabase22RollbackEvidence,
    isPaymentPendingDispositionRecorded,
    resolveFamilyReader,
    SUPABASE_22_REQUIRED_TRAFFIC_OBJECTS,
} from './supabase-22-evidence';

describe('Supabase 22 rollback and traffic evidence', () => {
    it('returns the legacy reader when a canonical shadow read mismatches', () => {
        expect(resolveFamilyReader({
            canonicalEnabled: true,
            shadowMismatch: true,
            legacyAvailable: true,
        })).toEqual({ reader: 'legacy', status: 'rollback_required' });
    });

    it('blocks when no legacy rollback reader remains', () => {
        expect(resolveFamilyReader({
            canonicalEnabled: true,
            shadowMismatch: false,
            legacyAvailable: false,
        })).toEqual({ reader: 'blocked', status: 'rollback_unavailable' });
    });

    it('requires server-only family flags, bounded retry queues, no legacy writers, and a closed window', () => {
        const evidence = evaluateSupabase22RollbackEvidence({
            families: [{
                family: 'analysis',
                objectName: 'analysis-jobs',
                source: 'bounded-read-only',
                observedAt: '2026-09-09T12:00:00.000Z',
                sampleCount: 1,
                sampleLimit: 10,
                truncated: false,
                serverOnly: true,
                legacyReaderAvailable: true,
                canonicalReaderEnabled: true,
                canonicalWriterEnabled: true,
                shadowMismatch: false,
                retryQueueCount: 0,
                retryQueueBounded: true,
                activeLegacyWriterCount: 0,
            }],
            activeLegacyWriterCount: 0,
            observationWindowClosed: true,
            observationEvidence: {
                source: 'bounded-read-only',
                closed: true,
                closedAt: '2026-09-09T12:00:00.000Z',
            },
        });

        expect(evidence).toMatchObject({ verified: false, observationWindowClosed: true });
        expect(evidence.missingGates).toContain('traffic-coverage');
    });

    it('keeps rollback evidence blocked when a family is not safe to cut over', () => {
        const evidence = evaluateSupabase22RollbackEvidence({
            families: [{
                family: 'commerce',
                objectName: 'payment-events',
                source: 'bounded-read-only',
                observedAt: '2026-09-09T12:00:00.000Z',
                sampleCount: 1,
                sampleLimit: 10,
                truncated: false,
                serverOnly: false,
                legacyReaderAvailable: false,
                canonicalReaderEnabled: true,
                canonicalWriterEnabled: true,
                shadowMismatch: true,
                retryQueueCount: 1,
                retryQueueBounded: false,
                activeLegacyWriterCount: 1,
            }],
            activeLegacyWriterCount: 1,
            observationWindowClosed: false,
            observationEvidence: {
                source: 'bounded-read-only',
                closed: false,
                closedAt: null,
            },
        });

        expect(evidence.verified).toBe(false);
        expect(evidence.familyReaders[0]).toEqual({ reader: 'blocked', status: 'rollback_unavailable' });
        expect(evidence.missingGates).toEqual(expect.arrayContaining([
            'server-only-flags',
            'legacy-reader',
            'bounded-retry-queue',
            'zero-legacy-writers',
            'observation-window',
        ]));
    });

    it('reads aggregate traffic counters through an explicitly bounded reader and never exposes family names in the result', async () => {
        const evidence = await collectSupabase22RollbackEvidence({
            readBoundedTrafficEvidence: async () => ({
                measurements: SUPABASE_22_REQUIRED_TRAFFIC_OBJECTS.map(entry => ({
                    ...entry,
                    observedAt: '2026-09-09T12:00:00.000Z',
                    sampleCount: 1,
                    sampleLimit: 10,
                    truncated: false,
                    serverOnly: true,
                    legacyReaderAvailable: true,
                    canonicalReaderEnabled: true,
                    canonicalWriterEnabled: true,
                    shadowMismatch: false,
                    retryQueueCount: 0,
                    retryQueueBounded: true,
                    activeLegacyWriterCount: 0,
                })),
                activeLegacyWriterCount: 0,
                observationEvidence: {
                    source: 'bounded-read-only',
                    closed: true,
                    closedAt: '2026-09-09T12:00:00.000Z',
                },
            }),
        });

        expect(evidence.verified).toBe(true);
        expect(JSON.stringify(evidence)).not.toContain('analysis');
    });

    it('rejects one-family boolean attestations when the bounded measurement set is incomplete', async () => {
        const evidence = await collectSupabase22RollbackEvidence({
            readBoundedTrafficEvidence: async () => ({
                measurements: [{
                    family: 'analysis',
                    objectName: 'analysis-jobs',
                    observedAt: '2026-09-09T12:00:00.000Z',
                    sampleCount: 1,
                    sampleLimit: 10,
                    truncated: false,
                    serverOnly: true,
                    legacyReaderAvailable: true,
                    canonicalReaderEnabled: true,
                    canonicalWriterEnabled: true,
                    shadowMismatch: false,
                    retryQueueCount: 0,
                    retryQueueBounded: true,
                    activeLegacyWriterCount: 0,
                }],
                activeLegacyWriterCount: 0,
                observationEvidence: {
                    source: 'bounded-read-only',
                    closed: true,
                    closedAt: '2026-09-09T12:00:00.000Z',
                },
            }),
        });

        expect(evidence.verified).toBe(false);
        expect(evidence.missingGates).toContain('traffic-coverage');
    });

    it('fails closed when only an unprovisioned RPC-shaped client is supplied', async () => {
        await expect(collectSupabase22RollbackEvidence({
            rpc: async () => ({ data: null, error: null }),
        })).rejects.toThrow('SUPABASE_22_TRAFFIC_READ_UNAVAILABLE');
    });

    it('rejects untrusted traffic fields before constructing output', async () => {
        await expect(collectSupabase22RollbackEvidence({
            readBoundedTrafficEvidence: async () => ({
                families: [{
                    family: 'analysis',
                    serverOnly: true,
                    legacyReaderAvailable: true,
                    canonicalReaderEnabled: true,
                    canonicalWriterEnabled: true,
                    shadowMismatch: false,
                    retryQueueCount: 0,
                    retryQueueBounded: true,
                    activeLegacyWriterCount: 0,
                    sentinel: 'do-not-emit',
                }],
                activeLegacyWriterCount: 0,
                observationWindowClosed: true,
            }),
        })).rejects.toThrow('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    });

    it('requires independent provider evidence and a disposition for every pending order', () => {
        expect(isPaymentPendingDispositionRecorded({
            pendingOrderCount: 1,
            independentlyEvidencedCount: 1,
            dispositionRecordedCount: 1,
        })).toBe(true);
        expect(isPaymentPendingDispositionRecorded({
            pendingOrderCount: 1,
            independentlyEvidencedCount: 0,
            dispositionRecordedCount: 1,
        })).toBe(false);
    });
});
