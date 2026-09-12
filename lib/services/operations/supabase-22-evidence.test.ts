import { describe, expect, it } from 'vitest';
import {
    evaluateSupabaseOperationalPolicy,
    parseSupabase22ApprovalRecord,
    SUPABASE_OPERATIONAL_FORBIDDEN_W1A,
    SUPABASE_OPERATIONAL_POLICY_SCHEMA,
    SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
    SUPABASE_OPERATIONAL_RETAINED_TABLES,
    SUPABASE_OPERATIONAL_W1A_UPPER_BOUND,
    SUPABASE_22_REQUIRED_TRAFFIC_OBJECTS,
    hashSupabaseOperationalPolicyClosure,
    type SupabaseOperationalPolicyClosure,
    type SupabaseOperationalPolicyInput,
} from './supabase-22-evidence';
import { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';

const HASH = 'a'.repeat(64);

const closure: SupabaseOperationalPolicyClosure = {
    tables: ['analysis_artifacts'],
    routines: ['record_analysis_canonical_job(uuid)'],
    flags: ['ANALYSIS_CANONICAL_JOBS_WRITE'],
    indexes: ['analysis_jobs_dispatch_idx'],
    triggers: ['public.analysis_events.analysis_events_append_only'],
    policies: ['analysis_jobs'],
    acls: ['analysis_jobs'],
    views: ['public.analysis_requests'],
    foreignKeys: ['public.analysis_jobs.analysis_jobs_request_id_fkey'],
    sequences: ['public.analysis_events_id_seq'],
    publications: ['supabase_realtime.public.analysis_events'],
    dependencies: ['public.analysis_jobs'],
};
const CLOSURE_HASH = hashSupabaseOperationalPolicyClosure(closure);

const archiveManifest = {
    source: 'independent-read-only' as const,
    observedAt: '2026-09-09T12:00:00.000Z',
    aggregateChecksum: HASH,
    restoreStatus: 'verified' as const,
    manifest: {
        schemaVersion: 'supabase-22-archive-manifest-v1' as const,
        selectedCount: 1,
        aggregateChecksum: HASH,
        encrypted: true as const,
        encryption: { algorithm: 'AES-256-GCM' as const },
        retentionClass: 'permanent',
    },
    restoreManifest: {
        schemaVersion: 'supabase-22-restore-manifest-v1' as const,
        selectedCount: 1,
        aggregateChecksum: HASH,
        encrypted: true as const,
        encryption: { algorithm: 'AES-256-GCM' as const },
        retentionClass: 'permanent',
    },
};

const catalogEvidence = {
    source: 'catalog-read-only' as const,
    observedAt: '2026-09-09T12:00:00.000Z',
    evidence: {
        sourceSha: SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
        status: 'ready' as const,
        clean: true,
        retainedTables: [...SUPABASE_OPERATIONAL_RETAINED_TABLES],
        forbiddenW1A: [...SUPABASE_OPERATIONAL_FORBIDDEN_W1A],
        operatorAuditTriggersClean: true,
        metadataAvailability: {
            catalog: true, acl: true, routine: true, trigger: true, dependency: true,
            migration: true, rls: true, view: true, publication: true, sequence: true,
            partition: true, foreignKey: true, legacyWriter: true,
        },
    },
} as never;

const completedBundleEvidence = {
    source: 'order-audit-read-only' as const,
    observedAt: '2026-09-09T12:00:00.000Z',
    genuineCompletedCount: 1,
    perOrderParityCount: 1,
    aggregateChecksum: HASH,
    parityStatus: 'ready' as const,
};

const rollbackEvidence = {
    families: SUPABASE_22_REQUIRED_TRAFFIC_OBJECTS.map(entry => ({
        family: entry.family,
        objectName: entry.objectName,
        source: 'bounded-read-only' as const,
        observedAt: '2026-09-09T12:00:00.000Z',
        sampleCount: 1,
        sampleLimit: 10,
        truncated: false as const,
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
    observationWindowClosed: true,
    observationEvidence: {
        source: 'bounded-read-only' as const,
        closed: true,
        closedAt: '2026-09-09T12:00:00.000Z',
        revision: 'old-revision',
        windowStart: '2026-09-09T11:00:00.000Z',
        windowEnd: '2026-09-09T12:00:00.000Z',
        drained: true,
    },
};

const approvalEvidence = {
    source: 'independent-read-only' as const,
    observedAt: '2026-09-09T12:00:00.000Z',
    allowlistHash: CLOSURE_HASH,
    approvedAt: '2026-09-09T12:00:00.000Z',
    approvedByRole: 'owner' as const,
    exactObjectCount: 1,
};

const paymentPendingEvidence = {
    source: 'payment_pending-read-only' as const,
    observedAt: '2026-09-09T12:00:00.000Z',
    sourceChecksum: HASH,
    pendingOrderCount: 1,
    independentlyEvidencedCount: 1,
    dispositionRecordedCount: 1,
};

function deferredReasons(approvedSubset: readonly string[] = []): Record<string, string> {
    return Object.fromEntries(
        SUPABASE_OPERATIONAL_W1A_UPPER_BOUND
            .filter(name => !approvedSubset.includes(name))
            .map(name => [name, 'fresh caller, dependency, and approval evidence is required']),
    );
}

function completeInput(
    overrides: Partial<SupabaseOperationalPolicyInput> = {},
): SupabaseOperationalPolicyInput {
    const approvedSubset = overrides.approvedSubset ?? [];
    return {
        schemaVersion: SUPABASE_OPERATIONAL_POLICY_SCHEMA,
        sourceSha: SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
        retained: [...SUPABASE_OPERATIONAL_RETAINED_TABLES],
        forbiddenW1A: [...SUPABASE_OPERATIONAL_FORBIDDEN_W1A],
        approvedSubset,
        deferredReasons: deferredReasons(approvedSubset),
        closureEvidence: {
            source: 'catalog-read-only',
            sourceSha: SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
            observedAt: '2026-09-09T12:00:00.000Z',
            closure,
            noCascadeAllowlistHash: CLOSURE_HASH,
        },
        catalogEvidence,
        completedBundleEvidence,
        archiveManifest,
        rollbackEvidence,
        approvalEvidence,
        paymentPendingEvidence,
        noActivationEvidence: {
            source: 'independent-read-only',
            observedAt: '2026-09-09T12:00:00.000Z',
            admissionActivated: false,
            realCanaryStarted: false,
        },
        ...overrides,
    };
}

describe('supabase-operational-policy-v1 evidence gate', () => {
    it('accepts a fresh approved subset without imposing a table-count invariant', () => {
        const approvedSubset = [SUPABASE_OPERATIONAL_W1A_UPPER_BOUND[0]];
        const result = evaluateSupabaseOperationalPolicy(completeInput({ approvedSubset }));

        expect(result.status).toBe('ready');
        expect(result.schemaVersion).toBe(SUPABASE_OPERATIONAL_POLICY_SCHEMA);
        expect(result.sourceSha).toBe(SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA);
        expect(result.approvedSubset).toEqual(approvedSubset);
        expect(result.destructiveOperations).toBe('refused');
    });

    it('requires an explicit deferred reason for every omitted W1A family', () => {
        const reasons = deferredReasons();
        delete reasons[SUPABASE_OPERATIONAL_W1A_UPPER_BOUND[1]];
        const result = evaluateSupabaseOperationalPolicy(completeInput({ deferredReasons: reasons }));

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toContain('deferred-reason');
    });

    it('rejects altered retained or forbidden classifications', () => {
        const retained = [...SUPABASE_OPERATIONAL_RETAINED_TABLES].slice(1);
        const result = evaluateSupabaseOperationalPolicy(completeInput({
            retained,
            forbiddenW1A: [...SUPABASE_OPERATIONAL_FORBIDDEN_W1A, 'unexpected_family'],
        }));

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'retained-invariant', 'forbidden-invariant',
        ]));
    });

    it('fails closed when fresh catalog or no-activation evidence is absent', () => {
        const result = evaluateSupabaseOperationalPolicy(completeInput({
            catalogEvidence: null,
            noActivationEvidence: null,
        }));

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'retained-catalog-proof', 'no-activation-or-canary',
        ]));
    });

    it('does not accept a missing no-CASCADE allowlist hash or empty closure', () => {
        const result = evaluateSupabaseOperationalPolicy(completeInput({
            closureEvidence: null,
        }));

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'closure-completeness', 'no-cascade-allowlist',
        ]));
    });

    it('rejects unsafe approval records and accepts only complete sanitized approvals', () => {
        expect(parseSupabase22ApprovalRecord({
            source: 'independent-read-only',
            observedAt: '2026-09-09T12:00:00.000Z',
            allowlistHash: HASH,
            approvedAt: '2026-09-09T12:00:00.000Z',
            approvedByRole: 'owner',
            exactObjectNames: ['analysis_artifacts'],
        })).toMatchObject({ exactObjectCount: 1 });

        expect(parseSupabase22ApprovalRecord({
            source: 'independent-read-only',
            observedAt: '2026-09-09T12:00:00.000Z',
            allowlistHash: null,
            approvedAt: null,
            approvedByRole: null,
            exactObjectNames: [],
        })).toMatchObject({ exactObjectCount: 0 });
    });

    it('rejects UUID, email, URL, and raw payload keys in evidence output', () => {
        expect(() => assertPiiSafeConsolidationOutput({
            operatorEmail: 'operator@example.com',
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
        expect(() => assertPiiSafeConsolidationOutput({
            sourceUrl: 'https://example.test/secret',
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
        expect(() => assertPiiSafeConsolidationOutput({
            rawPayload: { safe: false },
        })).toThrow('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
    });
});
