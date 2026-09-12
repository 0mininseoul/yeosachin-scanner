import { createHash } from 'node:crypto';
import { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';

export { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const RETENTION_CLASS_PATTERN = /^(?:short|standard|permanent)$/;
const ARCHIVE_MANIFEST_SCHEMA = 'supabase-22-archive-manifest-v1' as const;
const RESTORE_MANIFEST_SCHEMA = 'supabase-22-restore-manifest-v1' as const;
const ARCHIVE_ENCRYPTION_ALGORITHM = 'AES-256-GCM' as const;

/** Versioned policy contract; table cardinality is observation data, never a gate. */
export const SUPABASE_OPERATIONAL_POLICY_SCHEMA = 'supabase-operational-policy-v1' as const;
export const SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA =
    '053d46326e7ecf45c02ebab9ae210ffe66624d00' as const;

export const SUPABASE_OPERATIONAL_RETAINED_TABLES = [
    'analysis_jobs', 'analysis_events',
    'analysis_provider_runs', 'analysis_v2_provider_runs',
    'payment_events', 'payment_pending', 'payments', 'payment_orders',
    'earlybird_orders', 'pending_analysis', 'maintenance_jobs',
    'analysis_order_audit_assembly_queue', 'analysis_order_audit_bundles',
    'analysis_order_audit_candidates', 'analysis_order_audit_interactions',
    'account_lifecycle',
] as const;

export const SUPABASE_OPERATIONAL_W1A_UPPER_BOUND = [
    'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
    'analysis_costs', 'fulfillment_jobs', 'notification_outbox',
    'system_configuration', 'system_leases',
] as const;

/** Objects whose retention/non-mutation must be proven before contraction. */
export const SUPABASE_OPERATIONAL_FORBIDDEN_W1A = [
    'analysis_jobs', 'analysis_events', 'analysis_provider_runs',
    'analysis_v2_provider_runs', 'payment_events', 'maintenance_jobs',
    'analysis_order_audit_assembly_queue', 'analysis_order_audit_bundles',
    'analysis_order_audit_candidates', 'analysis_order_audit_interactions',
    'account_lifecycle',
] as const;

export const SUPABASE_OPERATIONAL_RETAINED_OPERATOR_RPC_EXAMPLES = [
    'load_analysis_order_audit_bundle',
    'list_analysis_order_audit_bundles',
    'claim_analysis_order_audit_bundle',
    'read_analysis_order_audit_parity_snapshot',
] as const;

/** Every public operator-audit RPC retained by the design/schema contract. */
export const SUPABASE_OPERATIONAL_RETAINED_OPERATOR_RPC_NAMES = [
    'load_analysis_order_audit_bundle',
    'list_analysis_order_audit_bundle_recovery',
    'claim_analysis_order_audit_bundle',
    'release_analysis_order_audit_bundle',
    'enqueue_analysis_order_audit_bundle',
    'assemble_analysis_order_audit_bundle',
    'list_analysis_order_audit_bundles',
    'read_analysis_order_audit_parity_snapshot',
] as const;

/** Private operator-audit helpers are part of the retained contract as well. */
export const SUPABASE_OPERATIONAL_RETAINED_OPERATOR_HELPER_NAMES = [
    'analysis_order_audit_digest',
    'analysis_order_audit_redact_json',
    'analysis_order_audit_parity_attestation_is_safe',
    'prevent_analysis_order_audit_mutation',
    'analysis_order_audit_candidate_key_coverage',
    'analysis_order_audit_cost_source_hash',
    'analysis_order_audit_source_table_hash',
    'analysis_order_audit_purge_fence',
    'analysis_order_audit_summary_counts',
    'analysis_order_audit_retention_payload',
    'analysis_order_audit_enqueue_from_request',
    'analysis_order_audit_enqueue_from_request_id',
    'capture_analysis_order_audit_parity_attestation',
] as const;

/** Retained operator helpers that intentionally remain SECURITY INVOKER. */
export const SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES = [
    'analysis_order_audit_bundle_payload',
] as const;

/** Trigger names proven by the permanent operator-audit migrations. */
export const SUPABASE_OPERATIONAL_RETAINED_OPERATOR_TRIGGER_NAMES = [
    'prevent_analysis_order_audit_bundle_mutation',
    'prevent_analysis_order_audit_candidate_mutation',
    'prevent_analysis_order_audit_interaction_mutation',
    'enqueue_analysis_order_audit_after_request_finalization',
    'enqueue_analysis_order_audit_after_result_summary',
    'enqueue_analysis_order_audit_after_cost_snapshot',
    'enqueue_analysis_order_audit_after_cost_attribution',
    'capture_analysis_order_audit_parity_attestation_after_completion',
] as const;

/**
 * The ACL contract is deliberately split by capability. These sets mirror the
 * canonical migrations' explicit REVOKE/GRANT statements; they are never
 * inferred from observed catalog rows. The four analysis JSON validators are
 * intentionally omitted; the retained operator invoker helper is explicitly
 * included in the catalog query. Missing or cross-classified retained objects
 * keep catalog readiness blocked; unrelated catalog objects remain descriptive.
 */
export const SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES = [
    'reject_analysis_canonical_mutation',
    'reject_commerce_append_only_mutation',
    'canonical_json_string_v1',
    'canonical_json_number_v1',
    'canonical_json_v1',
    'canonical_json_hash_v1',
    'create_or_replay_landing_lead_exclusion',
    ...SUPABASE_OPERATIONAL_RETAINED_OPERATOR_HELPER_NAMES,
] as const;

export const SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES = [
    'record_analysis_canonical_job',
    'append_analysis_canonical_event',
    'enqueue_analysis_execution_retry_v1',
    'load_analysis_execution_family_v1',
    'record_payment_event_v1',
    'append_account_lifecycle_v1',
    'enqueue_maintenance_job_v1',
    'mirror_account_deletion_job_v1',
    'claim_maintenance_jobs_v1',
    'finish_maintenance_job_v1',
    'reconcile_stale_maintenance_jobs_v1',
    'backfill_account_deletion_jobs_v1',
    'collect_account_deletion_parity_v1',
    ...SUPABASE_OPERATIONAL_RETAINED_OPERATOR_RPC_NAMES,
    'create_or_replay_landing_lead_capture',
    'bind_landing_lead_journey_to_preflight',
    'claim_landing_lead_journey',
    'unlink_landing_lead_journey_after_deletion',
    'load_landing_lead_admin_projection',
    'fence_landing_leads_on_account_retirement',
] as const;

/** Browser-facing SECURITY DEFINER RPCs retain their migration ACLs exactly. */
export const SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES = [
    'claim_anonymous_analysis_v2_preflight_with_landing',
    'set_analysis_v2_preflight_exclusion_with_landing',
    'set_authenticated_analysis_v2_preflight_exclusion',
] as const;

/** Operational-policy union for callers that only need routine coverage. */
export const SUPABASE_OPERATIONAL_ROUTINE_NAMES = [
    ...SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES,
    ...SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES,
    ...SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES,
    ...SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES,
] as const;

/**
 * Exact PostgreSQL identity arguments for every SECURITY DEFINER routine in
 * the retained contract. Catalog evidence compares this map to
 * pg_get_function_identity_arguments(), never just to proname.
 */
export const SUPABASE_OPERATIONAL_ROUTINE_SIGNATURES = Object.freeze({
    reject_analysis_canonical_mutation: '',
    reject_commerce_append_only_mutation: '',
    canonical_json_string_v1: 'text',
    canonical_json_number_v1: 'jsonb',
    canonical_json_v1: 'jsonb,integer',
    canonical_json_hash_v1: 'text,jsonb',
    create_or_replay_landing_lead_exclusion: 'uuid,text',
    analysis_order_audit_digest: 'text',
    analysis_order_audit_redact_json: 'jsonb',
    analysis_order_audit_bundle_payload: 'analysis_order_audit_bundles',
    analysis_order_audit_parity_attestation_is_safe: 'jsonb',
    prevent_analysis_order_audit_mutation: '',
    analysis_order_audit_candidate_key_coverage: 'uuid',
    analysis_order_audit_cost_source_hash: 'uuid',
    analysis_order_audit_source_table_hash: 'text,uuid',
    analysis_order_audit_purge_fence: 'uuid,text',
    analysis_order_audit_summary_counts: 'uuid,integer',
    analysis_order_audit_retention_payload: 'uuid,integer,timestamptz',
    analysis_order_audit_enqueue_from_request: '',
    analysis_order_audit_enqueue_from_request_id: '',
    capture_analysis_order_audit_parity_attestation: '',
    record_analysis_canonical_job: 'uuid,text,text,text,bigint,integer,integer,timestamptz,timestamptz,text,jsonb,text',
    append_analysis_canonical_event: 'uuid,uuid,text,text,jsonb,text,text',
    enqueue_analysis_execution_retry_v1: 'uuid,text',
    load_analysis_execution_family_v1: 'uuid,text',
    record_payment_event_v1: 'text,text,text,text,uuid,text,text,text,jsonb,timestamptz,integer',
    append_account_lifecycle_v1: 'uuid,text,text,jsonb,text',
    enqueue_maintenance_job_v1: 'text,text,jsonb,text,boolean',
    mirror_account_deletion_job_v1: 'uuid',
    claim_maintenance_jobs_v1: 'integer,text,integer',
    finish_maintenance_job_v1: 'uuid,uuid,bigint,text,text,integer',
    reconcile_stale_maintenance_jobs_v1: 'integer',
    backfill_account_deletion_jobs_v1: 'integer,text',
    collect_account_deletion_parity_v1: '',
    load_analysis_order_audit_bundle: 'uuid,text,integer,integer,text',
    list_analysis_order_audit_bundle_recovery: 'integer',
    claim_analysis_order_audit_bundle: 'uuid,integer',
    release_analysis_order_audit_bundle: 'uuid,uuid,text,boolean',
    enqueue_analysis_order_audit_bundle: 'uuid',
    assemble_analysis_order_audit_bundle: 'uuid',
    list_analysis_order_audit_bundles: 'timestamptz,uuid,integer',
    read_analysis_order_audit_parity_snapshot: 'uuid',
    create_or_replay_landing_lead_capture: 'uuid,text,text,varchar,varchar',
    bind_landing_lead_journey_to_preflight: 'uuid,uuid',
    claim_landing_lead_journey: 'uuid,uuid',
    unlink_landing_lead_journey_after_deletion: 'uuid',
    load_landing_lead_admin_projection: 'text,text,text,timestamptz,timestamptz,timestamptz,uuid,integer',
    fence_landing_leads_on_account_retirement: '',
    claim_anonymous_analysis_v2_preflight_with_landing: 'uuid,varchar,uuid',
    set_analysis_v2_preflight_exclusion_with_landing: 'uuid,uuid,text,text,text',
    set_authenticated_analysis_v2_preflight_exclusion: 'uuid,uuid,text,text',
} as const);

export type SupabaseOperationalRoutineName = keyof typeof SUPABASE_OPERATIONAL_ROUTINE_SIGNATURES;

const retainedTableSet = new Set<string>(SUPABASE_OPERATIONAL_RETAINED_TABLES);
const canonicalPrivateRoutineSet = new Set<string>(SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES);
const canonicalInvokerRoutineSet = new Set<string>(SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES);
const canonicalServiceRpcSet = new Set<string>(SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES);
const canonicalClientRpcSet = new Set<string>(SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES);

const canonicalClientRpcAclExpectations = {
    claim_anonymous_analysis_v2_preflight_with_landing: {
        publicAllowed: false,
        anonAllowed: false,
        authenticatedAllowed: true,
        serviceRoleAllowed: false,
    },
    set_analysis_v2_preflight_exclusion_with_landing: {
        publicAllowed: false,
        anonAllowed: true,
        authenticatedAllowed: true,
        serviceRoleAllowed: false,
    },
    set_authenticated_analysis_v2_preflight_exclusion: {
        publicAllowed: false,
        anonAllowed: false,
        authenticatedAllowed: true,
        serviceRoleAllowed: false,
    },
} as const;

export type Supabase22GateStatus = 'ready' | 'mismatch' | 'blocked';
export type Supabase22ArchiveRestoreStatus = 'verified' | 'mismatch' | 'blocked' | 'not_run';

export type SupabaseOperationalPolicyClosure = Readonly<{
    tables: readonly string[];
    routines: readonly string[];
    flags: readonly string[];
    indexes: readonly string[];
    triggers: readonly string[];
    policies: readonly string[];
    acls: readonly string[];
    views: readonly string[];
    foreignKeys: readonly string[];
    sequences: readonly string[];
    publications: readonly string[];
    dependencies: readonly string[];
}>;

export type Supabase22EncryptionEvidence = Readonly<{
    algorithm: typeof ARCHIVE_ENCRYPTION_ALGORITHM;
}>;

export type Supabase22ArchiveManifest = Readonly<{
    schemaVersion: typeof ARCHIVE_MANIFEST_SCHEMA;
    selectedCount: number;
    aggregateChecksum: string;
    encrypted: boolean;
    encryption: Supabase22EncryptionEvidence;
    retentionClass: string;
}>;

export type Supabase22RestoreManifest = Readonly<{
    schemaVersion: typeof RESTORE_MANIFEST_SCHEMA;
    selectedCount: number;
    aggregateChecksum: string;
    encrypted: boolean;
    encryption: Supabase22EncryptionEvidence;
    retentionClass: string;
}>;

export type Supabase22ArchiveEvidence = Readonly<{
    /** This source is populated only by an independently read proof. */
    source: 'independent-read-only' | 'unavailable';
    observedAt: string | null;
    aggregateChecksum: string | null;
    restoreStatus: Supabase22ArchiveRestoreStatus;
    /** A parsed archive manifest is required for readiness; absence is blocked. */
    manifest?: Supabase22ArchiveManifest | null;
    /** A parsed isolated restore manifest is required for a verified restore. */
    restoreManifest?: Supabase22RestoreManifest | null;
}>;

export type Supabase22NoActivationEvidence = Readonly<{
    source: 'independent-read-only';
    observedAt: string;
    admissionActivated: false;
    realCanaryStarted: false;
}>;

export type Supabase22ClosureEvidence = Readonly<{
    source: 'catalog-read-only';
    sourceSha: typeof SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA;
    observedAt: string;
    closure: SupabaseOperationalPolicyClosure;
    noCascadeAllowlistHash: string;
}>;

export type Supabase22IndependentCatalogEvidence = Readonly<{
    source: 'catalog-read-only';
    observedAt: string;
    evidence: Supabase22CatalogEvidence;
}>;

export type Supabase22CompletedBundleEvidence = Readonly<{
    source: 'order-audit-read-only';
    observedAt: string;
    genuineCompletedCount: number;
    perOrderParityCount: number;
    aggregateChecksum: string;
    parityStatus: Supabase22GateStatus;
}>;

export type Supabase22ApprovalEvidence = Readonly<{
    source: 'independent-read-only';
    observedAt: string;
    allowlistHash: string;
    approvedAt: string;
    approvedByRole: 'owner' | 'operator';
    exactObjectCount: number;
}>;

export type SupabaseOperationalPolicyInput = Readonly<{
    schemaVersion: string;
    sourceSha: string;
    retained: readonly string[];
    forbiddenW1A: readonly string[];
    approvedSubset: readonly string[];
    deferredReasons: Readonly<Record<string, string>>;
    /** Every readiness input below is independently sourced or null. */
    closureEvidence: Supabase22ClosureEvidence | null;
    catalogEvidence: Supabase22IndependentCatalogEvidence | null;
    completedBundleEvidence: Supabase22CompletedBundleEvidence | null;
    archiveManifest: Supabase22ArchiveEvidence;
    /** Raw, bounded read-only traffic evidence; evaluation fields are derived later. */
    rollbackEvidence: Supabase22RollbackEvidenceInput | null;
    approvalEvidence: Supabase22ApprovalEvidence | null;
    paymentPendingEvidence: Supabase22PaymentPendingEvidence | null;
    noActivationEvidence: Supabase22NoActivationEvidence | null;
}>;

export type SupabaseOperationalPolicyEvidence = SupabaseOperationalPolicyInput & Readonly<{
    schemaVersion: typeof SUPABASE_OPERATIONAL_POLICY_SCHEMA;
    status: Supabase22GateStatus;
    missingGates: readonly string[];
    closure: SupabaseOperationalPolicyClosure;
    noCascadeAllowlistHash: string | null;
    genuineCompletedBundleEvidence: boolean;
    parityStatus: Supabase22GateStatus;
    rollbackEvidenceVerified: boolean;
    observationWindowClosed: boolean;
    ownerApprovalRecorded: boolean;
    paymentPendingDispositionRecorded: boolean;
    noActivationOrCanary: boolean;
    archiveRestoreChecksumMatch: boolean;
    destructiveOperations: 'refused';
}>;

const NO_ACTIVATION_EVIDENCE_KEYS = [
    'source', 'observedAt', 'admissionActivated', 'realCanaryStarted',
] as const;

function sortedUnique(values: readonly string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function addGate(gates: string[], gate: string): void {
    if (!gates.includes(gate)) gates.push(gate);
}

function isIndependentNoActivationEvidence(value: unknown): boolean {
    return isRecord(value)
        && Object.keys(value).length === NO_ACTIVATION_EVIDENCE_KEYS.length
        && NO_ACTIVATION_EVIDENCE_KEYS.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && value.source === 'independent-read-only'
        && typeof value.observedAt === 'string'
        && ISO_DATE_PATTERN.test(value.observedAt)
        && value.admissionActivated === false
        && value.realCanaryStarted === false;
}

function isSafeRetentionClass(value: unknown): value is string {
    return typeof value === 'string' && RETENTION_CLASS_PATTERN.test(value);
}

function isSafeEncryptionEvidence(value: unknown): value is Supabase22EncryptionEvidence {
    return isRecord(value)
        && Object.keys(value).length === 1
        && value.algorithm === ARCHIVE_ENCRYPTION_ALGORITHM
        && typeof value.algorithm === 'string';
}

export function isGenuineArchiveManifest(value: unknown): value is Supabase22ArchiveManifest {
    return isRecord(value)
        && value.schemaVersion === ARCHIVE_MANIFEST_SCHEMA
        && Number.isSafeInteger(value.selectedCount)
        && (value.selectedCount as number) > 0
        && typeof value.aggregateChecksum === 'string'
        && HASH_PATTERN.test(value.aggregateChecksum)
        && value.encrypted === true
        && isSafeEncryptionEvidence(value.encryption)
        && isSafeRetentionClass(value.retentionClass);
}

export function isGenuineRestoreManifest(value: unknown): value is Supabase22RestoreManifest {
    return isRecord(value)
        && value.schemaVersion === RESTORE_MANIFEST_SCHEMA
        && Number.isSafeInteger(value.selectedCount)
        && (value.selectedCount as number) >= 0
        && typeof value.aggregateChecksum === 'string'
        && HASH_PATTERN.test(value.aggregateChecksum)
        && value.encrypted === true
        && isSafeEncryptionEvidence(value.encryption)
        && isSafeRetentionClass(value.retentionClass);
}

function archiveManifestEvidenceClean(
    archive: Supabase22ArchiveEvidence,
    expectedCount: number,
): boolean {
    return archive.source === 'independent-read-only'
        && typeof archive.observedAt === 'string'
        && ISO_DATE_PATTERN.test(archive.observedAt)
        && typeof archive.aggregateChecksum === 'string'
        && HASH_PATTERN.test(archive.aggregateChecksum)
        && isGenuineArchiveManifest(archive.manifest)
        && archive.manifest.selectedCount === expectedCount
        && archive.manifest.aggregateChecksum === archive.aggregateChecksum;
}

function restoreManifestEvidenceClean(
    archive: Supabase22ArchiveEvidence,
    expectedCount: number,
): boolean {
    return archive.restoreStatus === 'verified'
        && isGenuineRestoreManifest(archive.restoreManifest)
        && archive.restoreManifest.selectedCount === expectedCount
        && archive.restoreManifest.aggregateChecksum === archive.aggregateChecksum
        && isGenuineArchiveManifest(archive.manifest)
        && archive.restoreManifest.retentionClass === archive.manifest.retentionClass;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
    if (new Set(left).size !== left.length || new Set(right).size !== right.length) {
        return false;
    }
    const normalize = (values: readonly string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
    return normalize(left).join('\u0000') === normalize(right).join('\u0000');
}

function operationalClosureComplete(closure: SupabaseOperationalPolicyClosure): boolean {
    if (!isRecord(closure)) return false;
    const values = Object.values(closure);
    return values.every(items => Array.isArray(items)
        && items.every(value => typeof value === 'string' && value.length > 0)
        && new Set(items).size === items.length)
        && closure.tables.length > 0
        && closure.routines.length > 0
        && closure.dependencies.length > 0;
}

function operationalArchiveEvidenceClean(archive: Supabase22ArchiveEvidence): boolean {
    return archiveManifestEvidenceClean(
        archive,
        isGenuineArchiveManifest(archive.manifest) ? archive.manifest.selectedCount : -1,
    ) && restoreManifestEvidenceClean(
        archive,
        isGenuineArchiveManifest(archive.manifest) ? archive.manifest.selectedCount : -1,
    );
}

const OPERATIONAL_CLOSURE_KEYS = [
    'tables', 'routines', 'flags', 'indexes', 'triggers', 'policies', 'acls',
    'views', 'foreignKeys', 'sequences', 'publications', 'dependencies',
] as const;

/** Hashes the canonical, sorted closure representation used by a later contract. */
export function hashSupabaseOperationalPolicyClosure(
    closure: SupabaseOperationalPolicyClosure,
): string {
    const normalized = Object.fromEntries(OPERATIONAL_CLOSURE_KEYS.map(key => [
        key,
        sortedUnique(closure[key]),
    ]));
    return createHash('sha256')
        .update('supabase-operational-policy:closure:v1\0', 'utf8')
        .update(JSON.stringify(normalized), 'utf8')
        .digest('hex');
}

function closureEvidenceClean(value: Supabase22ClosureEvidence | null): boolean {
    if (!value || value.source !== 'catalog-read-only'
        || value.sourceSha !== SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA
        || !ISO_DATE_PATTERN.test(value.observedAt)
        || !operationalClosureComplete(value.closure)
        || !HASH_PATTERN.test(value.noCascadeAllowlistHash)) {
        return false;
    }
    return value.noCascadeAllowlistHash === hashSupabaseOperationalPolicyClosure(value.closure);
}

function catalogEvidenceClean(value: Supabase22IndependentCatalogEvidence | null): boolean {
    if (!value || value.source !== 'catalog-read-only'
        || !ISO_DATE_PATTERN.test(value.observedAt)
        || !value.evidence
        || value.evidence.sourceSha !== SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA
        || value.evidence.status !== 'ready'
        || value.evidence.clean !== true
        || !sameStringSet(value.evidence.retainedTables, SUPABASE_OPERATIONAL_RETAINED_TABLES)
        || !sameStringSet(value.evidence.forbiddenW1A, SUPABASE_OPERATIONAL_FORBIDDEN_W1A)
        || value.evidence.operatorAuditTriggersClean !== true) {
        return false;
    }
    return Object.values(value.evidence.metadataAvailability).every(Boolean);
}

function completedBundleEvidenceClean(value: Supabase22CompletedBundleEvidence | null): boolean {
    return value !== null
        && value.source === 'order-audit-read-only'
        && ISO_DATE_PATTERN.test(value.observedAt)
        && Number.isSafeInteger(value.genuineCompletedCount)
        && value.genuineCompletedCount > 0
        && Number.isSafeInteger(value.perOrderParityCount)
        && value.perOrderParityCount === value.genuineCompletedCount
        && HASH_PATTERN.test(value.aggregateChecksum)
        && value.parityStatus === 'ready';
}

function approvalEvidenceClean(
    value: Supabase22ApprovalEvidence | null,
    allowlistHash: string | null,
): boolean {
    return value !== null
        && value.source === 'independent-read-only'
        && ISO_DATE_PATTERN.test(value.observedAt)
        && HASH_PATTERN.test(value.allowlistHash)
        && value.allowlistHash === allowlistHash
        && ISO_DATE_PATTERN.test(value.approvedAt)
        && (value.approvedByRole === 'owner' || value.approvedByRole === 'operator')
        && Number.isSafeInteger(value.exactObjectCount)
        && value.exactObjectCount > 0;
}

function paymentPendingEvidenceClean(value: Supabase22PaymentPendingEvidence | null): boolean {
    return value !== null
        && value.source === 'payment_pending-read-only'
        && ISO_DATE_PATTERN.test(value.observedAt)
        && HASH_PATTERN.test(value.sourceChecksum)
        && isPaymentPendingDispositionRecorded(value);
}

function noActivationEvidenceClean(value: Supabase22NoActivationEvidence | null): boolean {
    return isIndependentNoActivationEvidence(value);
}

/**
 * Evaluate the versioned operational policy. This is deliberately independent of
 * table cardinality: a fresh observation may approve any subset of the W1A upper
 * bound, and an omitted family must carry an explicit deferred reason.
 */
export function evaluateSupabaseOperationalPolicy(
    input: SupabaseOperationalPolicyInput,
): SupabaseOperationalPolicyEvidence {
    const missingGates: string[] = [];
    const retainedComplete = sameStringSet(input.retained, SUPABASE_OPERATIONAL_RETAINED_TABLES);
    const forbiddenComplete = sameStringSet(input.forbiddenW1A, SUPABASE_OPERATIONAL_FORBIDDEN_W1A);
    const approvedUnique = new Set(input.approvedSubset).size === input.approvedSubset.length;
    const approvedSubsetValid = approvedUnique
        && input.approvedSubset.every(name => SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.includes(name as never));
    const deferredReasons = input.deferredReasons;
    const deferredKeysValid = Object.keys(deferredReasons).every(name =>
        SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.includes(name as never));
    const deferredComplete = SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.every(name =>
        input.approvedSubset.includes(name)
        || typeof deferredReasons[name] === 'string' && deferredReasons[name].trim().length > 0,
    );
    if (input.schemaVersion !== SUPABASE_OPERATIONAL_POLICY_SCHEMA) addGate(missingGates, 'policy-version');
    if (input.sourceSha !== SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA) addGate(missingGates, 'policy-source');
    if (!retainedComplete) addGate(missingGates, 'retained-invariant');
    if (!forbiddenComplete) addGate(missingGates, 'forbidden-invariant');
    if (!approvedSubsetValid) addGate(missingGates, 'approved-subset');
    if (!deferredComplete || !deferredKeysValid) addGate(missingGates, 'deferred-reason');
    const closureReady = closureEvidenceClean(input.closureEvidence);
    const allowlistHash = closureReady && input.closureEvidence
        ? input.closureEvidence.noCascadeAllowlistHash
        : null;
    if (!closureReady) addGate(missingGates, 'closure-completeness');
    if (allowlistHash === null) addGate(missingGates, 'no-cascade-allowlist');
    const catalogReady = catalogEvidenceClean(input.catalogEvidence);
    if (!catalogReady) {
        addGate(missingGates, 'retained-catalog-proof');
        addGate(missingGates, 'forbidden-catalog-proof');
        addGate(missingGates, 'dependency-inventory');
        addGate(missingGates, 'migration-history');
    }
    const completedReady = completedBundleEvidenceClean(input.completedBundleEvidence);
    const parityStatus = input.completedBundleEvidence?.parityStatus ?? 'blocked';
    if (!completedReady) addGate(missingGates, 'genuine-completed-bundle');
    if (parityStatus !== 'ready') addGate(missingGates, 'per-order-parity');
    const archiveReady = operationalArchiveEvidenceClean(input.archiveManifest);
    if (!archiveReady) addGate(missingGates, 'archive-restore');
    const rollbackEvaluation = input.rollbackEvidence === null
        ? null
        : evaluateSupabase22RollbackEvidence(input.rollbackEvidence);
    const rollbackReady = rollbackEvaluation !== null
        && rollbackEvaluation.missingGates.length === 0;
    if (!rollbackReady) addGate(missingGates, 'rollback-evidence');
    const observationWindowClosed = rollbackEvaluation?.observationWindowClosed === true;
    if (!observationWindowClosed) addGate(missingGates, 'observation-window');
    const approvalReady = approvalEvidenceClean(input.approvalEvidence, allowlistHash);
    if (!approvalReady) addGate(missingGates, 'separate-approval');
    const paymentReady = paymentPendingEvidenceClean(input.paymentPendingEvidence);
    if (!paymentReady) addGate(missingGates, 'payment-pending-disposition');
    const noActivationReady = noActivationEvidenceClean(input.noActivationEvidence);
    if (!noActivationReady) addGate(missingGates, 'no-activation-or-canary');
    const genuineCompletedBundleEvidence = completedReady;
    const rollbackEvidenceVerified = rollbackReady;
    const ownerApprovalRecorded = approvalReady;
    const paymentPendingDispositionRecorded = paymentReady;
    const noActivationOrCanary = noActivationReady;
    const archiveRestoreChecksumMatch = archiveReady;
    const status: Supabase22GateStatus = missingGates.length === 0
        ? 'ready'
        : parityStatus === 'mismatch' ? 'mismatch' : 'blocked';
    const closure = input.closureEvidence?.closure ?? {
        tables: [], routines: [], flags: [], indexes: [], triggers: [], policies: [],
        acls: [], views: [], foreignKeys: [], sequences: [], publications: [], dependencies: [],
    };
    const evidence: SupabaseOperationalPolicyEvidence = {
        ...input,
        schemaVersion: SUPABASE_OPERATIONAL_POLICY_SCHEMA,
        retained: sortedUnique(input.retained),
        forbiddenW1A: sortedUnique(input.forbiddenW1A),
        approvedSubset: sortedUnique(input.approvedSubset),
        deferredReasons: Object.fromEntries(Object.entries(deferredReasons).sort(([a], [b]) => a.localeCompare(b))),
        closure,
        noCascadeAllowlistHash: allowlistHash,
        genuineCompletedBundleEvidence,
        parityStatus,
        rollbackEvidenceVerified,
        observationWindowClosed,
        ownerApprovalRecorded,
        paymentPendingDispositionRecorded,
        noActivationOrCanary,
        archiveRestoreChecksumMatch,
        status,
        missingGates,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(evidence);
    return evidence;
}

export type Supabase22ApprovalRecordInput = Readonly<{
    source: 'independent-read-only';
    observedAt: string;
    allowlistHash: string | null;
    approvedAt: string | null;
    approvedByRole: string | null;
    exactObjectNames: readonly string[];
}>;

/** Parse approval metadata without returning a signature, token, or operator identity. */
export function parseSupabase22ApprovalRecord(
    input: Supabase22ApprovalRecordInput,
): Supabase22ApprovalEvidence {
    const objectNames = input.exactObjectNames.filter(name =>
        typeof name === 'string' && SAFE_NAME_PATTERN.test(name));
    const valid = input.source === 'independent-read-only'
        && ISO_DATE_PATTERN.test(input.observedAt)
        && typeof input.allowlistHash === 'string'
        && HASH_PATTERN.test(input.allowlistHash)
        && typeof input.approvedAt === 'string'
        && ISO_DATE_PATTERN.test(input.approvedAt)
        && (input.approvedByRole === 'owner' || input.approvedByRole === 'operator')
        && objectNames.length > 0
        && objectNames.length === input.exactObjectNames.length;
    const result: Supabase22ApprovalEvidence = {
        source: 'independent-read-only',
        observedAt: valid ? input.observedAt : '',
        allowlistHash: valid ? input.allowlistHash! : '',
        approvedAt: valid ? input.approvedAt! : '',
        approvedByRole: valid ? input.approvedByRole as 'owner' | 'operator' : 'operator',
        exactObjectCount: valid ? objectNames.length : 0,
    };
    assertPiiSafeConsolidationOutput(result);
    return result;
}

export type Supabase22CatalogTable = Readonly<{
    name: string;
    relkind: 'r' | 'p';
    relpersistence?: string;
    rlsEnabled: boolean;
    forceRls?: boolean;
}>;

export type Supabase22CatalogRoutine = Readonly<{
    name: string;
    identityArguments?: string;
    securityDefiner: boolean;
    searchPathEmpty: boolean;
    executePublic: boolean;
    executeAnon: boolean;
    executeAuthenticated: boolean;
    executeServiceRole: boolean;
}>;

export type Supabase22CatalogAcl = Readonly<{
    objectName: string;
    objectKind: 'relation' | 'routine';
    resolved: boolean;
    /** One direct ACL/EXECUTE observation per role; never inferred from routine flags. */
    publicAllowed: boolean;
    anonAllowed: boolean;
    authenticatedAllowed: boolean;
    serviceRoleAllowed: boolean;
}>;

export type Supabase22CatalogDependency = Readonly<{
    /** Stable catalog object identity used to prove row-level coverage. */
    objectName: string;
    resolved: boolean;
    allowed: boolean;
    /** All pg_depend edges for this object, in deterministic order. */
    details?: readonly Supabase22CatalogDependencyDetail[];
}>;

export type Supabase22CatalogDependencyDetail = Readonly<{
    dependentObject: string;
    referencedObject: string;
    dependencyType: string;
    classId: string;
    refClassId: string;
    objectSubId: number;
    refObjectSubId: number;
    resolved: boolean;
    allowed: boolean;
}>;

export type Supabase22CatalogPolicyDetail = Readonly<{
    policyName: string;
    command?: string;
    roles?: readonly string[];
    usingExpression?: string | null;
    checkExpression?: string | null;
    permissive?: boolean;
}>;

export type Supabase22CatalogPolicy = Readonly<{
    tableName: string;
    enabled: boolean;
    /** All pg_policy rows for this table, in deterministic order. */
    details?: readonly Supabase22CatalogPolicyDetail[];
}>;

export type Supabase22CatalogMetadataAvailability = Readonly<{
    catalog: boolean;
    acl: boolean;
    routine: boolean;
    trigger: boolean;
    dependency: boolean;
    migration: boolean;
    rls: boolean;
    view: boolean;
    publication: boolean;
    sequence: boolean;
    partition: boolean;
    foreignKey: boolean;
    legacyWriter: boolean;
}>;

export type Supabase22CatalogSnapshot = Readonly<{
    tables: readonly Supabase22CatalogTable[];
    acls: readonly Supabase22CatalogAcl[];
    dependencies: readonly Supabase22CatalogDependency[];
    foreignKeys: readonly Supabase22CatalogDependency[];
    securityDefinerFunctions: readonly Supabase22CatalogRoutine[];
    migrationHistory: readonly Readonly<{ version: string; pending?: boolean }>[];
    /** One independently measured legacy-writer row per relevant object. */
    legacyWriters: readonly Readonly<{ objectName: string; active: boolean }>[];
    views: readonly Supabase22CatalogDependency[];
    sequences: readonly Supabase22CatalogDependency[];
    partitions: readonly Supabase22CatalogDependency[];
    publications: readonly Supabase22CatalogDependency[];
    triggers: readonly Supabase22CatalogDependency[];
    policies: readonly Supabase22CatalogPolicy[];
    /** Every catalog query must explicitly attest that its result is available. */
    metadataAvailability: Supabase22CatalogMetadataAvailability;
}>;

export type Supabase22CatalogEvidence = Readonly<{
    schemaVersion: typeof SUPABASE_OPERATIONAL_POLICY_SCHEMA;
    sourceSha: typeof SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA;
    status: 'ready' | 'blocked';
    publicTableCount: number;
    canonicalTables: readonly string[];
    unexpectedTables: readonly string[];
    missingTables: readonly string[];
    dependencyClean: boolean;
    migrationHistoryClean: boolean;
    rlsClean: boolean;
    routinesClean: boolean;
    canonicalRelationsAclClean: boolean;
    privateRoutinesAclClean: boolean;
    serviceRpcsAclClean: boolean;
    clientRpcsAclClean: boolean;
    aclClean: boolean;
    triggersClean: boolean;
    foreignKeysClean: boolean;
    viewsClean: boolean;
    publicationsClean: boolean;
    sequencesClean: boolean;
    partitionsClean: boolean;
    legacyWritersClean: boolean;
    operatorAuditTriggersClean: boolean;
    metadataAvailability: Supabase22CatalogMetadataAvailability;
    retainedTables: readonly string[];
    forbiddenW1A: readonly string[];
    approvedSubset: readonly string[];
    deferredReasons: Readonly<Record<string, string>>;
    closure: SupabaseOperationalPolicyClosure;
    noCascadeAllowlistHash: string | null;
    clean: boolean;
    destructiveOperations: 'refused';
}>;

function isSafeSecurityDefinerDefinition(routine: Supabase22CatalogRoutine): boolean {
    return routine.securityDefiner === true
        && routine.searchPathEmpty === true;
}

export function isSafeSecurityDefinerRoutine(routine: Supabase22CatalogRoutine): boolean {
    return isSafeSecurityDefinerDefinition(routine)
        && routine.executePublic === false
        && routine.executeAnon === false
        && routine.executeAuthenticated === false;
}

export function isSafePrivateSecurityDefinerRoutine(
    routine: Supabase22CatalogRoutine,
): boolean {
    return isSafeSecurityDefinerRoutine(routine)
        && routine.executeServiceRole === false;
}

export function isSafeServiceRpcRoutine(
    routine: Supabase22CatalogRoutine,
): boolean {
    return isSafeSecurityDefinerRoutine(routine)
        && routine.executeServiceRole === true;
}

function isSafeClientRpcRoutine(
    routine: Supabase22CatalogRoutine,
): boolean {
    const name = comparableCatalogRoutineName(routine.name);
    const expected = canonicalClientRpcAclExpectations[name as keyof typeof canonicalClientRpcAclExpectations];
    return expected !== undefined
        && isSafeSecurityDefinerDefinition(routine)
        && routine.executePublic === expected.publicAllowed
        && routine.executeAnon === expected.anonAllowed
        && routine.executeAuthenticated === expected.authenticatedAllowed
        && routine.executeServiceRole === expected.serviceRoleAllowed;
}

function catalogObjectsClean(
    values: readonly Supabase22CatalogDependency[],
    requireEvidence = false,
): boolean {
    if (requireEvidence && values.length === 0) return false;
    const objectNames = values.map(value => value.objectName);
    return objectNames.every(name => typeof name === 'string' && name.length > 0)
        && new Set(objectNames).size === objectNames.length
        && values.every(value => value.resolved === true && value.allowed === true);
}

function operatorAuditTriggerContractClean(
    values: readonly Supabase22CatalogDependency[],
): boolean {
    return SUPABASE_OPERATIONAL_RETAINED_OPERATOR_TRIGGER_NAMES.every(expected =>
        values.some(value => {
            const objectName = comparableCatalogObjectName(value.objectName);
            return objectName.endsWith(`.${expected}`)
                && value.resolved === true
                && value.allowed === true;
        }),
    );
}

function catalogDependencyDetailsClean(value: Supabase22CatalogDependency): boolean {
    if (!Array.isArray(value.details)) return false;
    const detailKeys = new Set<string>();
    return value.details.every(detail => {
        if (!isRecord(detail)
            || typeof detail.dependentObject !== 'string'
            || typeof detail.referencedObject !== 'string'
            || typeof detail.dependencyType !== 'string'
            || typeof detail.classId !== 'string'
            || typeof detail.refClassId !== 'string'
            || !Number.isSafeInteger(detail.objectSubId)
            || (detail.objectSubId as number) < 0
            || !Number.isSafeInteger(detail.refObjectSubId)
            || (detail.refObjectSubId as number) < 0
            || typeof detail.resolved !== 'boolean'
            || typeof detail.allowed !== 'boolean') {
            return false;
        }
        const key = [
            detail.dependentObject,
            detail.referencedObject,
            detail.dependencyType,
            detail.classId,
            detail.refClassId,
            String(detail.objectSubId),
            String(detail.refObjectSubId),
        ].join('\u0000');
        if (detailKeys.has(key)) return false;
        detailKeys.add(key);
        return true;
    });
}

function catalogPolicyDetailsClean(value: Supabase22CatalogPolicy): boolean {
    if (!Array.isArray(value.details)) return false;
    const policyNames = new Set<string>();
    return value.details.every(detail => {
        if (!isRecord(detail)
            || typeof detail.policyName !== 'string'
            || policyNames.has(detail.policyName)) {
            return false;
        }
        policyNames.add(detail.policyName);
        return true;
    });
}

function comparableCatalogObjectName(value: unknown): string {
    if (typeof value !== 'string') return '';
    return value.trim()
        .replace(/^public\./i, '')
        .replace(/^"|"$/g, '')
        .toLowerCase();
}

function comparableCatalogRoutineName(value: unknown): string {
    const normalized = comparableCatalogObjectName(value);
    const signatureStart = normalized.indexOf('(');
    return signatureStart < 0 ? normalized : normalized.slice(0, signatureStart);
}

function normalizeCatalogIdentityArguments(value: string): string {
    return value
        .trim()
        .replace(/\bcharacter varying\b/gi, 'varchar')
        .replace(/\btimestamp with time zone\b/gi, 'timestamptz')
        .replace(/\btimestamp without time zone\b/gi, 'timestamp')
        .replace(/\bdouble precision\b/gi, 'float8')
        .replace(/\bboolean\b/gi, 'bool')
        .replace(/\s*,\s*/g, ',')
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function comparableCatalogRoutineIdentity(
    value: Pick<Supabase22CatalogRoutine, 'name' | 'identityArguments'> | string,
): string {
    if (typeof value === 'string') {
        const normalized = comparableCatalogObjectName(value);
        const signatureStart = normalized.indexOf('(');
        if (signatureStart < 0) return `${normalized}()`;
        const name = normalized.slice(0, signatureStart);
        const args = normalized.slice(signatureStart + 1, normalized.endsWith(')') ? -1 : undefined);
        return `${name}(${normalizeCatalogIdentityArguments(args)})`;
    }
    return `${comparableCatalogRoutineName(value.name)}(${normalizeCatalogIdentityArguments(
        value.identityArguments ?? '',
    )})`;
}

function expectedRoutineIdentity(name: string): string {
    const signature = SUPABASE_OPERATIONAL_ROUTINE_SIGNATURES[
        name as SupabaseOperationalRoutineName
    ];
    return `${comparableCatalogRoutineName(name)}(${normalizeCatalogIdentityArguments(signature ?? '')})`;
}

/** Stable `proname(identity arguments)` form shared by producers and tests. */
export function formatSupabaseOperationalRoutineIdentity(name: string): string {
    return expectedRoutineIdentity(name);
}

const SUPABASE_OPERATIONAL_ROUTINE_IDENTITIES = Object.keys(
    SUPABASE_OPERATIONAL_ROUTINE_SIGNATURES,
).map(expectedRoutineIdentity);

function completeObjectCoverage(
    values: readonly Readonly<{ objectName: string }>[],
    expectedObjectNames: readonly string[],
    exact = true,
): boolean {
    if (values.length === 0 || expectedObjectNames.length === 0) return false;
    const observed = values.map(value => comparableCatalogObjectName(value.objectName));
    const expected = expectedObjectNames.map(comparableCatalogObjectName);
    return observed.every(name => name.length > 0)
        && new Set(observed).size === observed.length
        && new Set(expected).size === expected.length
        && (!exact || observed.length === expected.length)
        && expected.every(name => observed.includes(name));
}

function completeRoutineCoverage(
    values: readonly Supabase22CatalogRoutine[],
): boolean {
    if (values.length === 0) return false;
    const observed = values.map(comparableCatalogRoutineIdentity);
    const expected = SUPABASE_OPERATIONAL_ROUTINE_IDENTITIES;
    return values.every(value => typeof value.identityArguments === 'string')
        && observed.every(identity => identity.length > 2)
        && new Set(observed).size === observed.length
        && new Set(expected).size === expected.length
        && expected.every(identity => observed.includes(identity));
}

function aclCoverage(
    values: readonly Supabase22CatalogAcl[],
    expectedObjectNames: readonly string[],
    objectKind: Supabase22CatalogAcl['objectKind'],
    predicate: (acl: Supabase22CatalogAcl) => boolean,
): boolean {
    if (values.length === 0 || expectedObjectNames.length === 0) return false;
    const normalize = objectKind === 'routine'
        ? comparableCatalogRoutineIdentity
        : (value: string) => comparableCatalogObjectName(value);
    const expected = expectedObjectNames.map(normalize);
    const observed = values
        .filter(value => value.objectKind === objectKind)
        .map(value => normalize(value.objectName));
    const expectedRows = values.filter(value => value.objectKind === objectKind
        && expected.includes(normalize(value.objectName)));
    return values.every(value => value.resolved === true)
        && observed.every(name => name.length > 0)
        && new Set(observed).size === observed.length
        && new Set(expected).size === expected.length
        && expectedRows.length === expected.length
        && expectedRows.every(predicate);
}

function privateRoutineConfigurationClean(
    routines: readonly Supabase22CatalogRoutine[],
): boolean {
    const category = routines.filter(routine =>
        canonicalPrivateRoutineSet.has(comparableCatalogRoutineName(routine.name)));
    return category.length === SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES.length
        && new Set(category.map(routine => comparableCatalogRoutineName(routine.name))).size
            === category.length
        && category.every(routine => {
            const name = comparableCatalogRoutineName(routine.name);
            return canonicalPrivateRoutineSet.has(name)
                && isSafePrivateSecurityDefinerRoutine(routine);
        });
}

function invokerRoutineConfigurationClean(
    routines: readonly Supabase22CatalogRoutine[],
): boolean {
    const category = routines.filter(routine =>
        canonicalInvokerRoutineSet.has(comparableCatalogRoutineName(routine.name)));
    return category.length === SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES.length
        && new Set(category.map(routine => comparableCatalogRoutineName(routine.name))).size
            === category.length
        && category.every(routine => {
            const name = comparableCatalogRoutineName(routine.name);
            return canonicalInvokerRoutineSet.has(name)
                && routine.securityDefiner === false
                && routine.searchPathEmpty === true;
        });
}

function serviceRpcConfigurationClean(
    routines: readonly Supabase22CatalogRoutine[],
): boolean {
    const category = routines.filter(routine =>
        canonicalServiceRpcSet.has(comparableCatalogRoutineName(routine.name)));
    return category.length === SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES.length
        && new Set(category.map(routine => comparableCatalogRoutineName(routine.name))).size
            === category.length
        && category.every(routine => {
            const name = comparableCatalogRoutineName(routine.name);
            return canonicalServiceRpcSet.has(name)
                && isSafeServiceRpcRoutine(routine);
        });
}

function clientRpcConfigurationClean(
    routines: readonly Supabase22CatalogRoutine[],
): boolean {
    const category = routines.filter(routine =>
        canonicalClientRpcSet.has(comparableCatalogRoutineName(routine.name)));
    return category.length === SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES.length
        && new Set(category.map(routine => comparableCatalogRoutineName(routine.name))).size
            === category.length
        && category.every(isSafeClientRpcRoutine);
}

/** Evaluate normalized PostgreSQL catalog rows. This function never repairs the catalog. */
export function evaluateSupabase22Catalog(
    snapshot: Supabase22CatalogSnapshot,
): Supabase22CatalogEvidence {
    const source = isRecord(snapshot)
        ? snapshot as Partial<Supabase22CatalogSnapshot>
        : {};
    const tables = Array.isArray(source.tables) ? source.tables : [];
    const acls = Array.isArray(source.acls) ? source.acls : null;
    const dependencies = Array.isArray(source.dependencies) ? source.dependencies : null;
    const foreignKeys = Array.isArray(source.foreignKeys) ? source.foreignKeys : null;
    const routines = Array.isArray(source.securityDefinerFunctions)
        ? source.securityDefinerFunctions : null;
    const migrationHistory = Array.isArray(source.migrationHistory)
        ? source.migrationHistory : null;
    const legacyWriters = Array.isArray(source.legacyWriters) ? source.legacyWriters : null;
    const views = Array.isArray(source.views) ? source.views : null;
    const sequences = Array.isArray(source.sequences) ? source.sequences : null;
    const partitions = Array.isArray(source.partitions) ? source.partitions : null;
    const publications = Array.isArray(source.publications) ? source.publications : null;
    const triggers = Array.isArray(source.triggers) ? source.triggers : null;
    const policies = Array.isArray(source.policies) ? source.policies : null;
    const availability = isRecord(source.metadataAvailability)
        ? source.metadataAvailability as Partial<Supabase22CatalogMetadataAvailability>
        : null;
    const metadataAvailability: Supabase22CatalogMetadataAvailability = {
        catalog: availability?.catalog === true,
        acl: availability?.acl === true,
        routine: availability?.routine === true,
        trigger: availability?.trigger === true,
        dependency: availability?.dependency === true,
        migration: availability?.migration === true,
        rls: availability?.rls === true,
        view: availability?.view === true,
        publication: availability?.publication === true,
        sequence: availability?.sequence === true,
        partition: availability?.partition === true,
        foreignKey: availability?.foreignKey === true,
        legacyWriter: availability?.legacyWriter === true,
    };
    const metadataComplete = Object.values(metadataAvailability).every(Boolean)
        && acls !== null
        && dependencies !== null
        && foreignKeys !== null
        && routines !== null
        && migrationHistory !== null
        && legacyWriters !== null
        && views !== null
        && sequences !== null
        && partitions !== null
        && publications !== null
        && triggers !== null
        && policies !== null;
    const publicTables = tables
        .filter(table => table.relkind === 'r' || table.relkind === 'p')
        .map(table => table.name)
        .sort((left, right) => left.localeCompare(right));
    const canonicalTables = publicTables.filter(name => retainedTableSet.has(name));
    const unexpectedTables = publicTables.filter(name => !retainedTableSet.has(name));
    const missingTables = SUPABASE_OPERATIONAL_RETAINED_TABLES.filter(name => !publicTables.includes(name));
    const rlsClean = metadataAvailability.rls
        && publicTables.length > 0
        && tables
            .filter(table => table.relkind === 'r' || table.relkind === 'p')
            .every(table => table.rlsEnabled === true && table.forceRls === true);
    const canonicalRoutineCoverage = routines !== null && completeRoutineCoverage(routines);
    const privateRoutineConfigClean = routines !== null
        && canonicalRoutineCoverage
        && privateRoutineConfigurationClean(routines);
    const serviceRpcConfigClean = routines !== null
        && canonicalRoutineCoverage
        && serviceRpcConfigurationClean(routines);
    const clientRpcConfigClean = routines !== null
        && canonicalRoutineCoverage
        && clientRpcConfigurationClean(routines);
    const relationAclRows = acls?.filter(acl => acl.objectKind === 'relation') ?? null;
    const routineAclRows = acls?.filter(acl => acl.objectKind === 'routine') ?? null;
    const routineAclCoverage = routineAclRows !== null
        && aclCoverage(
            routineAclRows,
            SUPABASE_OPERATIONAL_ROUTINE_IDENTITIES,
            'routine',
            acl => acl.resolved === true,
        );
    const canonicalRelationsAclClean = metadataAvailability.acl
        && acls !== null
        && relationAclRows !== null
        && aclCoverage(
            relationAclRows,
            SUPABASE_OPERATIONAL_RETAINED_TABLES,
            'relation',
            acl => acl.resolved === true
                && acl.publicAllowed === false
                && acl.anonAllowed === false
                && acl.authenticatedAllowed === false
                && acl.serviceRoleAllowed === false,
        );
    const privateRoutinesAclClean = metadataAvailability.acl
        && metadataAvailability.routine
        && acls !== null
        && routineAclRows !== null
        && routineAclCoverage
        && privateRoutineConfigClean
        && invokerRoutineConfigurationClean(routines ?? [])
        && aclCoverage(
            routineAclRows.filter(acl => {
                const routineName = comparableCatalogRoutineName(acl.objectName);
                return canonicalPrivateRoutineSet.has(routineName)
                    || canonicalInvokerRoutineSet.has(routineName);
            }),
            [
                ...SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES,
                ...SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES,
            ].map(expectedRoutineIdentity),
            'routine',
            acl => acl.resolved === true
                && acl.publicAllowed === false
                && acl.anonAllowed === false
                && acl.authenticatedAllowed === false
                && acl.serviceRoleAllowed === false,
        );
    const serviceRpcsAclClean = metadataAvailability.acl
        && metadataAvailability.routine
        && acls !== null
        && routineAclRows !== null
        && routineAclCoverage
        && serviceRpcConfigClean
        && aclCoverage(
            routineAclRows.filter(acl => canonicalServiceRpcSet.has(
                comparableCatalogRoutineName(acl.objectName),
            )),
            SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES.map(expectedRoutineIdentity),
            'routine',
            acl => acl.resolved === true
                && acl.publicAllowed === false
                && acl.anonAllowed === false
                && acl.authenticatedAllowed === false
                && acl.serviceRoleAllowed === true,
        );
    const clientRpcsAclClean = metadataAvailability.acl
        && metadataAvailability.routine
        && acls !== null
        && routineAclRows !== null
        && routineAclCoverage
        && clientRpcConfigClean
        && aclCoverage(
            routineAclRows.filter(acl => canonicalClientRpcSet.has(
                comparableCatalogRoutineName(acl.objectName),
            )),
            SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES.map(expectedRoutineIdentity),
            'routine',
            acl => {
                const routineName = comparableCatalogRoutineName(acl.objectName);
                const expected = canonicalClientRpcAclExpectations[
                    routineName as keyof typeof canonicalClientRpcAclExpectations
                ];
                return expected !== undefined
                    && acl.resolved === true
                    && acl.publicAllowed === expected.publicAllowed
                    && acl.anonAllowed === expected.anonAllowed
                    && acl.authenticatedAllowed === expected.authenticatedAllowed
                    && acl.serviceRoleAllowed === expected.serviceRoleAllowed;
            },
        );
    const routinesClean = metadataAvailability.routine
        && routines !== null
        && routines.length > 0
        && canonicalRoutineCoverage
        && privateRoutineConfigClean
        && invokerRoutineConfigurationClean(routines)
        && serviceRpcConfigClean
        && clientRpcConfigClean;
    const aclClean = canonicalRelationsAclClean
        && privateRoutinesAclClean
        && serviceRpcsAclClean
        && clientRpcsAclClean;
    const relevantDependencyObjects = [
        ...publicTables,
        ...(routines ?? []).map(routine => routine.identityArguments !== undefined
            ? `${routine.name}(${routine.identityArguments})`
            : routine.name),
    ];
    const dependencyClean = metadataAvailability.dependency
        && dependencies !== null
        && catalogObjectsClean(dependencies, true)
        && dependencies.every(catalogDependencyDetailsClean)
        // pg_depend also reports dependent objects such as policies, triggers,
        // and rewrite rules. Those extra rows are valid evidence; every table
        // and security-definer routine still needs a covered aggregate row.
        && completeObjectCoverage(dependencies, relevantDependencyObjects, false);
    const foreignKeysClean = metadataAvailability.foreignKey
        && foreignKeys !== null
        && catalogObjectsClean(foreignKeys);
    const migrationHistoryClean = metadataAvailability.migration
        && migrationHistory !== null
        && migrationHistory.length > 0
        && migrationHistory.every(migration =>
            typeof migration.version === 'string'
            && migration.version.length > 0
            && migration.pending !== true);
    const policiesClean = metadataAvailability.rls
        && policies !== null
        && completeObjectCoverage(
            policies.map(policy => ({ objectName: policy.tableName })),
            publicTables,
        )
        && policies.every(policy => policy.enabled === true && catalogPolicyDetailsClean(policy));
    const legacyWritersClean = metadataAvailability.legacyWriter
        && legacyWriters !== null
        && completeObjectCoverage(legacyWriters, publicTables)
        && legacyWriters.every(writer => writer.active === false);
    const viewsClean = metadataAvailability.view && views !== null && catalogObjectsClean(views);
    const sequencesClean = metadataAvailability.sequence
        && sequences !== null && catalogObjectsClean(sequences);
    const partitionsClean = metadataAvailability.partition
        && partitions !== null && catalogObjectsClean(partitions);
    const publicationsClean = metadataAvailability.publication
        && publications !== null && catalogObjectsClean(publications);
    const operatorAuditTriggersClean = metadataAvailability.trigger
        && triggers !== null
        && operatorAuditTriggerContractClean(triggers);
    const triggersClean = metadataAvailability.trigger
        && triggers !== null
        && catalogObjectsClean(triggers)
        && operatorAuditTriggersClean;
    // The live catalog may contain active-runtime and historical tables outside
    // this policy.  Only the retained contract is an invariant; extras are
    // reported for classification and never treated as a numeric mismatch.
    const retainedTablesComplete = sameStringSet(canonicalTables, SUPABASE_OPERATIONAL_RETAINED_TABLES)
        && missingTables.length === 0;
    const clean = metadataAvailability.catalog
        && retainedTablesComplete
        && metadataComplete
        && dependencyClean
        && aclClean
        && migrationHistoryClean
        && rlsClean
        && routinesClean
        && viewsClean
        && sequencesClean
        && partitionsClean
        && publicationsClean
        && triggersClean
        && foreignKeysClean
        && policiesClean
        && legacyWritersClean;
    const evidence: Supabase22CatalogEvidence = {
        schemaVersion: SUPABASE_OPERATIONAL_POLICY_SCHEMA,
        sourceSha: SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
        status: clean ? 'ready' : 'blocked',
        publicTableCount: publicTables.length,
        canonicalTables,
        unexpectedTables,
        missingTables,
        dependencyClean,
        migrationHistoryClean,
        rlsClean,
        routinesClean,
        canonicalRelationsAclClean,
        privateRoutinesAclClean,
        serviceRpcsAclClean,
        clientRpcsAclClean,
        aclClean,
        triggersClean,
        foreignKeysClean,
        viewsClean,
        publicationsClean,
        sequencesClean,
        partitionsClean,
        legacyWritersClean,
        operatorAuditTriggersClean,
        metadataAvailability,
        retainedTables: [...SUPABASE_OPERATIONAL_RETAINED_TABLES],
        forbiddenW1A: [...SUPABASE_OPERATIONAL_FORBIDDEN_W1A],
        approvedSubset: [],
        deferredReasons: Object.fromEntries(
            SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.map(name => [
                name,
                'fresh evidence required before this family can be approved',
            ]),
        ),
        closure: {
            tables: [...publicTables],
            routines: (routines ?? []).map(routine => routine.identityArguments === undefined
                ? routine.name
                : `${routine.name}(${routine.identityArguments})`),
            flags: [],
            indexes: [],
            triggers: (triggers ?? []).map(value => value.objectName),
            policies: (policies ?? []).map(value => value.tableName),
            acls: (acls ?? []).map(value => value.objectName),
            views: (views ?? []).map(value => value.objectName),
            foreignKeys: (foreignKeys ?? []).map(value => value.objectName),
            sequences: (sequences ?? []).map(value => value.objectName),
            publications: (publications ?? []).map(value => value.objectName),
            dependencies: (dependencies ?? []).map(value => value.objectName),
        },
        noCascadeAllowlistHash: null,
        clean,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(evidence);
    return evidence;
}

/**
 * The catalog reader deliberately over-fetches one row beyond the accepted bound. A
 * result at that sentinel means the caller cannot distinguish a complete inventory
 * from a truncated one, so collection fails closed.
 */
export const SUPABASE_22_CATALOG_ROW_LIMIT = 2048;
/** Keep each management API response comfortably below its output boundary. */
export const SUPABASE_22_CATALOG_PAGE_SIZE = 256;
/** Bound the total number of pages while still covering the live catalog with margin. */
export const SUPABASE_22_CATALOG_MAX_PAGES = 128;
const SUPABASE_22_CATALOG_SENTINEL_LIMIT = `${SUPABASE_22_CATALOG_PAGE_SIZE + 1} OFFSET 0`;

/** Read-only catalog query executed through an injected service-role connection. */
export const SUPABASE_22_CATALOG_QUERY = `
SELECT c.relname,
       c.relkind,
       c.relpersistence,
       c.relrowsecurity,
       c.relforcerowsecurity
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`;

/**
 * Read-only catalog query fragments used by an injected service-role catalog reader. Keeping
 * each surface explicit prevents a table-count check from being mistaken for a
 * dependency proof.
 */
export const SUPABASE_22_CATALOG_QUERIES = {
    tables: SUPABASE_22_CATALOG_QUERY,
    policies: `
SELECT n.nspname AS schema_name,
       c.relname AS table_name,
       c.relrowsecurity AS enabled,
       COALESCE(
           pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                   'policy_name', p.polname,
                   'command', p.polcmd,
                   'roles', COALESCE((
                       SELECT pg_catalog.jsonb_agg(
                           pg_catalog.pg_get_userbyid(role_oid)
                           ORDER BY pg_catalog.pg_get_userbyid(role_oid)
                       )
                       FROM pg_catalog.unnest(p.polroles) AS role_oid
                   ), '[]'::jsonb),
                   'using_expression', pg_catalog.pg_get_expr(p.polqual, p.polrelid),
                   'check_expression', pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid),
                   'permissive', p.polpermissive
               )
               ORDER BY p.polname
           ) FILTER (WHERE p.oid IS NOT NULL),
           '[]'::jsonb
       ) AS policy_details
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_policy AS p ON p.polrelid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
GROUP BY n.nspname, c.oid, c.relname, c.relrowsecurity
ORDER BY c.relname
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    acls: `
SELECT c.relname AS object_name,
       'relation' AS object_kind,
       (
           pg_catalog.has_table_privilege('public', c.oid, 'SELECT')
           OR pg_catalog.has_table_privilege('public', c.oid, 'INSERT')
           OR pg_catalog.has_table_privilege('public', c.oid, 'UPDATE')
           OR pg_catalog.has_table_privilege('public', c.oid, 'DELETE')
           OR pg_catalog.has_table_privilege('public', c.oid, 'TRUNCATE')
           OR pg_catalog.has_table_privilege('public', c.oid, 'REFERENCES')
           OR pg_catalog.has_table_privilege('public', c.oid, 'TRIGGER')
           OR pg_catalog.has_table_privilege('public', c.oid, 'MAINTAIN')
       ) AS public_allowed,
       (
           pg_catalog.has_table_privilege('anon', c.oid, 'SELECT')
           OR pg_catalog.has_table_privilege('anon', c.oid, 'INSERT')
           OR pg_catalog.has_table_privilege('anon', c.oid, 'UPDATE')
           OR pg_catalog.has_table_privilege('anon', c.oid, 'DELETE')
           OR pg_catalog.has_table_privilege('anon', c.oid, 'TRUNCATE')
           OR pg_catalog.has_table_privilege('anon', c.oid, 'REFERENCES')
           OR pg_catalog.has_table_privilege('anon', c.oid, 'TRIGGER')
           OR pg_catalog.has_table_privilege('anon', c.oid, 'MAINTAIN')
       ) AS anon_allowed,
       (
           pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT')
           OR pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT')
           OR pg_catalog.has_table_privilege('authenticated', c.oid, 'UPDATE')
           OR pg_catalog.has_table_privilege('authenticated', c.oid, 'DELETE')
           OR pg_catalog.has_table_privilege('authenticated', c.oid, 'TRUNCATE')
           OR pg_catalog.has_table_privilege('authenticated', c.oid, 'REFERENCES')
           OR pg_catalog.has_table_privilege('authenticated', c.oid, 'TRIGGER')
           OR pg_catalog.has_table_privilege('authenticated', c.oid, 'MAINTAIN')
       ) AS authenticated_allowed,
       (
           pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT')
           OR pg_catalog.has_table_privilege('service_role', c.oid, 'INSERT')
           OR pg_catalog.has_table_privilege('service_role', c.oid, 'UPDATE')
           OR pg_catalog.has_table_privilege('service_role', c.oid, 'DELETE')
           OR pg_catalog.has_table_privilege('service_role', c.oid, 'TRUNCATE')
           OR pg_catalog.has_table_privilege('service_role', c.oid, 'REFERENCES')
           OR pg_catalog.has_table_privilege('service_role', c.oid, 'TRIGGER')
           OR pg_catalog.has_table_privilege('service_role', c.oid, 'MAINTAIN')
       ) AS service_allowed
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
UNION ALL
SELECT p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
       'routine' AS object_kind,
       pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_allowed,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_allowed,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_allowed,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_allowed
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (
      p.prosecdef
      OR p.proname = ANY (ARRAY['analysis_order_audit_bundle_payload']::TEXT[])
  )
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    routines: `
SELECT p.proname AS name,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.prosecdef AS security_definer,
       p.proconfig,
       pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS public_allowed,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_allowed,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_allowed,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_allowed
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (
      p.prosecdef
      OR p.proname = ANY (ARRAY['analysis_order_audit_bundle_payload']::TEXT[])
  )
ORDER BY p.proname, identity_arguments
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    dependencies: `
SELECT dependent_object.object_identity AS object_name,
       pg_catalog.bool_and(
           dependent_object.object_identity IS NOT NULL
           AND referenced_object.object_identity IS NOT NULL
       ) AS resolved,
       pg_catalog.bool_and(
           dependency.deptype IN ('n', 'a', 'i')
           AND dependency.classid IN (
               'pg_catalog.pg_class'::pg_catalog.regclass,
               'pg_catalog.pg_proc'::pg_catalog.regclass,
               'pg_catalog.pg_type'::pg_catalog.regclass,
               'pg_catalog.pg_constraint'::pg_catalog.regclass,
               'pg_catalog.pg_trigger'::pg_catalog.regclass,
               'pg_catalog.pg_rewrite'::pg_catalog.regclass,
               'pg_catalog.pg_namespace'::pg_catalog.regclass,
               'pg_catalog.pg_attrdef'::pg_catalog.regclass,
               'pg_catalog.pg_policy'::pg_catalog.regclass,
               'pg_catalog.pg_partitioned_table'::pg_catalog.regclass,
               'pg_catalog.pg_init_privs'::pg_catalog.regclass,
               'pg_catalog.pg_enum'::pg_catalog.regclass,
               'pg_catalog.pg_collation'::pg_catalog.regclass,
               'pg_catalog.pg_opclass'::pg_catalog.regclass,
               'pg_catalog.pg_operator'::pg_catalog.regclass,
               'pg_catalog.pg_cast'::pg_catalog.regclass,
               'pg_catalog.pg_extension'::pg_catalog.regclass
           )
           AND dependency.refclassid IN (
               'pg_catalog.pg_class'::pg_catalog.regclass,
               'pg_catalog.pg_proc'::pg_catalog.regclass,
               'pg_catalog.pg_type'::pg_catalog.regclass,
               'pg_catalog.pg_constraint'::pg_catalog.regclass,
               'pg_catalog.pg_trigger'::pg_catalog.regclass,
               'pg_catalog.pg_rewrite'::pg_catalog.regclass,
               'pg_catalog.pg_namespace'::pg_catalog.regclass,
               'pg_catalog.pg_attrdef'::pg_catalog.regclass,
               'pg_catalog.pg_policy'::pg_catalog.regclass,
               'pg_catalog.pg_partitioned_table'::pg_catalog.regclass,
               'pg_catalog.pg_init_privs'::pg_catalog.regclass,
               'pg_catalog.pg_enum'::pg_catalog.regclass,
               'pg_catalog.pg_collation'::pg_catalog.regclass,
               'pg_catalog.pg_opclass'::pg_catalog.regclass,
               'pg_catalog.pg_operator'::pg_catalog.regclass,
               'pg_catalog.pg_cast'::pg_catalog.regclass,
               'pg_catalog.pg_extension'::pg_catalog.regclass
           )
       ) AS allowed,
       pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
               'dependent_object', dependent_object.object_identity,
               'referenced_object', referenced_object.object_identity,
               'dependency_type', dependency.deptype,
               'class_id', dependency.classid::text,
               'ref_class_id', dependency.refclassid::text,
               'object_sub_id', dependency.objsubid,
               'ref_object_sub_id', dependency.refobjsubid,
               'resolved', dependent_object.object_identity IS NOT NULL
                   AND referenced_object.object_identity IS NOT NULL,
               'allowed', dependency.deptype IN ('n', 'a', 'i')
                   AND dependency.classid IN (
                       'pg_catalog.pg_class'::pg_catalog.regclass,
                       'pg_catalog.pg_proc'::pg_catalog.regclass,
                       'pg_catalog.pg_type'::pg_catalog.regclass,
                       'pg_catalog.pg_constraint'::pg_catalog.regclass,
                       'pg_catalog.pg_trigger'::pg_catalog.regclass,
                       'pg_catalog.pg_rewrite'::pg_catalog.regclass,
                       'pg_catalog.pg_namespace'::pg_catalog.regclass,
                       'pg_catalog.pg_attrdef'::pg_catalog.regclass,
                       'pg_catalog.pg_policy'::pg_catalog.regclass,
                       'pg_catalog.pg_partitioned_table'::pg_catalog.regclass,
                       'pg_catalog.pg_init_privs'::pg_catalog.regclass,
                       'pg_catalog.pg_enum'::pg_catalog.regclass,
                       'pg_catalog.pg_collation'::pg_catalog.regclass,
                       'pg_catalog.pg_opclass'::pg_catalog.regclass,
                       'pg_catalog.pg_operator'::pg_catalog.regclass,
                       'pg_catalog.pg_cast'::pg_catalog.regclass,
                       'pg_catalog.pg_extension'::pg_catalog.regclass
                   )
                   AND dependency.refclassid IN (
                       'pg_catalog.pg_class'::pg_catalog.regclass,
                       'pg_catalog.pg_proc'::pg_catalog.regclass,
                       'pg_catalog.pg_type'::pg_catalog.regclass,
                       'pg_catalog.pg_constraint'::pg_catalog.regclass,
                       'pg_catalog.pg_trigger'::pg_catalog.regclass,
                       'pg_catalog.pg_rewrite'::pg_catalog.regclass,
                       'pg_catalog.pg_namespace'::pg_catalog.regclass,
                       'pg_catalog.pg_attrdef'::pg_catalog.regclass,
                       'pg_catalog.pg_policy'::pg_catalog.regclass,
                       'pg_catalog.pg_partitioned_table'::pg_catalog.regclass,
                       'pg_catalog.pg_init_privs'::pg_catalog.regclass,
                       'pg_catalog.pg_enum'::pg_catalog.regclass,
                       'pg_catalog.pg_collation'::pg_catalog.regclass,
                       'pg_catalog.pg_opclass'::pg_catalog.regclass,
                       'pg_catalog.pg_operator'::pg_catalog.regclass,
                       'pg_catalog.pg_cast'::pg_catalog.regclass,
                       'pg_catalog.pg_extension'::pg_catalog.regclass
                   )
           )
           ORDER BY dependency.classid::text, dependency.objid, dependency.objsubid,
                    dependency.refclassid::text, dependency.refobjid,
                    dependency.refobjsubid, dependency.deptype
       ) AS dependency_details
FROM pg_catalog.pg_depend AS dependency
CROSS JOIN LATERAL pg_catalog.pg_identify_object(
    dependency.classid,
    dependency.objid,
    dependency.objsubid
) AS dependent_object(object_type, object_schema, object_name, object_identity)
CROSS JOIN LATERAL pg_catalog.pg_identify_object(
    dependency.refclassid,
    dependency.refobjid,
    dependency.refobjsubid
) AS referenced_object(object_type, object_schema, object_name, object_identity)
WHERE dependent_object.object_schema = 'public'
   OR referenced_object.object_schema = 'public'
GROUP BY dependent_object.object_identity
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    foreignKeys: `
SELECT n.nspname || '.' || c.relname || '.' || con.conname AS object_name,
       (con.convalidated IS NOT NULL) AS resolved,
       (con.convalidated = true) AS allowed
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND con.contype = 'f'
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    triggers: `
SELECT n.nspname || '.' || c.relname || '.' || trigger_row.tgname AS object_name,
       true AS resolved,
       (trigger_row.tgenabled <> 'D' AND trigger_row.tgisinternal = false) AS allowed
FROM pg_catalog.pg_trigger AS trigger_row
JOIN pg_catalog.pg_class AS c ON c.oid = trigger_row.tgrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND trigger_row.tgisinternal = false
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    views: `
SELECT view_row.schemaname || '.' || view_row.viewname AS object_name,
       true AS resolved,
       (view_row.definition IS NOT NULL) AS allowed
FROM pg_catalog.pg_views AS view_row
WHERE view_row.schemaname = 'public'
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    sequences: `
SELECT sequence_row.sequence_schema || '.' || sequence_row.sequence_name AS object_name,
       true AS resolved,
       true AS allowed
FROM information_schema.sequences AS sequence_row
WHERE sequence_row.sequence_schema = 'public'
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    partitions: `
SELECT child_ns.nspname || '.' || child.relname AS object_name,
       true AS resolved,
       true AS allowed
FROM pg_catalog.pg_inherits AS inheritance
JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
JOIN pg_catalog.pg_namespace AS child_ns ON child_ns.oid = child.relnamespace
JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
JOIN pg_catalog.pg_namespace AS parent_ns ON parent_ns.oid = parent.relnamespace
WHERE child_ns.nspname = 'public' OR parent_ns.nspname = 'public'
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    publications: `
SELECT publication.pubname || '.' || publication_rel.prrelid::regclass::text AS object_name,
       true AS resolved,
       true AS allowed
FROM pg_catalog.pg_publication AS publication
JOIN pg_catalog.pg_publication_rel AS publication_rel
  ON publication_rel.prpubid = publication.oid
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    migrationHistory: `
SELECT version::text AS version, false AS pending
FROM supabase_migrations.schema_migrations
ORDER BY version
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
    legacyWriters: `
SELECT n.nspname || '.' || c.relname AS object_name,
       EXISTS (
           SELECT 1
           FROM pg_catalog.pg_locks AS lock_row
           JOIN pg_catalog.pg_stat_activity AS activity
             ON activity.pid = lock_row.pid
           WHERE lock_row.relation = c.oid
             AND lock_row.granted = true
             AND activity.state = 'active'
             AND lock_row.mode IN (
                 'RowExclusiveLock', 'ShareRowExclusiveLock',
                 'ExclusiveLock', 'AccessExclusiveLock'
             )
       ) AS active
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
ORDER BY object_name
LIMIT ${SUPABASE_22_CATALOG_SENTINEL_LIMIT}
`,
} as const;

export interface Supabase22CatalogQueryClient {
    query(sql: string): PromiseLike<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CATALOG_SNAPSHOT_KEYS = [
    'tables', 'acls', 'dependencies', 'foreignKeys', 'securityDefinerFunctions',
    'migrationHistory', 'legacyWriters', 'views', 'sequences', 'partitions',
    'publications', 'triggers', 'policies', 'metadataAvailability',
] as const;
const CATALOG_METADATA_KEYS = [
    'catalog', 'acl', 'routine', 'trigger', 'dependency', 'migration', 'rls',
    'view', 'publication', 'sequence', 'partition', 'foreignKey', 'legacyWriter',
] as const;

function hasOnlyKeys(
    value: Record<string, unknown>,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[] = [],
): boolean {
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    return Object.keys(value).every(key => allowed.has(key))
        && requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function safeCatalogName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function safeCatalogIdentityArguments(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 256;
}

function safeCatalogDetailText(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 16_384;
}

function parseCatalogPolicyDetail(value: unknown): Supabase22CatalogPolicyDetail {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['policyName'], [
            'command', 'roles', 'usingExpression', 'checkExpression', 'permissive',
        ])
        || !safeCatalogName(value.policyName)
        || (value.command !== undefined && !safeCatalogDetailText(value.command))
        || (value.roles !== undefined
            && (!Array.isArray(value.roles)
                || value.roles.some(role => !safeCatalogName(role))))
        || (value.usingExpression !== undefined
            && value.usingExpression !== null
            && !safeCatalogDetailText(value.usingExpression))
        || (value.checkExpression !== undefined
            && value.checkExpression !== null
            && !safeCatalogDetailText(value.checkExpression))
        || (value.permissive !== undefined && typeof value.permissive !== 'boolean')) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    return {
        policyName: value.policyName,
        ...(value.command === undefined ? {} : { command: value.command }),
        ...(value.roles === undefined ? {} : {
            roles: sortedUnique(value.roles as string[]),
        }),
        ...(value.usingExpression === undefined ? {} : { usingExpression: value.usingExpression }),
        ...(value.checkExpression === undefined ? {} : { checkExpression: value.checkExpression }),
        ...(value.permissive === undefined ? {} : { permissive: value.permissive }),
    };
}

function parseCatalogDependencyDetail(value: unknown): Supabase22CatalogDependencyDetail {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'dependentObject', 'referencedObject', 'dependencyType', 'classId', 'refClassId',
            'objectSubId', 'refObjectSubId', 'resolved', 'allowed',
        ])
        || !safeCatalogName(value.dependentObject)
        || !safeCatalogName(value.referencedObject)
        || !safeCatalogDetailText(value.dependencyType)
        || !safeCatalogDetailText(value.classId)
        || !safeCatalogDetailText(value.refClassId)
        || !Number.isSafeInteger(value.objectSubId)
        || (value.objectSubId as number) < 0
        || !Number.isSafeInteger(value.refObjectSubId)
        || (value.refObjectSubId as number) < 0
        || typeof value.resolved !== 'boolean'
        || typeof value.allowed !== 'boolean') {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    return {
        dependentObject: value.dependentObject,
        referencedObject: value.referencedObject,
        dependencyType: value.dependencyType,
        classId: value.classId,
        refClassId: value.refClassId,
        objectSubId: value.objectSubId as number,
        refObjectSubId: value.refObjectSubId as number,
        resolved: value.resolved,
        allowed: value.allowed,
    };
}

function parseCatalogDependency(value: unknown): Supabase22CatalogDependency {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['objectName', 'resolved', 'allowed'], ['details'])
        || !safeCatalogName(value.objectName)
        || typeof value.resolved !== 'boolean'
        || typeof value.allowed !== 'boolean'
        || (value.details !== undefined
            && (!Array.isArray(value.details)
                || value.details.some(detail => {
                    try {
                        parseCatalogDependencyDetail(detail);
                        return false;
                    } catch {
                        return true;
                    }
                })))) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    return {
        objectName: value.objectName,
        resolved: value.resolved,
        allowed: value.allowed,
        ...(value.details === undefined ? {} : {
            details: (value.details as unknown[]).map(parseCatalogDependencyDetail),
        }),
    };
}

/** Parse and reconstruct a normalized catalog snapshot; unknown fields never cross this boundary. */
export function parseSupabase22CatalogSnapshot(value: unknown): Supabase22CatalogSnapshot {
    if (!isRecord(value)
        || !hasOnlyKeys(value, CATALOG_SNAPSHOT_KEYS)) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    const arrays = CATALOG_SNAPSHOT_KEYS.filter(key => key !== 'metadataAvailability');
    if (!arrays.every(key => Array.isArray(value[key]))) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    const metadataAvailability = value.metadataAvailability;
    if (!isRecord(metadataAvailability)
        || !hasOnlyKeys(metadataAvailability, CATALOG_METADATA_KEYS)
        || !CATALOG_METADATA_KEYS.every(key => typeof metadataAvailability[key] === 'boolean')) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    const tables: Supabase22CatalogTable[] = [];
    for (const raw of value.tables as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['name', 'relkind', 'rlsEnabled'], ['relpersistence', 'forceRls'])
            || !safeCatalogName(raw.name)
            || (raw.relkind !== 'r' && raw.relkind !== 'p')
            || typeof raw.rlsEnabled !== 'boolean'
            || (raw.relpersistence !== undefined && typeof raw.relpersistence !== 'string')
            || (raw.forceRls !== undefined && typeof raw.forceRls !== 'boolean')) {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        tables.push({
            name: raw.name,
            relkind: raw.relkind,
            ...(raw.relpersistence === undefined ? {} : { relpersistence: raw.relpersistence }),
            rlsEnabled: raw.rlsEnabled,
            ...(raw.forceRls === undefined ? {} : { forceRls: raw.forceRls }),
        });
    }
    const acls: Supabase22CatalogAcl[] = [];
    for (const raw of value.acls as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, [
                'objectName', 'objectKind', 'resolved', 'publicAllowed', 'anonAllowed',
                'authenticatedAllowed', 'serviceRoleAllowed',
            ])
            || !safeCatalogName(raw.objectName)
            || (raw.objectKind !== 'relation' && raw.objectKind !== 'routine')
            || typeof raw.resolved !== 'boolean'
            || typeof raw.publicAllowed !== 'boolean'
            || typeof raw.anonAllowed !== 'boolean'
            || typeof raw.authenticatedAllowed !== 'boolean'
            || typeof raw.serviceRoleAllowed !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        acls.push({
            objectName: raw.objectName,
            objectKind: raw.objectKind,
            resolved: raw.resolved,
            publicAllowed: raw.publicAllowed,
            anonAllowed: raw.anonAllowed,
            authenticatedAllowed: raw.authenticatedAllowed,
            serviceRoleAllowed: raw.serviceRoleAllowed,
        });
    }
    const routines: Supabase22CatalogRoutine[] = [];
    for (const raw of value.securityDefinerFunctions as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, [
                'name', 'securityDefiner', 'searchPathEmpty', 'executePublic', 'executeAnon',
                'executeAuthenticated', 'executeServiceRole',
            ], ['identityArguments'])
            || !safeCatalogName(raw.name)
            || (raw.identityArguments !== undefined
                && !safeCatalogIdentityArguments(raw.identityArguments))
            || typeof raw.securityDefiner !== 'boolean'
            || typeof raw.searchPathEmpty !== 'boolean'
            || typeof raw.executePublic !== 'boolean'
            || typeof raw.executeAnon !== 'boolean'
            || typeof raw.executeAuthenticated !== 'boolean'
            || typeof raw.executeServiceRole !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        routines.push({
            name: raw.name,
            ...(raw.identityArguments === undefined ? {} : { identityArguments: raw.identityArguments }),
            securityDefiner: raw.securityDefiner,
            searchPathEmpty: raw.searchPathEmpty,
            executePublic: raw.executePublic,
            executeAnon: raw.executeAnon,
            executeAuthenticated: raw.executeAuthenticated,
            executeServiceRole: raw.executeServiceRole,
        });
    }
    const migrationHistory: Array<{ version: string; pending?: boolean }> = [];
    for (const raw of value.migrationHistory as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['version'], ['pending'])
            || !safeCatalogName(raw.version)
            || (raw.pending !== undefined && typeof raw.pending !== 'boolean')) {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        migrationHistory.push({
            version: raw.version,
            ...(raw.pending === undefined ? {} : { pending: raw.pending }),
        });
    }
    const legacyWriters: Array<{ objectName: string; active: boolean }> = [];
    for (const raw of value.legacyWriters as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['objectName', 'active'])
            || !safeCatalogName(raw.objectName)
            || typeof raw.active !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        legacyWriters.push({ objectName: raw.objectName, active: raw.active });
    }
    const objectCollections: Record<
        'dependencies' | 'foreignKeys' | 'views' | 'sequences' | 'partitions' | 'publications' | 'triggers',
        Supabase22CatalogDependency[]
    > = {
        dependencies: [],
        foreignKeys: [],
        views: [],
        sequences: [],
        partitions: [],
        publications: [],
        triggers: [],
    };
    for (const key of Object.keys(objectCollections) as Array<keyof typeof objectCollections>) {
        objectCollections[key] = (value[key] as unknown[]).map(parseCatalogDependency);
    }
    const policies: Supabase22CatalogPolicy[] = [];
    for (const raw of value.policies as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['tableName', 'enabled'], ['details'])
            || !safeCatalogName(raw.tableName)
            || typeof raw.enabled !== 'boolean'
            || (raw.details !== undefined
                && (!Array.isArray(raw.details)
                    || raw.details.some(detail => {
                        try {
                            parseCatalogPolicyDetail(detail);
                            return false;
                        } catch {
                            return true;
                        }
                    })))) {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        policies.push({
            tableName: raw.tableName,
            enabled: raw.enabled,
            ...(raw.details === undefined ? {} : {
                details: (raw.details as unknown[]).map(parseCatalogPolicyDetail),
            }),
        });
    }
    return {
        tables,
        acls,
        ...objectCollections,
        securityDefinerFunctions: routines,
        migrationHistory,
        legacyWriters,
        policies,
        metadataAvailability: Object.fromEntries(
            CATALOG_METADATA_KEYS.map(key => [key, metadataAvailability[key] === true]),
        ) as Supabase22CatalogMetadataAvailability,
    };
}

type Supabase22CatalogQueryName = keyof typeof SUPABASE_22_CATALOG_QUERIES;

export type Supabase22CatalogRows = Readonly<{
    [K in Supabase22CatalogQueryName]: readonly unknown[];
}>;

function parseCatalogRow(
    value: unknown,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[] = [],
): Record<string, unknown> {
    if (!isRecord(value) || !hasOnlyKeys(value, requiredKeys, optionalKeys)) {
        throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    }
    return value;
}

function parseConfiguredSearchPath(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    const searchPathEntries = value.filter(entry =>
        entry === 'search_path=' || entry === 'search_path=""');
    return searchPathEntries.length === 1
        && value.every(entry => searchPathEntries.includes(entry)
            || entry === 'extra_float_digits=3');
}

function parseCatalogJsonArray(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string') throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    }
    if (!Array.isArray(parsed)) throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    return parsed;
}

function parseRawPolicyDetail(value: unknown): Supabase22CatalogPolicyDetail {
    const row = parseCatalogRow(value, ['policy_name'], [
        'command', 'roles', 'using_expression', 'check_expression', 'permissive',
    ]);
    if (row.roles !== undefined) {
        const roles = row.roles === null ? [] : parseCatalogJsonArray(row.roles);
        row.roles = roles;
    }
    return parseCatalogPolicyDetail({
        policyName: row.policy_name,
        ...(row.command === undefined ? {} : { command: row.command }),
        ...(row.roles === undefined ? {} : { roles: row.roles }),
        ...(row.using_expression === undefined ? {} : { usingExpression: row.using_expression }),
        ...(row.check_expression === undefined ? {} : { checkExpression: row.check_expression }),
        ...(row.permissive === undefined ? {} : { permissive: row.permissive }),
    });
}

function parseRawPolicyDetailFromRow(
    row: Record<string, unknown>,
): Supabase22CatalogPolicyDetail {
    return parseRawPolicyDetail({
        policy_name: row.policy_name,
        ...(row.command === undefined ? {} : { command: row.command }),
        ...(row.roles === undefined ? {} : { roles: row.roles }),
        ...(row.using_expression === undefined ? {} : {
            using_expression: row.using_expression,
        }),
        ...(row.check_expression === undefined ? {} : {
            check_expression: row.check_expression,
        }),
        ...(row.permissive === undefined ? {} : { permissive: row.permissive }),
    });
}

const DEPENDENCY_DETAIL_ROW_KEYS = [
    'dependent_object', 'referenced_object', 'dependency_type', 'class_id', 'ref_class_id',
    'object_sub_id', 'ref_object_sub_id', 'resolved', 'allowed',
] as const;
const DEPENDENCY_DETAIL_OPTIONAL_ROW_KEYS = DEPENDENCY_DETAIL_ROW_KEYS.filter(
    key => key !== 'resolved' && key !== 'allowed',
);

function parseRawDependencyDetail(value: unknown): Supabase22CatalogDependencyDetail {
    const row = parseCatalogRow(value, [...DEPENDENCY_DETAIL_ROW_KEYS]);
    return parseCatalogDependencyDetail({
        dependentObject: row.dependent_object,
        referencedObject: row.referenced_object,
        dependencyType: row.dependency_type,
        classId: row.class_id,
        refClassId: row.ref_class_id,
        objectSubId: row.object_sub_id,
        refObjectSubId: row.ref_object_sub_id,
        resolved: row.resolved,
        allowed: row.allowed,
    });
}

function parseRawDependencyDetailFromRow(
    row: Record<string, unknown>,
): Supabase22CatalogDependencyDetail {
    return parseRawDependencyDetail({
        dependent_object: row.dependent_object,
        referenced_object: row.referenced_object,
        dependency_type: row.dependency_type,
        class_id: row.class_id,
        ref_class_id: row.ref_class_id,
        object_sub_id: row.object_sub_id,
        ref_object_sub_id: row.ref_object_sub_id,
        resolved: row.resolved,
        allowed: row.allowed,
    });
}

function dependencyDetailSortKey(detail: Supabase22CatalogDependencyDetail): string {
    return [
        detail.dependentObject,
        detail.referencedObject,
        detail.dependencyType,
        detail.classId,
        detail.refClassId,
        String(detail.objectSubId),
        String(detail.refObjectSubId),
        String(detail.resolved),
        String(detail.allowed),
    ].join('\u0000');
}

function policyDetailSortKey(detail: Supabase22CatalogPolicyDetail): string {
    return detail.policyName;
}

function aggregateCatalogDependencies(
    rows: readonly Supabase22CatalogDependency[],
): Supabase22CatalogDependency[] {
    const grouped = new Map<string, Supabase22CatalogDependency>();
    for (const row of rows) {
        const key = comparableCatalogObjectName(row.objectName) || row.objectName;
        const previous = grouped.get(key);
        if (!previous) {
            grouped.set(key, {
                objectName: row.objectName,
                resolved: row.resolved,
                allowed: row.allowed,
                details: [...(row.details ?? [])],
            });
            continue;
        }
        grouped.set(key, {
            objectName: previous.objectName,
            resolved: previous.resolved && row.resolved,
            allowed: previous.allowed && row.allowed,
            details: [
                ...(previous.details ?? []),
                ...(row.details ?? []),
            ],
        });
    }
    return [...grouped.values()]
        .map(row => ({
            ...row,
            details: [...(row.details ?? [])].sort((left, right) =>
                dependencyDetailSortKey(left).localeCompare(dependencyDetailSortKey(right))),
        }))
        .sort((left, right) => left.objectName.localeCompare(right.objectName));
}

function aggregateCatalogPolicies(
    rows: readonly Supabase22CatalogPolicy[],
): Supabase22CatalogPolicy[] {
    const grouped = new Map<string, Supabase22CatalogPolicy>();
    for (const row of rows) {
        const key = comparableCatalogObjectName(row.tableName) || row.tableName;
        const previous = grouped.get(key);
        if (!previous) {
            grouped.set(key, {
                tableName: row.tableName,
                enabled: row.enabled,
                details: [...(row.details ?? [])],
            });
            continue;
        }
        grouped.set(key, {
            tableName: previous.tableName,
            enabled: previous.enabled && row.enabled,
            details: [
                ...(previous.details ?? []),
                ...(row.details ?? []),
            ],
        });
    }
    return [...grouped.values()]
        .map(row => ({
            ...row,
            details: [...(row.details ?? [])].sort((left, right) =>
                policyDetailSortKey(left).localeCompare(policyDetailSortKey(right))),
        }))
        .sort((left, right) => left.tableName.localeCompare(right.tableName));
}

/**
 * Convert one bounded row set per catalog query into the normalized snapshot consumed by
 * the evaluator. This adapter intentionally does not accept an already assembled snapshot:
 * callers must prove that every independent catalog surface was read.
 */
export function adaptSupabase22CatalogRows(
    rows: Supabase22CatalogRows,
): Supabase22CatalogSnapshot {
    const queryNames = Object.keys(SUPABASE_22_CATALOG_QUERIES) as Supabase22CatalogQueryName[];
    if (!isRecord(rows)
        || Object.keys(rows).length !== queryNames.length
        || queryNames.some(name => !Object.prototype.hasOwnProperty.call(rows, name))) {
        throw new Error('SUPABASE_22_CATALOG_COVERAGE_MISMATCH');
    }
    if (queryNames.some(name => !Array.isArray(rows[name]))) {
        throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    }

    const tables: Supabase22CatalogTable[] = rows.tables.map(raw => {
        const row = parseCatalogRow(raw, [
            'relname', 'relkind', 'relpersistence', 'relrowsecurity', 'relforcerowsecurity',
        ]);
        if (!safeCatalogName(row.relname)
            || (row.relkind !== 'r' && row.relkind !== 'p')
            || typeof row.relpersistence !== 'string'
            || typeof row.relrowsecurity !== 'boolean'
            || typeof row.relforcerowsecurity !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
        }
        return {
            name: row.relname,
            relkind: row.relkind,
            relpersistence: row.relpersistence,
            rlsEnabled: row.relrowsecurity,
            forceRls: row.relforcerowsecurity,
        };
    });

    const policies = rows.policies.map(raw => {
        const row = parseCatalogRow(raw, ['schema_name', 'table_name', 'enabled'], [
            'policy_name', 'command', 'roles', 'using_expression', 'check_expression',
            'permissive', 'policy_details',
        ]);
        if (row.schema_name !== 'public'
            || !safeCatalogName(row.table_name)
            || typeof row.enabled !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
        }
        const hasDetails = row.policy_details !== undefined;
        const hasFlatDetail = row.policy_name !== undefined
            || row.command !== undefined
            || row.roles !== undefined
            || row.using_expression !== undefined
            || row.check_expression !== undefined
            || row.permissive !== undefined;
        if (hasDetails && hasFlatDetail) {
            throw new Error('SUPABASE_22_CATALOG_ROW_AMBIGUOUS');
        }
        const details = hasDetails
            ? row.policy_details === null ? [] : parseCatalogJsonArray(row.policy_details)
                .map(parseRawPolicyDetail)
            : row.policy_name === undefined ? [] : [parseRawPolicyDetailFromRow(row)];
        return {
            tableName: row.table_name,
            enabled: row.enabled,
            details,
        };
    });

    const acls = rows.acls.map(raw => {
        const row = parseCatalogRow(raw, [
            'object_name', 'object_kind', 'anon_allowed', 'authenticated_allowed', 'service_allowed',
            'public_allowed',
        ]);
        if (!safeCatalogName(row.object_name)
            || (row.object_kind !== 'relation' && row.object_kind !== 'routine')
            || typeof row.public_allowed !== 'boolean'
            || typeof row.anon_allowed !== 'boolean'
            || typeof row.authenticated_allowed !== 'boolean'
            || typeof row.service_allowed !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
        }
        return {
            objectName: row.object_name,
            objectKind: row.object_kind as 'relation' | 'routine',
            resolved: true,
            publicAllowed: row.public_allowed,
            anonAllowed: row.anon_allowed,
            authenticatedAllowed: row.authenticated_allowed,
            serviceRoleAllowed: row.service_allowed,
        };
    });

    const routines = rows.routines.map(raw => {
        const row = parseCatalogRow(raw, [
            'name', 'identity_arguments', 'security_definer', 'proconfig',
            'public_allowed', 'anon_allowed', 'authenticated_allowed', 'service_allowed',
        ]);
        if (!safeCatalogName(row.name)
            || typeof row.identity_arguments !== 'string'
            || typeof row.security_definer !== 'boolean'
            || typeof row.public_allowed !== 'boolean'
            || typeof row.anon_allowed !== 'boolean'
            || typeof row.authenticated_allowed !== 'boolean'
            || typeof row.service_allowed !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
        }
        return {
            name: row.name,
            identityArguments: row.identity_arguments,
            securityDefiner: row.security_definer,
            searchPathEmpty: parseConfiguredSearchPath(row.proconfig),
            executePublic: row.public_allowed,
            executeAnon: row.anon_allowed,
            executeAuthenticated: row.authenticated_allowed,
            executeServiceRole: row.service_allowed,
        };
    });

    const parseDependencyRows = (
        queryName: keyof Supabase22CatalogRows,
    ): Supabase22CatalogDependency[] => rows[queryName].map(raw => {
        const isDependency = queryName === 'dependencies';
        const row = parseCatalogRow(raw, ['object_name', 'resolved', 'allowed'], isDependency ? [
            'dependency_details', 'dependent_object', 'referenced_object', 'dependency_type',
            'class_id', 'ref_class_id', 'object_sub_id', 'ref_object_sub_id',
        ] : []);
        if (!safeCatalogName(row.object_name)
            || typeof row.resolved !== 'boolean'
            || typeof row.allowed !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
        }
        const detailKeysPresent = DEPENDENCY_DETAIL_OPTIONAL_ROW_KEYS.some(key =>
            Object.prototype.hasOwnProperty.call(row, key));
        const hasDetails = row.dependency_details !== undefined;
        if (hasDetails && detailKeysPresent) {
            throw new Error('SUPABASE_22_CATALOG_ROW_AMBIGUOUS');
        }
        const details = !isDependency ? undefined : hasDetails
            ? row.dependency_details === null ? [] : parseCatalogJsonArray(row.dependency_details)
                .map(parseRawDependencyDetail)
            : detailKeysPresent
                ? [parseRawDependencyDetailFromRow(row)]
                : [];
        return {
            objectName: row.object_name,
            resolved: row.resolved,
            allowed: row.allowed,
            ...(details === undefined ? {} : { details }),
        };
    });

    const migrationHistory = rows.migrationHistory.map(raw => {
        const row = parseCatalogRow(raw, ['version', 'pending']);
        if (!safeCatalogName(row.version) || typeof row.pending !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
        }
        return { version: row.version, pending: row.pending };
    });
    const legacyWriters = rows.legacyWriters.map(raw => {
        const row = parseCatalogRow(raw, ['object_name', 'active']);
        if (!safeCatalogName(row.object_name) || typeof row.active !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
        }
        return { objectName: row.object_name, active: row.active };
    });

    return {
        tables,
        acls,
        dependencies: aggregateCatalogDependencies(parseDependencyRows('dependencies')),
        foreignKeys: parseDependencyRows('foreignKeys'),
        securityDefinerFunctions: routines,
        migrationHistory,
        legacyWriters,
        views: parseDependencyRows('views'),
        sequences: parseDependencyRows('sequences'),
        partitions: parseDependencyRows('partitions'),
        publications: parseDependencyRows('publications'),
        triggers: parseDependencyRows('triggers'),
        policies: aggregateCatalogPolicies(policies),
        metadataAvailability: {
            catalog: true,
            acl: true,
            routine: true,
            trigger: true,
            dependency: true,
            migration: true,
            rls: true,
            view: true,
            publication: true,
            sequence: true,
            partition: true,
            foreignKey: true,
            legacyWriter: true,
        },
    };
}

function normalizeBoundedCatalogRows(value: unknown): readonly unknown[] {
    if (Array.isArray(value)) {
        if (value.length > SUPABASE_22_CATALOG_ROW_LIMIT) {
            throw new Error('SUPABASE_22_CATALOG_RESULT_TRUNCATED');
        }
        return value;
    }
    if (!isRecord(value)) throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    if ('error' in value && value.error) throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    const allowedKeys = [
        'rows', 'rowCount', 'command', 'fields', 'data', 'count', 'status', 'statusText', 'error',
        'truncated', 'hasMore',
    ];
    if (!Object.keys(value).every(key => allowedKeys.includes(key))) {
        throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    }
    if (Array.isArray(value.rows) && Array.isArray(value.data)) {
        throw new Error('SUPABASE_22_CATALOG_RESULT_AMBIGUOUS');
    }
    if (value.rowCount !== undefined && value.count !== undefined) {
        throw new Error('SUPABASE_22_CATALOG_RESULT_AMBIGUOUS');
    }
    const rows = Array.isArray(value.rows)
        ? value.rows
        : Array.isArray(value.data) ? value.data : null;
    if (rows === null) throw new Error('SUPABASE_22_CATALOG_ROW_INVALID');
    if (value.truncated === true || value.hasMore === true) {
        throw new Error('SUPABASE_22_CATALOG_RESULT_TRUNCATED');
    }
    const reportedCount = value.rowCount ?? value.count;
    if (reportedCount !== undefined && reportedCount !== null
        && (!Number.isSafeInteger(reportedCount) || reportedCount !== rows.length)) {
        throw new Error('SUPABASE_22_CATALOG_RESULT_AMBIGUOUS');
    }
    if (rows.length > SUPABASE_22_CATALOG_ROW_LIMIT) {
        throw new Error('SUPABASE_22_CATALOG_RESULT_TRUNCATED');
    }
    return rows;
}

function buildSupabase22CatalogPageQuery(sql: string, offset: number): string {
    const trimmed = sql.trim();
    const withoutLimit = trimmed.replace(
        /\s+LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?$/i,
        '',
    );
    if (withoutLimit === trimmed || !Number.isSafeInteger(offset) || offset < 0) {
        throw new Error('SUPABASE_22_CATALOG_QUERY_NOT_PAGINATABLE');
    }
    return `${withoutLimit}\nLIMIT ${SUPABASE_22_CATALOG_PAGE_SIZE + 1} OFFSET ${offset}`;
}

export async function collectSupabase22CatalogSnapshot(
    client: Supabase22CatalogQueryClient,
): Promise<Supabase22CatalogSnapshot> {
    const queries = Object.entries(SUPABASE_22_CATALOG_QUERIES);
    const rowSets: Record<string, readonly unknown[]> = {};
    for (const [name, sql] of queries) {
        const rows: unknown[] = [];
        let complete = false;
        for (let page = 0; page < SUPABASE_22_CATALOG_MAX_PAGES; page += 1) {
            const offset = page * SUPABASE_22_CATALOG_PAGE_SIZE;
            const pageSql = page === 0 ? sql : buildSupabase22CatalogPageQuery(sql, offset);
            const sqlWithoutLiterals = pageSql.replace(/'(?:''|[^'])*'/g, "''");
            if (!/^\s*SELECT\b/i.test(pageSql)
                || !/\bLIMIT\s+\d+\s+OFFSET\s+\d+\s*$/im.test(pageSql.trim())
                || /\b(?:DROP|TRUNCATE|ALTER|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i.test(sqlWithoutLiterals)) {
                throw new Error('SUPABASE_22_CATALOG_QUERY_NOT_READ_ONLY');
            }
            let raw: unknown;
            try {
                raw = await client.query(pageSql);
            } catch {
                throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
            }
            const pageRows = normalizeBoundedCatalogRows(raw);
            if (pageRows.length > SUPABASE_22_CATALOG_PAGE_SIZE) {
                rows.push(...pageRows.slice(0, SUPABASE_22_CATALOG_PAGE_SIZE));
                continue;
            }
            rows.push(...pageRows);
            complete = true;
            break;
        }
        if (!complete) throw new Error('SUPABASE_22_CATALOG_RESULT_TRUNCATED');
        rowSets[name] = rows;
    }
    return adaptSupabase22CatalogRows(
        rowSets as Supabase22CatalogRows,
    );
}

export async function collectSupabase22CatalogEvidence(
    client: Supabase22CatalogQueryClient,
): Promise<Supabase22CatalogEvidence> {
    return evaluateSupabase22Catalog(await collectSupabase22CatalogSnapshot(client));
}

/** Operational-policy-v1 names for new callers; the historical file path remains stable. */
export const SUPABASE_OPERATIONAL_CATALOG_QUERIES = SUPABASE_22_CATALOG_QUERIES;
export const SUPABASE_OPERATIONAL_CATALOG_QUERY = SUPABASE_22_CATALOG_QUERY;
export const SUPABASE_OPERATIONAL_CATALOG_PAGE_SIZE = SUPABASE_22_CATALOG_PAGE_SIZE;
export const SUPABASE_OPERATIONAL_CATALOG_ROW_LIMIT = SUPABASE_22_CATALOG_ROW_LIMIT;
export const SUPABASE_OPERATIONAL_CATALOG_MAX_PAGES = SUPABASE_22_CATALOG_MAX_PAGES;
export const evaluateSupabaseOperationalCatalog = evaluateSupabase22Catalog;
export const collectSupabaseOperationalCatalogEvidence = collectSupabase22CatalogEvidence;
export const collectSupabaseOperationalCatalogSnapshot = collectSupabase22CatalogSnapshot;

export type Supabase22FamilyReaderInput = Readonly<{
    canonicalEnabled: boolean;
    shadowMismatch: boolean;
    legacyAvailable: boolean;
}>;

export type Supabase22FamilyReader = Readonly<{
    reader: 'canonical' | 'legacy' | 'blocked';
    status: 'canonical' | 'legacy' | 'rollback_required' | 'rollback_unavailable';
}>;

export function resolveFamilyReader(input: Supabase22FamilyReaderInput): Supabase22FamilyReader {
    if (!input.legacyAvailable) return { reader: 'blocked', status: 'rollback_unavailable' };
    if (input.shadowMismatch) return { reader: 'legacy', status: 'rollback_required' };
    if (input.canonicalEnabled) return { reader: 'canonical', status: 'canonical' };
    return { reader: 'legacy', status: 'legacy' };
}

export const SUPABASE_22_REQUIRED_TRAFFIC_OBJECTS = [
    { family: 'analysis', objectName: 'analysis-jobs' },
    { family: 'analysis', objectName: 'analysis-events' },
    { family: 'analysis', objectName: 'analysis-artifacts' },
    { family: 'analysis', objectName: 'analysis-audit-bundles' },
    { family: 'commerce', objectName: 'earlybird-orders' },
    { family: 'commerce', objectName: 'payment-events' },
    { family: 'commerce', objectName: 'fulfillment-jobs' },
    { family: 'commerce', objectName: 'notification-outbox' },
    { family: 'commerce', objectName: 'account-lifecycle' },
    { family: 'commerce', objectName: 'system-configuration' },
    { family: 'commerce', objectName: 'system-leases' },
    { family: 'commerce', objectName: 'maintenance-jobs' },
    { family: 'landing', objectName: 'landing-leads' },
    { family: 'landing', objectName: 'analysis-preflights' },
] as const;

export type Supabase22FamilyTrafficEvidence = Readonly<{
    family: string;
    objectName: string;
    source: 'bounded-read-only';
    observedAt: string;
    sampleCount: number;
    sampleLimit: number;
    truncated: false;
    serverOnly: boolean;
    legacyReaderAvailable: boolean;
    canonicalReaderEnabled: boolean;
    canonicalWriterEnabled: boolean;
    shadowMismatch: boolean;
    retryQueueCount: number;
    retryQueueBounded: boolean;
    activeLegacyWriterCount: number;
}>;

export type Supabase22RollbackEvidenceInput = Readonly<{
    families: readonly Supabase22FamilyTrafficEvidence[];
    activeLegacyWriterCount: number;
    observationWindowClosed: boolean;
    observationEvidence?: Readonly<{
        source: 'bounded-read-only';
        closed: boolean;
        closedAt: string | null;
        revision: string;
        windowStart: string;
        windowEnd: string | null;
        drained: boolean;
    }>;
}>;

export type Supabase22RollbackEvidence = Readonly<{
    verified: boolean;
    rollbackEvidenceVerified: boolean;
    observationWindowClosed: boolean;
    familyReaders: readonly Supabase22FamilyReader[];
    observationEvidence: Readonly<{
        source: 'bounded-read-only';
        closed: boolean;
        closedAt: string | null;
        revision: string;
        windowStart: string;
        windowEnd: string | null;
        drained: boolean;
    }> | null;
    missingGates: readonly string[];
    destructiveOperations: 'refused';
}>;

export function evaluateSupabase22RollbackEvidence(
    input: Supabase22RollbackEvidenceInput,
): Supabase22RollbackEvidence {
    const familyReaders = input.families.map(family => resolveFamilyReader({
        canonicalEnabled: family.canonicalReaderEnabled,
        shadowMismatch: family.shadowMismatch,
        legacyAvailable: family.legacyReaderAvailable,
    }));
    const missingGates: string[] = [];
    const expectedTrafficKeys = SUPABASE_22_REQUIRED_TRAFFIC_OBJECTS
        .map(entry => `${entry.family}:${entry.objectName}`);
    const observedTrafficKeys = input.families.map(family => `${family.family}:${family.objectName}`);
    const trafficCoverageComplete = input.families.length > 0
        && input.families.length === expectedTrafficKeys.length
        && new Set(observedTrafficKeys).size === observedTrafficKeys.length
        && expectedTrafficKeys.every(key => observedTrafficKeys.includes(key));
    if (!trafficCoverageComplete) addGate(missingGates, 'traffic-coverage');
    const measuredLegacyWriterCount = input.families.reduce(
        (total, family) => total + family.activeLegacyWriterCount,
        0,
    );
    if (input.activeLegacyWriterCount !== measuredLegacyWriterCount) {
        addGate(missingGates, 'traffic-count-consistency');
    }
    if (input.families.length === 0 || input.families.some(family =>
        family.source !== 'bounded-read-only'
        || !ISO_DATE_PATTERN.test(family.observedAt)
        || !Number.isSafeInteger(family.sampleCount)
        || family.sampleCount < 0
        || !Number.isSafeInteger(family.sampleLimit)
        || family.sampleLimit <= 0
        || family.sampleLimit > MAX_TRAFFIC_ROWS
        || family.sampleCount > family.sampleLimit
        || family.truncated !== false)) {
        addGate(missingGates, 'bounded-traffic-measurement');
    }
    if (input.families.length === 0 || input.families.some(family => !family.serverOnly)) {
        addGate(missingGates, 'server-only-flags');
    }
    if (input.families.length === 0
        || input.families.some(family => !family.legacyReaderAvailable)) {
        addGate(missingGates, 'legacy-reader');
    }
    if (input.families.length === 0 || input.families.some(family =>
        !family.canonicalReaderEnabled
        || !family.canonicalWriterEnabled)) {
        addGate(missingGates, 'canonical-flags');
    }
    if (input.families.length === 0 || input.families.some(family =>
        family.retryQueueCount < 0 || !family.retryQueueBounded)) {
        addGate(missingGates, 'bounded-retry-queue');
    }
    if (input.activeLegacyWriterCount !== 0
        || input.families.some(family => family.activeLegacyWriterCount !== 0)) {
        addGate(missingGates, 'zero-legacy-writers');
    }
    if (input.families.some(family => family.shadowMismatch)) {
        addGate(missingGates, 'shadow-read-parity');
    }
    const observationEvidenceVerified = input.observationEvidence?.source === 'bounded-read-only'
        && input.observationEvidence.closed === input.observationWindowClosed
        && typeof input.observationEvidence.revision === 'string'
        && input.observationEvidence.revision.length > 0
        && ISO_DATE_PATTERN.test(input.observationEvidence.windowStart)
        && (input.observationEvidence.windowEnd === null
            || ISO_DATE_PATTERN.test(input.observationEvidence.windowEnd))
        && (!input.observationWindowClosed
            || (typeof input.observationEvidence.closedAt === 'string'
                && ISO_DATE_PATTERN.test(input.observationEvidence.closedAt)
                && input.observationEvidence.drained === true
                && input.observationEvidence.windowEnd !== null));
    if (!input.observationWindowClosed || !observationEvidenceVerified) {
        addGate(missingGates, 'observation-window');
    }
    const evidence: Supabase22RollbackEvidence = {
        verified: missingGates.length === 0,
        rollbackEvidenceVerified: missingGates.length === 0,
        observationWindowClosed: input.observationWindowClosed,
        familyReaders,
        observationEvidence: input.observationEvidence ?? null,
        missingGates,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(evidence);
    return evidence;
}

const TRAFFIC_FAMILY_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_TRAFFIC_FAMILIES = 64;
const MAX_TRAFFIC_ROWS = 2048;
const MAX_TRAFFIC_COUNTER = MAX_TRAFFIC_ROWS;
const MAX_TOTAL_TRAFFIC_COUNTER = MAX_TRAFFIC_FAMILIES * MAX_TRAFFIC_COUNTER;
const TRAFFIC_OBJECT_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

/**
 * Traffic evidence must come from an explicitly provisioned, bounded,
 * read-only reader.  The previous RPC-shaped interface named a repository
 * function that is not present in this worktree; retaining that call would
 * turn an unavailable observation into an ambiguous failure.  Callers that
 * cannot provide this reader fail closed below.
 */
export interface Supabase22TrafficRpcClient {
    readBoundedTrafficEvidence?: () => PromiseLike<unknown>;
    readBoundedTrafficMeasurements?: () => PromiseLike<unknown>;
    /** @deprecated An RPC client alone is intentionally not accepted. */
    rpc?: (...args: unknown[]) => PromiseLike<unknown>;
}

function parseTrafficEvidence(value: unknown): Supabase22RollbackEvidenceInput {
    if (!isRecord(value) || !Array.isArray(value.measurements)
        || Object.keys(value).length !== 3
        || !Object.prototype.hasOwnProperty.call(value, 'measurements')
        || !Object.prototype.hasOwnProperty.call(value, 'activeLegacyWriterCount')
        || !Object.prototype.hasOwnProperty.call(value, 'observationEvidence')
        || !Number.isSafeInteger(value.activeLegacyWriterCount)
        || (value.activeLegacyWriterCount as number) < 0
        || (value.activeLegacyWriterCount as number) > MAX_TOTAL_TRAFFIC_COUNTER
        || !isRecord(value.observationEvidence)
        || Object.keys(value.observationEvidence).length !== 7
        || value.observationEvidence.source !== 'bounded-read-only'
        || typeof value.observationEvidence.closed !== 'boolean'
        || typeof value.observationEvidence.revision !== 'string'
        || value.observationEvidence.revision.length === 0
        || typeof value.observationEvidence.windowStart !== 'string'
        || !ISO_DATE_PATTERN.test(value.observationEvidence.windowStart)
        || (value.observationEvidence.windowEnd !== null
            && (typeof value.observationEvidence.windowEnd !== 'string'
                || !ISO_DATE_PATTERN.test(value.observationEvidence.windowEnd)))
        || typeof value.observationEvidence.drained !== 'boolean'
        || (value.observationEvidence.closedAt !== null
            && (typeof value.observationEvidence.closedAt !== 'string'
                || !ISO_DATE_PATTERN.test(value.observationEvidence.closedAt)
                || value.observationEvidence.closed !== true))) {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    const measurements = value.measurements as unknown[];
    if (measurements.length === 0 || measurements.length > MAX_TRAFFIC_FAMILIES * 16) {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    const seenMeasurements = new Set<string>();
    const sanitizedFamilies: Supabase22FamilyTrafficEvidence[] = [];
    if (measurements.some(measurement => {
        if (!isRecord(measurement)) return true;
        const keys = [
            'family', 'objectName', 'observedAt', 'sampleCount', 'sampleLimit', 'truncated',
            'serverOnly', 'legacyReaderAvailable', 'canonicalReaderEnabled',
            'canonicalWriterEnabled', 'shadowMismatch', 'retryQueueCount',
            'retryQueueBounded', 'activeLegacyWriterCount',
        ];
        if (Object.keys(measurement).length !== keys.length
            || keys.some(key => !Object.prototype.hasOwnProperty.call(measurement, key))) {
            return true;
        }
        if (typeof measurement.family !== 'string'
            || !TRAFFIC_FAMILY_NAME_PATTERN.test(measurement.family)
            || typeof measurement.objectName !== 'string'
            || !TRAFFIC_OBJECT_NAME_PATTERN.test(measurement.objectName)
            || typeof measurement.observedAt !== 'string'
            || !ISO_DATE_PATTERN.test(measurement.observedAt)
            || measurement.truncated !== false
            || seenMeasurements.has(`${measurement.family}:${measurement.objectName}`)) {
            return true;
        }
        seenMeasurements.add(`${measurement.family}:${measurement.objectName}`);
        if (typeof measurement.sampleCount !== 'number'
            || !Number.isSafeInteger(measurement.sampleCount)
            || measurement.sampleCount < 0
            || typeof measurement.sampleLimit !== 'number'
            || !Number.isSafeInteger(measurement.sampleLimit)
            || measurement.sampleLimit <= 0
            || measurement.sampleLimit > MAX_TRAFFIC_ROWS
            || measurement.sampleCount > measurement.sampleLimit
            || typeof measurement.serverOnly !== 'boolean'
            || typeof measurement.legacyReaderAvailable !== 'boolean'
            || typeof measurement.canonicalReaderEnabled !== 'boolean'
            || typeof measurement.canonicalWriterEnabled !== 'boolean'
            || typeof measurement.shadowMismatch !== 'boolean'
            || typeof measurement.retryQueueBounded !== 'boolean') {
            return true;
        }
        if (typeof measurement.retryQueueCount !== 'number'
            || !Number.isSafeInteger(measurement.retryQueueCount)
            || measurement.retryQueueCount < 0
            || measurement.retryQueueCount > MAX_TRAFFIC_COUNTER
            || typeof measurement.activeLegacyWriterCount !== 'number'
            || !Number.isSafeInteger(measurement.activeLegacyWriterCount)
            || measurement.activeLegacyWriterCount < 0
            || measurement.activeLegacyWriterCount > MAX_TRAFFIC_COUNTER) {
            return true;
        }
        sanitizedFamilies.push({
            family: measurement.family,
            objectName: measurement.objectName,
            source: 'bounded-read-only',
            observedAt: measurement.observedAt,
            sampleCount: measurement.sampleCount,
            sampleLimit: measurement.sampleLimit,
            truncated: false,
            serverOnly: measurement.serverOnly,
            legacyReaderAvailable: measurement.legacyReaderAvailable,
            canonicalReaderEnabled: measurement.canonicalReaderEnabled,
            canonicalWriterEnabled: measurement.canonicalWriterEnabled,
            shadowMismatch: measurement.shadowMismatch,
            retryQueueCount: measurement.retryQueueCount,
            retryQueueBounded: measurement.retryQueueBounded,
            activeLegacyWriterCount: measurement.activeLegacyWriterCount,
        });
        return false;
    })) {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    const activeLegacyWriterCount = value.activeLegacyWriterCount as number;
    return {
        families: sanitizedFamilies,
        activeLegacyWriterCount,
        observationWindowClosed: value.observationEvidence.closed === true,
        observationEvidence: {
            source: 'bounded-read-only',
            closed: value.observationEvidence.closed,
            closedAt: value.observationEvidence.closedAt,
            revision: value.observationEvidence.revision,
            windowStart: value.observationEvidence.windowStart,
            windowEnd: value.observationEvidence.windowEnd,
            drained: value.observationEvidence.drained,
        },
    };
}

/** Read aggregate traffic counters only; route payloads and actor identifiers never leave the reader. */
export async function collectSupabase22RollbackEvidence(
    client: Supabase22TrafficRpcClient,
): Promise<Supabase22RollbackEvidence> {
    const reader = typeof client.readBoundedTrafficMeasurements === 'function'
        ? client.readBoundedTrafficMeasurements
        : client.readBoundedTrafficEvidence;
    if (typeof reader !== 'function') {
        throw new Error('SUPABASE_22_TRAFFIC_READ_UNAVAILABLE');
    }
    let raw: unknown;
    try {
        raw = await reader.call(client);
    } catch {
        throw new Error('SUPABASE_22_TRAFFIC_READ_FAILED');
    }
    if (raw === null || raw === undefined) {
        throw new Error('SUPABASE_22_TRAFFIC_READ_FAILED');
    }
    return evaluateSupabase22RollbackEvidence(parseTrafficEvidence(raw));
}

export type Supabase22PaymentPendingEvidence = Readonly<{
    source: 'payment_pending-read-only';
    observedAt: string;
    sourceChecksum: string;
    pendingOrderCount: number;
    independentlyEvidencedCount: number;
    dispositionRecordedCount: number;
}>;

/** Payment-pending disposition is evidence-only; this function never changes an order state. */
export function isPaymentPendingDispositionRecorded(
    evidence: Supabase22PaymentPendingEvidence,
): boolean {
    return evidence.source === 'payment_pending-read-only'
        && ISO_DATE_PATTERN.test(evidence.observedAt)
        && HASH_PATTERN.test(evidence.sourceChecksum)
        && Number.isSafeInteger(evidence.pendingOrderCount)
        && evidence.pendingOrderCount > 0
        && Number.isSafeInteger(evidence.independentlyEvidencedCount)
        && evidence.independentlyEvidencedCount >= 0
        && Number.isSafeInteger(evidence.dispositionRecordedCount)
        && evidence.dispositionRecordedCount >= 0
        && evidence.independentlyEvidencedCount === evidence.pendingOrderCount
        && evidence.dispositionRecordedCount === evidence.pendingOrderCount;
}
