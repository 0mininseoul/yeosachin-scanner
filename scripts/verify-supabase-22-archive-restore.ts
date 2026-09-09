import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
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
    evaluateSupabase22Gate,
    isGenuineArchiveManifest,
    isGenuineRestoreManifest,
    type Supabase22ArchiveEvidence,
    type Supabase22ArchiveManifest,
    type Supabase22Evidence,
    type Supabase22RestoreManifest,
} from '../lib/services/operations/supabase-22-evidence';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_REQUESTS = 20;
const READ_ONLY_OPTIONS = new Set([
    '--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate',
]);

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

const EVIDENCE_KEYS = [
    'schemaVersion', 'status', 'publicTableCount', 'canonicalTables', 'unexpectedTables',
    'missingTables', 'dependencyClean', 'migrationHistoryClean', 'genuineCompletedBundleCount',
    'parityStatus', 'archiveManifest', 'rollbackEvidenceVerified', 'observationWindowClosed',
    'ownerApprovalRecorded', 'canonicalSetMatch', 'catalogDependencyClean',
    'paymentPendingDispositionRecorded', 'noActivationOrCanary', 'archiveRestoreChecksumMatch',
    'destructiveOperations', 'missingGates',
] as const;
const ARCHIVE_MANIFEST_KEYS = [
    'schemaVersion', 'selectedCount', 'aggregateChecksum', 'encrypted', 'encryption',
    'retentionClass',
] as const;
const ENCRYPTION_KEYS = ['algorithm', 'verified'] as const;
const ARCHIVE_ENCRYPTION_ALGORITHM = 'AES-256-GCM';
const INDEPENDENT_ARCHIVE_PROOF_KEYS = [
    'source', 'selectedCount', 'archiveChecksum', 'restoreCount', 'restoreChecksum',
    'encryptionAlgorithm', 'retentionClass', 'isolatedRestoreVerified',
] as const;
const INDEPENDENT_RESTORE_PROOF_KEYS = [
    'source', 'selectedCount', 'restoreChecksum', 'encryptionAlgorithm', 'retentionClass',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[] = [],
): boolean {
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    return Object.keys(value).every(key => allowed.has(key))
        && requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function safeManifestName(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 256
        && /^[a-z][a-z0-9_.-]*$/i.test(value);
}

function parseEncryption(value: unknown): { algorithm: string; verified: true } {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ENCRYPTION_KEYS)
        || value.algorithm !== ARCHIVE_ENCRYPTION_ALGORITHM
        || value.verified !== true) {
        throw new Error('SUPABASE_22_EVIDENCE_MANIFEST_INVALID');
    }
    return { algorithm: value.algorithm, verified: true };
}

function parseArchiveManifest(value: unknown): Supabase22ArchiveManifest {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ARCHIVE_MANIFEST_KEYS)
        || !isGenuineArchiveManifest(value)) {
        throw new Error('SUPABASE_22_EVIDENCE_MANIFEST_INVALID');
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
        || !hasOnlyKeys(value, ARCHIVE_MANIFEST_KEYS)
        || !isGenuineRestoreManifest(value)) {
        throw new Error('SUPABASE_22_RESTORE_MANIFEST_INVALID');
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
        if (READ_ONLY_OPTIONS.has(optionName(option))) {
            throw new Error('read-only verifier rejects destructive mode');
        }
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
            if (!value || value.startsWith('--') || !UUID_PATTERN.test(value)) {
                throw new Error('--request-id must be a UUID');
            }
            if (option === '--request-id') index += 1;
            if (requestIds.includes(value)) throw new Error('--request-id must be unique');
            requestIds.push(value);
            if (requestIds.length > MAX_REQUESTS) throw new Error('at most 20 request IDs are allowed');
            continue;
        }
        if (option === '--restore-path' || option.startsWith('--restore-path=')) {
            if (restorePath !== null) throw new Error('--restore-path must appear exactly once');
            const value = option === '--restore-path' ? args[index + 1] : option.slice('--restore-path='.length);
            if (!value || value.startsWith('--')) throw new Error('--restore-path requires a path');
            restorePath = value;
            if (option === '--restore-path') index += 1;
            continue;
        }
        if (option === '--manifest' || option.startsWith('--manifest=')) {
            if (manifestPath !== null) throw new Error('--manifest must appear exactly once');
            const value = option === '--manifest' ? args[index + 1] : option.slice('--manifest='.length);
            if (!value || value.startsWith('--')) throw new Error('--manifest requires a path');
            manifestPath = value;
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
    /** Independent read-only archive/object-store observation; never a supplied manifest. */
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

function parseEvidenceManifest(value: unknown): Supabase22Evidence {
    if (!isRecord(value) || !hasOnlyKeys(value, EVIDENCE_KEYS)) {
        throw new Error('SUPABASE_22_EVIDENCE_MANIFEST_INVALID');
    }
    const evidence = value as Partial<Supabase22Evidence>;
    if (evidence.schemaVersion !== 'supabase-22-evidence-v1'
        || (evidence.status !== 'ready'
            && evidence.status !== 'mismatch'
            && evidence.status !== 'blocked')
        || !Number.isSafeInteger(evidence.publicTableCount)
        || (evidence.publicTableCount ?? -1) < 0
        || !Array.isArray(evidence.canonicalTables)
        || !Array.isArray(evidence.unexpectedTables)
        || !Array.isArray(evidence.missingTables)
        || typeof evidence.dependencyClean !== 'boolean'
        || typeof evidence.migrationHistoryClean !== 'boolean'
        || !Number.isSafeInteger(evidence.genuineCompletedBundleCount)
        || (evidence.genuineCompletedBundleCount ?? -1) < 0
        || (evidence.parityStatus !== 'ready'
            && evidence.parityStatus !== 'mismatch'
            && evidence.parityStatus !== 'blocked')
        || !evidence.archiveManifest
        || typeof evidence.rollbackEvidenceVerified !== 'boolean'
        || typeof evidence.observationWindowClosed !== 'boolean'
        || typeof evidence.ownerApprovalRecorded !== 'boolean'
        || typeof evidence.canonicalSetMatch !== 'boolean'
        || typeof evidence.catalogDependencyClean !== 'boolean'
        || typeof evidence.paymentPendingDispositionRecorded !== 'boolean'
        || typeof evidence.noActivationOrCanary !== 'boolean'
        || typeof evidence.archiveRestoreChecksumMatch !== 'boolean'
        || evidence.destructiveOperations !== 'refused'
        || !Array.isArray(evidence.missingGates)
        || evidence.missingGates.some(gate => typeof gate !== 'string')) {
        throw new Error('SUPABASE_22_EVIDENCE_MANIFEST_INVALID');
    }
    if (evidence.canonicalTables.some(table => !safeManifestName(table))
        || evidence.unexpectedTables.some(table => !safeManifestName(table))
        || evidence.missingTables.some(table => !safeManifestName(table))) {
        throw new Error('SUPABASE_22_EVIDENCE_MANIFEST_INVALID');
    }
    const archive = evidence.archiveManifest;
    if (!isRecord(archive)
        || !hasOnlyKeys(archive, ['verified', 'aggregateChecksum', 'restoreStatus'], [
            'manifest', 'restoreManifest',
        ])
        || typeof archive.verified !== 'boolean'
        || (archive.aggregateChecksum !== null
            && (typeof archive.aggregateChecksum !== 'string' || !HASH_PATTERN.test(archive.aggregateChecksum)))
        || (archive.restoreStatus !== 'verified'
            && archive.restoreStatus !== 'mismatch'
            && archive.restoreStatus !== 'blocked'
            && archive.restoreStatus !== 'not_run')) {
        throw new Error('SUPABASE_22_EVIDENCE_MANIFEST_INVALID');
    }
    const archiveManifest = archive.manifest === undefined || archive.manifest === null
        ? null
        : parseArchiveManifest(archive.manifest);
    const restoreManifest = archive.restoreManifest === undefined || archive.restoreManifest === null
        ? null
        : parseRestoreManifest(archive.restoreManifest);
    const sanitizedEvidence: Supabase22Evidence = {
        schemaVersion: 'supabase-22-evidence-v1',
        status: evidence.status,
        publicTableCount: evidence.publicTableCount!,
        canonicalTables: [...evidence.canonicalTables],
        unexpectedTables: [...evidence.unexpectedTables],
        missingTables: [...evidence.missingTables],
        dependencyClean: evidence.dependencyClean,
        migrationHistoryClean: evidence.migrationHistoryClean,
        genuineCompletedBundleCount: evidence.genuineCompletedBundleCount!,
        parityStatus: evidence.parityStatus,
        archiveManifest: {
            verified: archive.verified,
            aggregateChecksum: archive.aggregateChecksum,
            restoreStatus: archive.restoreStatus,
            ...(archiveManifest === null ? {} : { manifest: archiveManifest }),
            ...(restoreManifest === null ? {} : { restoreManifest }),
        },
        rollbackEvidenceVerified: evidence.rollbackEvidenceVerified,
        observationWindowClosed: evidence.observationWindowClosed,
        ownerApprovalRecorded: evidence.ownerApprovalRecorded,
        canonicalSetMatch: evidence.canonicalSetMatch!,
        catalogDependencyClean: evidence.catalogDependencyClean!,
        paymentPendingDispositionRecorded: evidence.paymentPendingDispositionRecorded!,
        noActivationOrCanary: evidence.noActivationOrCanary!,
        archiveRestoreChecksumMatch: evidence.archiveRestoreChecksumMatch!,
        destructiveOperations: 'refused',
        missingGates: [...evidence.missingGates],
    };
    assertPiiSafeConsolidationOutput(sanitizedEvidence);
    // A JSON evidence/manifest file is caller-supplied metadata, not independent
    // archive, payment, traffic, or activation evidence. Keep it useful for a
    // blocked report, but never let its booleans upgrade readiness.
    return evaluateSupabase22Gate({
        ...sanitizedEvidence,
        archiveManifest: { verified: false, aggregateChecksum: null, restoreStatus: 'blocked' },
        rollbackEvidenceVerified: false,
        observationWindowClosed: false,
        ownerApprovalRecorded: false,
        canonicalSetMatch: false,
        catalogDependencyClean: false,
        paymentPendingDispositionRecorded: false,
        noActivationOrCanary: false,
        archiveRestoreChecksumMatch: false,
    });
}

function parseRestoredManifest(value: unknown): Supabase22RestoredManifest {
    if (!isRecord(value)
        || !hasOnlyKeys(value, INDEPENDENT_RESTORE_PROOF_KEYS)
        || value.source !== 'independent-read-only'
        || !Number.isSafeInteger(value.selectedCount)
        || (value.selectedCount as number) <= 0
        || typeof value.restoreChecksum !== 'string'
        || !HASH_PATTERN.test(value.restoreChecksum)
        || value.encryptionAlgorithm !== ARCHIVE_ENCRYPTION_ALGORITHM
        || !safeManifestName(value.retentionClass)) {
        throw new Error('SUPABASE_22_INDEPENDENT_RESTORE_PROOF_INVALID');
    }
    const manifest: Supabase22RestoreManifest = {
        schemaVersion: 'supabase-22-restore-manifest-v1',
        selectedCount: value.selectedCount as number,
        aggregateChecksum: value.restoreChecksum,
        encrypted: true,
        encryption: { algorithm: ARCHIVE_ENCRYPTION_ALGORITHM, verified: true },
        retentionClass: value.retentionClass as string,
    };
    assertPiiSafeConsolidationOutput(manifest);
    return manifest;
}

export type Supabase22ArchiveRestoreReport = Readonly<{
    schemaVersion: 'supabase-22-archive-restore-v1';
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

type Supabase22IndependentArchiveProof = Readonly<{
    source: 'independent-read-only';
    selectedCount: number;
    archiveChecksum: string;
    restoreCount: number;
    restoreChecksum: string;
    encryptionAlgorithm: typeof ARCHIVE_ENCRYPTION_ALGORITHM;
    retentionClass: string;
    isolatedRestoreVerified: true;
}>;

function parseIndependentArchiveProof(value: unknown): Supabase22IndependentArchiveProof {
    if (!isRecord(value)
        || !hasOnlyKeys(value, INDEPENDENT_ARCHIVE_PROOF_KEYS)
        || value.source !== 'independent-read-only'
        || !Number.isSafeInteger(value.selectedCount)
        || (value.selectedCount as number) <= 0
        || !Number.isSafeInteger(value.restoreCount)
        || (value.restoreCount as number) <= 0
        || typeof value.archiveChecksum !== 'string'
        || !HASH_PATTERN.test(value.archiveChecksum)
        || typeof value.restoreChecksum !== 'string'
        || !HASH_PATTERN.test(value.restoreChecksum)
        || value.encryptionAlgorithm !== ARCHIVE_ENCRYPTION_ALGORITHM
        || !safeManifestName(value.retentionClass)
        || value.isolatedRestoreVerified !== true) {
        throw new Error('SUPABASE_22_INDEPENDENT_ARCHIVE_PROOF_INVALID');
    }
    return {
        source: 'independent-read-only',
        selectedCount: value.selectedCount as number,
        archiveChecksum: value.archiveChecksum,
        restoreCount: value.restoreCount as number,
        restoreChecksum: value.restoreChecksum,
        encryptionAlgorithm: ARCHIVE_ENCRYPTION_ALGORITHM,
        retentionClass: value.retentionClass as string,
        isolatedRestoreVerified: true,
    };
}

function archiveEvidenceFromIndependentProof(
    aggregate: ReturnType<typeof buildOrderAuditParityAggregate>,
    proof: Supabase22IndependentArchiveProof | null,
): Supabase22ArchiveEvidence {
    if (proof === null) {
        return { verified: false, aggregateChecksum: null, restoreStatus: 'blocked' };
    }
    const archiveMatch = proof.selectedCount === aggregate.selectedCount
        && proof.archiveChecksum === aggregate.aggregateChecksum;
    const restoreMatch = archiveMatch
        && proof.restoreCount === aggregate.selectedCount
        && proof.restoreChecksum === proof.archiveChecksum;
    const archiveManifest: Supabase22ArchiveManifest = {
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
        manifest: archiveManifest,
        restoreManifest,
    };
}

function reportFromEvidence(
    evidence: Supabase22Evidence,
    restored: Supabase22RestoredManifest | null,
): Supabase22ArchiveRestoreReport {
    const selectedCount = evidence.genuineCompletedBundleCount;
    const checksum = evidence.archiveManifest.aggregateChecksum;
    const sourceManifest = evidence.archiveManifest.manifest;
    const encrypted = isGenuineArchiveManifest(sourceManifest)
        && sourceManifest.encrypted === true;
    const retentionClass = isGenuineArchiveManifest(sourceManifest)
        ? sourceManifest.retentionClass
        : null;
    const restoreEvidenceValid = isGenuineRestoreManifest(evidence.archiveManifest.restoreManifest)
        && isGenuineArchiveManifest(sourceManifest)
        && evidence.archiveManifest.restoreManifest.selectedCount === selectedCount
        && evidence.archiveManifest.restoreManifest.aggregateChecksum === checksum
        && evidence.archiveManifest.restoreManifest.retentionClass === sourceManifest.retentionClass
        && evidence.archiveManifest.restoreStatus === 'verified';
    const checksumMatch = restoreEvidenceValid || (restored !== null
        && restored.encrypted === true
        && restored.encryption.verified === true
        && restored.selectedCount === selectedCount
        && restored.aggregateChecksum === checksum
        && isGenuineArchiveManifest(sourceManifest)
        && restored.retentionClass === sourceManifest.retentionClass);
    const restoreStatus = restored === null
        ? restoreEvidenceValid
            ? evidence.archiveManifest.restoreStatus
            : evidence.archiveManifest.restoreStatus === 'mismatch'
                ? 'mismatch'
                : evidence.archiveManifest.restoreStatus === 'not_run'
                    ? 'not_run'
                    : 'blocked'
        : checksumMatch ? 'verified' : 'mismatch';
    const sanitizedArchiveManifest: Supabase22ArchiveEvidence = {
        verified: evidence.archiveManifest.verified === true,
        aggregateChecksum: typeof checksum === 'string' && HASH_PATTERN.test(checksum)
            ? checksum
            : null,
        restoreStatus,
        ...(isGenuineArchiveManifest(sourceManifest)
            ? {
                manifest: {
                    schemaVersion: 'supabase-22-archive-manifest-v1' as const,
                    selectedCount: sourceManifest.selectedCount,
                    aggregateChecksum: sourceManifest.aggregateChecksum,
                    encrypted: true as const,
                    encryption: {
                        algorithm: sourceManifest.encryption.algorithm,
                        verified: true as const,
                    },
                    retentionClass: sourceManifest.retentionClass,
                },
            }
            : {}),
        ...(isGenuineRestoreManifest(evidence.archiveManifest.restoreManifest)
            ? {
                restoreManifest: {
                    schemaVersion: 'supabase-22-restore-manifest-v1' as const,
                    selectedCount: evidence.archiveManifest.restoreManifest.selectedCount,
                    aggregateChecksum: evidence.archiveManifest.restoreManifest.aggregateChecksum,
                    encrypted: true as const,
                    encryption: {
                        algorithm: evidence.archiveManifest.restoreManifest.encryption.algorithm,
                        verified: true as const,
                    },
                    retentionClass: evidence.archiveManifest.restoreManifest.retentionClass,
                },
            }
            : {}),
    };
    const report: Supabase22ArchiveRestoreReport = {
        schemaVersion: 'supabase-22-archive-restore-v1',
        status: evidence.status === 'ready' && restoreStatus === 'verified' && checksumMatch
            ? 'ready'
            : evidence.status === 'mismatch' || restoreStatus === 'mismatch' ? 'mismatch' : 'blocked',
        selectedCount,
        aggregateChecksum: sanitizedArchiveManifest.aggregateChecksum,
        archiveManifest: {
            ...sanitizedArchiveManifest,
            encrypted,
            retentionClass,
        },
        restoreStatus,
        checksumMatch,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(report);
    return report;
}

function evidenceFromAggregate(
    aggregate: ReturnType<typeof buildOrderAuditParityAggregate>,
    archiveProof: Supabase22IndependentArchiveProof | null = null,
): Supabase22Evidence {
    const archiveManifest = archiveEvidenceFromIndependentProof(aggregate, archiveProof);
    const archiveReady = archiveManifest.verified === true
        && archiveManifest.restoreStatus === 'verified';
    return evaluateSupabase22Gate({
        publicTableCount: 0,
        canonicalTables: [],
        unexpectedTables: [],
        missingTables: [],
        dependencyClean: false,
        migrationHistoryClean: false,
        genuineCompletedBundleCount: aggregate.realCompletedCount,
        parityStatus: aggregate.archive.parityStatus,
        archiveManifest,
        rollbackEvidenceVerified: false,
        observationWindowClosed: false,
        ownerApprovalRecorded: false,
        canonicalSetMatch: false,
        catalogDependencyClean: false,
        paymentPendingDispositionRecorded: false,
        noActivationOrCanary: false,
        archiveRestoreChecksumMatch: archiveReady,
    });
}

export async function runSupabase22ArchiveRestoreCli(
    args: readonly string[],
    dependencies: Supabase22ArchiveRestoreCliDependencies = defaultDependencies(),
): Promise<{ exitCode: 0 | 1; report: Supabase22ArchiveRestoreReport }> {
    const options = parseSupabase22ArchiveRestoreCliArgs(args);
    let evidence: Supabase22Evidence;
    if (options.manifestPath) {
        evidence = parseEvidenceManifest(await dependencies.readManifest(options.manifestPath));
    } else if (options.requestIds.length > 0) {
        const snapshots = await Promise.all(options.requestIds.map(id => dependencies.readSnapshot(id)));
        const aggregate = buildOrderAuditParityAggregate(
            snapshots.map(snapshot => buildOrderAuditParityReport(snapshot)),
        );
        let archiveProof: Supabase22IndependentArchiveProof | null = null;
        if (dependencies.readArchiveEvidence) {
            try {
                archiveProof = parseIndependentArchiveProof(await dependencies.readArchiveEvidence(
                    options.requestIds,
                    aggregate.aggregateChecksum,
                ));
            } catch {
                archiveProof = null;
            }
        }
        evidence = evidenceFromAggregate(aggregate, archiveProof);
    } else {
        evidence = evaluateSupabase22Gate({
            publicTableCount: 0,
            canonicalTables: [],
            unexpectedTables: [],
            missingTables: [],
            dependencyClean: false,
            migrationHistoryClean: false,
            genuineCompletedBundleCount: 0,
            parityStatus: 'blocked',
            archiveManifest: { verified: false, aggregateChecksum: null, restoreStatus: 'blocked' },
            rollbackEvidenceVerified: false,
            observationWindowClosed: false,
            ownerApprovalRecorded: false,
            canonicalSetMatch: false,
            catalogDependencyClean: false,
            paymentPendingDispositionRecorded: false,
            noActivationOrCanary: false,
            archiveRestoreChecksumMatch: false,
        });
    }
    const isolatedRestorePath = options.restorePath !== null
        && (options.manifestPath === null
            || resolvePath(options.restorePath) !== resolvePath(options.manifestPath));
    let restored: Supabase22RestoredManifest | null = null;
    let restoreReadFailed = false;
    if (options.restorePath && !isolatedRestorePath) {
        restoreReadFailed = true;
    }
    if (isolatedRestorePath
        && evidence.archiveManifest.verified
        && isGenuineArchiveManifest(evidence.archiveManifest.manifest)) {
        try {
            restored = parseRestoredManifest(
                await dependencies.readRestoreManifest(options.restorePath),
            );
        } catch {
            // A missing or malformed isolated restore manifest is evidence of a
            // blocked drill, never a reason to infer restore success.
            restoreReadFailed = true;
        }
    }
    const restoredChecksumMatch = restored !== null
        && restored.encrypted === true
        && restored.encryption.verified === true
        && restored.selectedCount === evidence.genuineCompletedBundleCount
        && restored.aggregateChecksum === evidence.archiveManifest.aggregateChecksum
        && isGenuineArchiveManifest(evidence.archiveManifest.manifest)
        && restored.retentionClass === evidence.archiveManifest.manifest.retentionClass;
    const independentRestoreAlreadyVerified = evidence.archiveManifest.restoreStatus === 'verified'
        && isGenuineRestoreManifest(evidence.archiveManifest.restoreManifest);
    const evaluatedEvidence = !isolatedRestorePath
        ? independentRestoreAlreadyVerified
            ? evidence
            : evaluateSupabase22Gate({
                ...evidence,
                archiveManifest: {
                    ...evidence.archiveManifest,
                    restoreStatus: 'blocked',
                    restoreManifest: null,
                },
                archiveRestoreChecksumMatch: false,
            })
        : restoreReadFailed
            ? evaluateSupabase22Gate({
                ...evidence,
                archiveManifest: {
                    ...evidence.archiveManifest,
                    restoreStatus: 'blocked',
                    restoreManifest: null,
                },
                archiveRestoreChecksumMatch: false,
            })
            : restored === null
                ? evidence
                : evaluateSupabase22Gate({
                    ...evidence,
                    archiveManifest: {
                        ...evidence.archiveManifest,
                        restoreStatus: restoredChecksumMatch ? 'verified' : 'mismatch',
                        restoreManifest: restored,
                    },
                    archiveRestoreChecksumMatch: restoredChecksumMatch,
                });
    const report = reportFromEvidence(evaluatedEvidence, restored);
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
        .then(result => {
            process.exitCode = result.exitCode;
        })
        .catch(() => {
            process.stderr.write(`${JSON.stringify({
                status: 'failed',
                errorCode: 'SUPABASE_22_ARCHIVE_RESTORE_VERIFY_FAILED',
                destructiveOperations: 'refused',
            })}\n`);
            process.exitCode = 1;
        });
}
