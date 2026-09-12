import { describe, expect, it } from 'vitest';
import {
    evaluateSupabaseOperationalPolicy,
    parseSupabase22ApprovalRecord,
    SUPABASE_OPERATIONAL_FORBIDDEN_W1A,
    SUPABASE_OPERATIONAL_POLICY_SCHEMA,
    SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
    SUPABASE_OPERATIONAL_RETAINED_TABLES,
    SUPABASE_OPERATIONAL_W1A_UPPER_BOUND,
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

const archiveManifest = {
    verified: true as const,
    aggregateChecksum: HASH,
    restoreStatus: 'verified' as const,
    manifest: {
        schemaVersion: 'supabase-22-archive-manifest-v1' as const,
        selectedCount: 1,
        aggregateChecksum: HASH,
        encrypted: true as const,
        encryption: { algorithm: 'AES-256-GCM', verified: true as const },
        retentionClass: 'permanent',
    },
    restoreManifest: {
        schemaVersion: 'supabase-22-restore-manifest-v1' as const,
        selectedCount: 1,
        aggregateChecksum: HASH,
        encrypted: true as const,
        encryption: { algorithm: 'AES-256-GCM', verified: true as const },
        retentionClass: 'permanent',
    },
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
        closure,
        noCascadeAllowlistHash: HASH,
        retainedInvariantVerified: true,
        forbiddenInvariantVerified: true,
        dependencyClean: true,
        migrationHistoryClean: true,
        genuineCompletedBundleEvidence: true,
        parityStatus: 'ready',
        archiveManifest,
        rollbackEvidenceVerified: true,
        observationWindowClosed: true,
        ownerApprovalRecorded: true,
        paymentPendingDispositionRecorded: true,
        noActivationOrCanary: true,
        noActivationEvidence: {
            source: 'independent-read-only',
            verified: true,
            admissionActivated: false,
            realCanaryStarted: false,
        },
        deferredReasons: deferredReasons(approvedSubset),
        archiveRestoreChecksumMatch: true,
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
            retainedInvariantVerified: false,
            noActivationEvidence: undefined,
        }));

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'retained-catalog-proof', 'no-activation-or-canary',
        ]));
    });

    it('does not accept a missing no-CASCADE allowlist hash or empty closure', () => {
        const result = evaluateSupabaseOperationalPolicy(completeInput({
            closure: {
                tables: [], routines: [], flags: [], indexes: [], triggers: [], policies: [],
                acls: [], views: [], foreignKeys: [], sequences: [], publications: [], dependencies: [],
            },
            noCascadeAllowlistHash: null,
        }));

        expect(result.status).toBe('blocked');
        expect(result.missingGates).toEqual(expect.arrayContaining([
            'closure-completeness', 'no-cascade-allowlist',
        ]));
    });

    it('rejects unsafe approval records and accepts only complete sanitized approvals', () => {
        expect(parseSupabase22ApprovalRecord({
            allowlistHash: HASH,
            approvedAt: '2026-09-09T12:00:00.000Z',
            approvedByRole: 'owner',
            exactObjectNames: ['analysis_artifacts'],
            signatureVerified: true,
        })).toMatchObject({ recorded: true });

        expect(parseSupabase22ApprovalRecord({
            allowlistHash: null,
            approvedAt: null,
            approvedByRole: null,
            exactObjectNames: [],
            signatureVerified: false,
        })).toMatchObject({ recorded: false });
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
