import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { supabaseAdmin } from '../lib/supabase/admin';
import {
    assertPiiSafeConsolidationOutput,
    buildOrderAuditParityAggregate,
    buildOrderAuditParityReport,
    readOrderAuditParitySnapshot,
    type OrderAuditParityRpcClient,
    type OrderAuditParitySnapshot,
} from '../lib/services/analysis/order-audit-consolidation';
import {
    evaluateSupabaseOperationalPolicy,
    isGenuineArchiveManifest,
    isGenuineRestoreManifest,
    SUPABASE_OPERATIONAL_POLICY_SCHEMA,
    SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
    SUPABASE_OPERATIONAL_RETAINED_TABLES,
    SUPABASE_OPERATIONAL_FORBIDDEN_W1A,
    SUPABASE_OPERATIONAL_W1A_UPPER_BOUND,
    type SupabaseOperationalPolicyClosure,
    type SupabaseOperationalPolicyEvidence,
    type SupabaseOperationalPolicyInput,
    type Supabase22ArchiveEvidence,
    type Supabase22ArchiveManifest,
    type Supabase22RestoreManifest,
} from '../lib/services/operations/supabase-22-evidence';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_REQUESTS = 20;
const MAX_ARCHIVE_PROOF_RECORDS = MAX_REQUESTS;
const READ_ONLY_OPTIONS = new Set([
    '--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate',
]);
const ARCHIVE_ENCRYPTION_ALGORITHM = 'AES-256-GCM' as const;

export type Supabase22ArchiveRestoreCliOptions = Readonly<{
    reportOnly: boolean;
    requestIds: readonly string[];
    includeArchiveManifest: boolean;
    restorePath: string | null;
    manifestPath: string | null;
}>;

function optionName(value: string): string {
    return value.split('=', 1)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    optionalKeys: readonly string[] = [],
): boolean {
    const allowed = new Set([...keys, ...optionalKeys]);
    return keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && Object.keys(value).every(key => allowed.has(key));
}

function safeName(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z][a-z0-9_.-]{0,255}$/i.test(value);
}

function parseEncryption(value: unknown): { algorithm: typeof ARCHIVE_ENCRYPTION_ALGORITHM; verified: true } {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['algorithm', 'verified'])
        || value.algorithm !== ARCHIVE_ENCRYPTION_ALGORITHM
        || value.verified !== true) {
        throw new Error('OPERATIONAL_POLICY_ARCHIVE_MANIFEST_INVALID');
    }
    return { algorithm: ARCHIVE_ENCRYPTION_ALGORITHM, verified: true };
}

function parseArchiveManifest(value: unknown): Supabase22ArchiveManifest {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'schemaVersion', 'selectedCount', 'aggregateChecksum', 'encrypted',
            'encryption', 'retentionClass',
        ])
        || !isGenuineArchiveManifest(value)
        || (value.selectedCount as number) > MAX_ARCHIVE_PROOF_RECORDS) {
        throw new Error('OPERATIONAL_POLICY_ARCHIVE_MANIFEST_INVALID');
    }
    return {
        schemaVersion: 'supabase-22-archive-manifest-v1',
        selectedCount: value.selectedCount as number,
        aggregateChecksum: value.aggregateChecksum,
        encrypted: true,
        encryption: parseEncryption(value.encryption),
        retentionClass: value.retentionClass as string,
    };
}

function parseRestoreManifest(value: unknown): Supabase22RestoreManifest {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'schemaVersion', 'selectedCount', 'aggregateChecksum', 'encrypted',
            'encryption', 'retentionClass',
        ])
        || !isGenuineRestoreManifest(value)
        || (value.selectedCount as number) > MAX_ARCHIVE_PROOF_RECORDS) {
        throw new Error('OPERATIONAL_POLICY_RESTORE_MANIFEST_INVALID');
    }
    return {
        schemaVersion: 'supabase-22-restore-manifest-v1',
        selectedCount: value.selectedCount as number,
        aggregateChecksum: value.aggregateChecksum,
        encrypted: true,
        encryption: parseEncryption(value.encryption),
        retentionClass: value.retentionClass,
    };
}

export function parseSupabase22ArchiveRestoreCliArgs(
    args: readonly string[],
): Supabase22ArchiveRestoreCliOptions {
    const requestIds: string[] = [];
    let reportOnly = false;
    let includeArchiveManifest = false;
    let restorePath: string | null = null;
    let manifestPath: string | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (READ_ONLY_OPTIONS.has(optionName(option))) throw new Error('read-only verifier rejects destructive mode');
        if (option === '--report-only') {
            if (reportOnly) throw new Error('--report-only must appear exactly once');
            reportOnly = true;
            continue;
        }
        if (option === '--archive-manifest') {
            if (includeArchiveManifest) throw new Error('--archive-manifest must appear exactly once');
            includeArchiveManifest = true;
            continue;
        }
        if (option === '--request-id' || option.startsWith('--request-id=')) {
            const value = option === '--request-id' ? args[index + 1] : option.slice('--request-id='.length);
            if (!value || value.startsWith('--') || !UUID_PATTERN.test(value)) throw new Error('--request-id must be a UUID');
            if (option === '--request-id') index += 1;
            if (requestIds.includes(value)) throw new Error('--request-id must be unique');
            requestIds.push(value);
            if (requestIds.length > MAX_REQUESTS) throw new Error('at most 20 request IDs are allowed');
            continue;
        }
        if (option === '--restore-path' || option.startsWith('--restore-path=')) {
            if (restorePath !== null) throw new Error('--restore-path must appear exactly once');
            restorePath = option === '--restore-path' ? args[index + 1] ?? null : option.slice('--restore-path='.length);
            if (!restorePath || restorePath.startsWith('--')) throw new Error('--restore-path requires a path');
            if (option === '--restore-path') index += 1;
            continue;
        }
        if (option === '--manifest' || option.startsWith('--manifest=')) {
            if (manifestPath !== null) throw new Error('--manifest must appear exactly once');
            manifestPath = option === '--manifest' ? args[index + 1] ?? null : option.slice('--manifest='.length);
            if (!manifestPath || manifestPath.startsWith('--')) throw new Error('--manifest requires a path');
            if (option === '--manifest') index += 1;
            continue;
        }
        throw new Error('unknown argument');
    }
    return { reportOnly, requestIds, includeArchiveManifest, restorePath, manifestPath };
}

export type Supabase22RestoredManifest = Supabase22RestoreManifest;

export interface Supabase22ArchiveRestoreCliDependencies {
    readSnapshot(requestId: string): Promise<OrderAuditParitySnapshot>;
    readManifest(path: string): Promise<unknown>;
    readRestoreManifest(path: string): Promise<unknown>;
    readArchiveEvidence?(
        requestIds: readonly string[],
        expectedChecksum: string | null,
    ): Promise<unknown>;
    writeStdout(value: string): void;
}

function defaultDependencies(): Supabase22ArchiveRestoreCliDependencies {
    const client = supabaseAdmin as unknown as OrderAuditParityRpcClient;
    return {
        readSnapshot: requestId => readOrderAuditParitySnapshot(client, requestId),
        readManifest: async path => JSON.parse(await readFile(path, 'utf8')) as unknown,
        readRestoreManifest: async path => JSON.parse(await readFile(path, 'utf8')) as unknown,
        writeStdout: value => process.stdout.write(value),
    };
}

const EMPTY_CLOSURE: SupabaseOperationalPolicyClosure = {
    tables: [], routines: [], flags: [], indexes: [], triggers: [], policies: [],
    acls: [], views: [], foreignKeys: [], sequences: [], publications: [], dependencies: [],
};

function deferredReasons(): Record<string, string> {
    return Object.fromEntries([
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache', 'analysis_costs',
        'fulfillment_jobs', 'notification_outbox', 'system_configuration', 'system_leases',
    ].map(name => [name, 'fresh evidence and old-revision drain are required'])) as Record<string, string>;
}

function emptyArchiveEvidence(): Supabase22ArchiveEvidence {
    return { verified: false, aggregateChecksum: null, restoreStatus: 'blocked' };
}

function policyInputFromEvidence(
    archiveManifest: Supabase22ArchiveEvidence,
    overrides: Partial<Pick<SupabaseOperationalPolicyInput,
        'genuineCompletedBundleEvidence' | 'parityStatus' | 'archiveRestoreChecksumMatch'>> = {},
): SupabaseOperationalPolicyInput {
    return {
        schemaVersion: SUPABASE_OPERATIONAL_POLICY_SCHEMA,
        sourceSha: SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
        retained: [...SUPABASE_OPERATIONAL_RETAINED_TABLES],
        forbiddenW1A: [...SUPABASE_OPERATIONAL_FORBIDDEN_W1A],
        approvedSubset: [],
        closure: EMPTY_CLOSURE,
        noCascadeAllowlistHash: null,
        retainedInvariantVerified: false,
        forbiddenInvariantVerified: false,
        dependencyClean: false,
        migrationHistoryClean: false,
        genuineCompletedBundleEvidence: overrides.genuineCompletedBundleEvidence ?? false,
        parityStatus: overrides.parityStatus ?? 'blocked',
        archiveManifest,
        rollbackEvidenceVerified: false,
        observationWindowClosed: false,
        ownerApprovalRecorded: false,
        paymentPendingDispositionRecorded: false,
        noActivationOrCanary: false,
        archiveRestoreChecksumMatch: overrides.archiveRestoreChecksumMatch ?? false,
        deferredReasons: deferredReasons(),
    };
}

function parsePolicyManifest(value: unknown): SupabaseOperationalPolicyEvidence {
    const keys = [
        'schemaVersion', 'sourceSha', 'retained', 'forbiddenW1A', 'approvedSubset', 'closure',
        'noCascadeAllowlistHash', 'retainedInvariantVerified', 'forbiddenInvariantVerified',
        'dependencyClean', 'migrationHistoryClean', 'genuineCompletedBundleEvidence',
        'parityStatus', 'archiveManifest', 'rollbackEvidenceVerified', 'observationWindowClosed',
        'ownerApprovalRecorded', 'paymentPendingDispositionRecorded', 'noActivationOrCanary',
        'archiveRestoreChecksumMatch', 'deferredReasons', 'status', 'missingGates',
        'destructiveOperations',
    ] as const;
    if (!isRecord(value) || !hasOnlyKeys(value, keys, ['noActivationEvidence'])) throw new Error('OPERATIONAL_POLICY_EVIDENCE_MANIFEST_INVALID');
    const raw = value;
    if (raw.schemaVersion !== SUPABASE_OPERATIONAL_POLICY_SCHEMA
        || raw.sourceSha !== SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA
        || !Array.isArray(raw.retained)
        || !Array.isArray(raw.forbiddenW1A)
        || !Array.isArray(raw.approvedSubset)
        || raw.retained.some(value => !safeName(value))
        || raw.forbiddenW1A.some(value => !safeName(value))
        || raw.approvedSubset.some(value => !safeName(value))
        || !isRecord(raw.closure)
        || !isRecord(raw.deferredReasons)
        || raw.destructiveOperations !== 'refused') {
        throw new Error('OPERATIONAL_POLICY_EVIDENCE_MANIFEST_INVALID');
    }
    const retainedSet = new Set(raw.retained);
    const forbiddenSet = new Set(raw.forbiddenW1A);
    const approvedSet = new Set(raw.approvedSubset);
    const deferredReasons = raw.deferredReasons as Record<string, unknown>;
    if (retainedSet.size !== raw.retained.length
        || retainedSet.size !== SUPABASE_OPERATIONAL_RETAINED_TABLES.length
        || SUPABASE_OPERATIONAL_RETAINED_TABLES.some(name => !retainedSet.has(name))
        || forbiddenSet.size !== raw.forbiddenW1A.length
        || forbiddenSet.size !== SUPABASE_OPERATIONAL_FORBIDDEN_W1A.length
        || SUPABASE_OPERATIONAL_FORBIDDEN_W1A.some(name => !forbiddenSet.has(name))
        || approvedSet.size !== raw.approvedSubset.length
        || raw.approvedSubset.some(name => !SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.includes(name as never))
        || Object.keys(deferredReasons).some(name => !SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.includes(name as never))
        || SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.some(name => !approvedSet.has(name)
            && (typeof deferredReasons[name] !== 'string' || !deferredReasons[name].trim())) ) {
        throw new Error('OPERATIONAL_POLICY_EVIDENCE_MANIFEST_INVALID');
    }
    if (raw.noActivationEvidence !== undefined) {
        const attestation = raw.noActivationEvidence;
        if (!isRecord(attestation)
            || !hasOnlyKeys(attestation, [
                'source', 'verified', 'admissionActivated', 'realCanaryStarted',
            ])
            || attestation.source !== 'independent-read-only'
            || attestation.verified !== true
            || attestation.admissionActivated !== false
            || attestation.realCanaryStarted !== false) {
            throw new Error('OPERATIONAL_POLICY_EVIDENCE_MANIFEST_INVALID');
        }
    }
    const archive = isRecord(raw.archiveManifest) ? raw.archiveManifest : null;
    if (!archive || typeof archive.verified !== 'boolean'
        || (archive.aggregateChecksum !== null
            && (typeof archive.aggregateChecksum !== 'string' || !HASH_PATTERN.test(archive.aggregateChecksum)))
        || !['verified', 'mismatch', 'blocked', 'not_run'].includes(String(archive.restoreStatus))) {
        throw new Error('OPERATIONAL_POLICY_EVIDENCE_MANIFEST_INVALID');
    }
    const archiveManifest: Supabase22ArchiveEvidence = {
        verified: false,
        aggregateChecksum: null,
        restoreStatus: 'blocked',
        ...(archive.manifest === undefined || archive.manifest === null
            ? {} : { manifest: parseArchiveManifest(archive.manifest) }),
        ...(archive.restoreManifest === undefined || archive.restoreManifest === null
            ? {} : { restoreManifest: parseRestoreManifest(archive.restoreManifest) }),
    };
    const input: SupabaseOperationalPolicyInput = {
        schemaVersion: raw.schemaVersion,
        sourceSha: raw.sourceSha,
        retained: raw.retained as string[],
        forbiddenW1A: raw.forbiddenW1A as string[],
        approvedSubset: raw.approvedSubset as string[],
        closure: raw.closure as SupabaseOperationalPolicyClosure,
        noCascadeAllowlistHash: typeof raw.noCascadeAllowlistHash === 'string'
            ? raw.noCascadeAllowlistHash : null,
        retainedInvariantVerified: raw.retainedInvariantVerified === true,
        forbiddenInvariantVerified: raw.forbiddenInvariantVerified === true,
        dependencyClean: raw.dependencyClean === true,
        migrationHistoryClean: raw.migrationHistoryClean === true,
        genuineCompletedBundleEvidence: raw.genuineCompletedBundleEvidence === true,
        parityStatus: raw.parityStatus === 'ready' || raw.parityStatus === 'mismatch'
            ? raw.parityStatus : 'blocked',
        archiveManifest,
        rollbackEvidenceVerified: raw.rollbackEvidenceVerified === true,
        observationWindowClosed: raw.observationWindowClosed === true,
        ownerApprovalRecorded: raw.ownerApprovalRecorded === true,
        paymentPendingDispositionRecorded: raw.paymentPendingDispositionRecorded === true,
        noActivationOrCanary: raw.noActivationOrCanary === true,
        archiveRestoreChecksumMatch: raw.archiveRestoreChecksumMatch === true,
        deferredReasons: raw.deferredReasons as Record<string, string>,
        ...(raw.noActivationEvidence === undefined ? {} : {
            noActivationEvidence: raw.noActivationEvidence as SupabaseOperationalPolicyInput['noActivationEvidence'],
        }),
    };
    // A file supplied by a caller is not independent evidence. Re-evaluate it
    // with every attestable boolean fail-closed.
    return evaluateSupabaseOperationalPolicy({
        ...input,
        archiveManifest: emptyArchiveEvidence(),
        retainedInvariantVerified: false,
        forbiddenInvariantVerified: false,
        dependencyClean: false,
        migrationHistoryClean: false,
        genuineCompletedBundleEvidence: false,
        parityStatus: 'blocked',
        rollbackEvidenceVerified: false,
        observationWindowClosed: false,
        ownerApprovalRecorded: false,
        paymentPendingDispositionRecorded: false,
        noActivationOrCanary: false,
        archiveRestoreChecksumMatch: false,
    });
}

export type Supabase22IndependentArchiveProof = Readonly<{
    source: 'independent-read-only';
    selectedCount: number;
    archiveChecksum: string;
    restoreCount: number;
    restoreChecksum: string;
    encryptionAlgorithm: string;
    retentionClass: string;
    isolatedRestoreVerified: boolean;
}>;

export function parseSupabase22IndependentArchiveProof(value: unknown): Supabase22IndependentArchiveProof {
    if (!isRecord(value)
        || !hasOnlyKeys(value, [
            'source', 'selectedCount', 'archiveChecksum', 'restoreCount', 'restoreChecksum',
            'encryptionAlgorithm', 'retentionClass', 'isolatedRestoreVerified',
        ])
        || value.source !== 'independent-read-only'
        || !Number.isSafeInteger(value.selectedCount) || (value.selectedCount as number) <= 0
        || (value.selectedCount as number) > MAX_ARCHIVE_PROOF_RECORDS
        || !Number.isSafeInteger(value.restoreCount) || (value.restoreCount as number) <= 0
        || (value.restoreCount as number) > MAX_ARCHIVE_PROOF_RECORDS
        || typeof value.archiveChecksum !== 'string' || !HASH_PATTERN.test(value.archiveChecksum)
        || typeof value.restoreChecksum !== 'string' || !HASH_PATTERN.test(value.restoreChecksum)
        || value.encryptionAlgorithm !== ARCHIVE_ENCRYPTION_ALGORITHM
        || !safeName(value.retentionClass)
        || value.isolatedRestoreVerified !== true) {
        throw new Error('OPERATIONAL_POLICY_INDEPENDENT_ARCHIVE_PROOF_INVALID');
    }
    return value as Supabase22IndependentArchiveProof;
}

function archiveEvidenceFromProof(
    aggregate: ReturnType<typeof buildOrderAuditParityAggregate>,
    proof: Supabase22IndependentArchiveProof | null,
): Supabase22ArchiveEvidence {
    if (!proof) return emptyArchiveEvidence();
    const archiveMatch = proof.selectedCount === aggregate.realCompletedCount
        && proof.archiveChecksum === aggregate.aggregateChecksum;
    const restoreMatch = proof.isolatedRestoreVerified
        && proof.restoreCount === proof.selectedCount
        && proof.restoreChecksum === proof.archiveChecksum;
    const manifest: Supabase22ArchiveManifest = {
        schemaVersion: 'supabase-22-archive-manifest-v1',
        selectedCount: proof.selectedCount,
        aggregateChecksum: proof.archiveChecksum,
        encrypted: true,
        encryption: { algorithm: ARCHIVE_ENCRYPTION_ALGORITHM, verified: true },
        retentionClass: proof.retentionClass,
    };
    const restoreManifest: Supabase22RestoreManifest = {
        schemaVersion: 'supabase-22-restore-manifest-v1',
        selectedCount: proof.restoreCount,
        aggregateChecksum: proof.restoreChecksum,
        encrypted: true,
        encryption: { algorithm: ARCHIVE_ENCRYPTION_ALGORITHM, verified: true },
        retentionClass: proof.retentionClass,
    };
    return {
        verified: archiveMatch,
        aggregateChecksum: proof.archiveChecksum,
        restoreStatus: restoreMatch ? 'verified' : 'mismatch',
        manifest,
        restoreManifest,
    };
}

export type Supabase22ArchiveRestoreReport = Readonly<{
    schemaVersion: 'supabase-operational-policy-v1-archive-restore';
    policySchemaVersion: typeof SUPABASE_OPERATIONAL_POLICY_SCHEMA;
    status: 'ready' | 'mismatch' | 'blocked';
    selectedCount: number;
    aggregateChecksum: string | null;
    archiveManifest: Supabase22ArchiveEvidence & Readonly<{
        encrypted: boolean;
        retentionClass: string | null;
    }>;
    restoreStatus: 'verified' | 'mismatch' | 'blocked' | 'not_run';
    checksumMatch: boolean;
    destructiveOperations: 'refused';
}>;

function reportFromPolicy(
    evidence: SupabaseOperationalPolicyEvidence,
    restored: Supabase22RestoredManifest | null,
): Supabase22ArchiveRestoreReport {
    const sourceManifest = evidence.archiveManifest.manifest;
    const checksum = evidence.archiveManifest.aggregateChecksum;
    const selectedCount = isGenuineArchiveManifest(sourceManifest) ? sourceManifest.selectedCount : 0;
    const checksumMatch = restored !== null
        && restored.aggregateChecksum === checksum
        && restored.selectedCount === selectedCount
        && isGenuineArchiveManifest(sourceManifest)
        && restored.retentionClass === sourceManifest.retentionClass;
    const restoreStatus = restored === null ? evidence.archiveManifest.restoreStatus
        : checksumMatch ? 'verified' : 'mismatch';
    const report: Supabase22ArchiveRestoreReport = {
        schemaVersion: 'supabase-operational-policy-v1-archive-restore',
        policySchemaVersion: SUPABASE_OPERATIONAL_POLICY_SCHEMA,
        status: evidence.status === 'ready' && restoreStatus === 'verified' && checksumMatch
            ? 'ready' : restoreStatus === 'mismatch' ? 'mismatch' : 'blocked',
        selectedCount,
        aggregateChecksum: typeof checksum === 'string' && HASH_PATTERN.test(checksum) ? checksum : null,
        archiveManifest: {
            ...evidence.archiveManifest,
            encrypted: isGenuineArchiveManifest(sourceManifest) && sourceManifest.encrypted === true,
            retentionClass: isGenuineArchiveManifest(sourceManifest) ? sourceManifest.retentionClass : null,
        },
        restoreStatus,
        checksumMatch,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(report);
    return report;
}

export async function runSupabase22ArchiveRestoreCli(
    args: readonly string[],
    dependencies: Supabase22ArchiveRestoreCliDependencies = defaultDependencies(),
): Promise<{ exitCode: 0 | 1; report: Supabase22ArchiveRestoreReport }> {
    const options = parseSupabase22ArchiveRestoreCliArgs(args);
    let evidence: SupabaseOperationalPolicyEvidence;
    if (options.manifestPath) {
        evidence = parsePolicyManifest(await dependencies.readManifest(options.manifestPath));
    } else if (options.requestIds.length > 0) {
        const snapshots = await Promise.all(options.requestIds.map(id => dependencies.readSnapshot(id)));
        const aggregate = buildOrderAuditParityAggregate(
            snapshots.map(snapshot => buildOrderAuditParityReport(snapshot)),
        );
        let proof: Supabase22IndependentArchiveProof | null = null;
        if (dependencies.readArchiveEvidence) {
            try {
                proof = parseSupabase22IndependentArchiveProof(await dependencies.readArchiveEvidence(
                    options.requestIds,
                    aggregate.aggregateChecksum,
                ));
            } catch {
                proof = null;
            }
        }
        const archiveManifest = archiveEvidenceFromProof(aggregate, proof);
        evidence = evaluateSupabaseOperationalPolicy(policyInputFromEvidence(archiveManifest, {
            genuineCompletedBundleEvidence: aggregate.realCompletedCount > 0,
            parityStatus: aggregate.archive.parityStatus,
            archiveRestoreChecksumMatch: archiveManifest.restoreStatus === 'verified',
        }));
    } else {
        evidence = evaluateSupabaseOperationalPolicy(policyInputFromEvidence(emptyArchiveEvidence()));
    }

    const isolatedRestorePath = options.restorePath !== null
        && (options.manifestPath === null || options.restorePath !== options.manifestPath);
    let restored: Supabase22RestoredManifest | null = null;
    if (isolatedRestorePath && evidence.archiveManifest.verified
        && isGenuineArchiveManifest(evidence.archiveManifest.manifest)) {
        try {
            restored = parseRestoreManifest(await dependencies.readRestoreManifest(options.restorePath!));
        } catch {
            restored = null;
        }
        const input = policyInputFromEvidence({
            ...evidence.archiveManifest,
            restoreStatus: restored !== null
                && restored.aggregateChecksum === evidence.archiveManifest.aggregateChecksum
                && restored.selectedCount === evidence.archiveManifest.manifest.selectedCount
                ? 'verified' : 'mismatch',
            ...(restored === null ? {} : { restoreManifest: restored }),
        }, {
            genuineCompletedBundleEvidence: evidence.genuineCompletedBundleEvidence,
            parityStatus: evidence.parityStatus,
            archiveRestoreChecksumMatch: restored !== null,
        });
        evidence = evaluateSupabaseOperationalPolicy(input);
    }
    const report = reportFromPolicy(evidence, restored);
    const output = options.includeArchiveManifest
        ? report
        : Object.fromEntries(Object.entries(report).filter(([key]) => key !== 'archiveManifest'));
    dependencies.writeStdout(`${JSON.stringify(output, null, 2)}\n`);
    return { exitCode: report.status === 'ready' ? 0 : 1, report };
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runSupabase22ArchiveRestoreCli(process.argv.slice(2))
        .then(result => { process.exitCode = result.exitCode; })
        .catch(() => {
            process.stderr.write('OPERATIONAL_POLICY_ARCHIVE_RESTORE_REFUSED\n');
            process.exitCode = 1;
        });
}
