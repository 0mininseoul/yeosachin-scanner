import { createHash } from 'node:crypto';
import { z } from 'zod';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

const completenessSchema = z.enum(['complete', 'partial', 'inconsistent', 'failed']);
const costStatusSchema = z.enum(['complete', 'partial', 'unknown', 'not_available']);

const paritySectionSchema = z.object({
    sourceCount: z.number().int().min(0).nullable(),
    bundleCount: z.number().int().min(0).nullable(),
    sourceChecksum: z.string().regex(HASH_PATTERN).nullable(),
    bundleChecksum: z.string().regex(HASH_PATTERN).nullable(),
    sourceComplete: z.boolean().nullable(),
    bundleComplete: z.boolean().nullable(),
}).strict();

const orderAuditParitySnapshotSchema = z.object({
    request: z.object({
        completed: z.boolean(),
        productionOrder: z.boolean(),
        sourceDataPresent: z.boolean(),
    }).strict(),
    bundle: z.object({
        present: z.boolean(),
        completeness: completenessSchema.nullable(),
        costStatus: costStatusSchema.nullable(),
        version: z.number().int().positive().nullable(),
    }).strict(),
    recovery: z.object({
        present: z.boolean(),
        completed: z.boolean(),
    }).strict(),
    sections: z.object({
        relationships: paritySectionSchema.nullable(),
        targetEvidence: paritySectionSchema.nullable(),
        candidates: paritySectionSchema.nullable(),
        risk: paritySectionSchema.nullable(),
        costLedger: paritySectionSchema.nullable(),
    }).strict(),
}).strict();

export type OrderAuditParitySection = z.infer<typeof paritySectionSchema>;
export type OrderAuditParitySnapshot = z.infer<typeof orderAuditParitySnapshotSchema>;
export type OrderAuditParitySectionName = keyof OrderAuditParitySnapshot['sections'];

export const orderAuditParitySnapshotParser = orderAuditParitySnapshotSchema;

/**
 * JSON canonicalization used by every readiness checksum. Object keys are sorted while array
 * order remains significant, so the checksum reflects the source's documented ordering.
 */
export function stableSerialize(value: unknown): string {
    const canonicalize = (input: unknown): unknown => {
        if (input === undefined) return null;
        if (input === null) return null;
        if (typeof input === 'number') {
            if (!Number.isFinite(input)) throw new Error('ANALYSIS_ORDER_AUDIT_CHECKSUM_VALUE_INVALID');
            return input;
        }
        if (typeof input === 'string' || typeof input === 'boolean') return input;
        if (Array.isArray(input)) return input.map(child => canonicalize(child));
        if (typeof input === 'object') {
            const record = input as Record<string, unknown>;
            return Object.fromEntries(
                Object.keys(record)
                    .sort()
                    .map(key => [key, canonicalize(record[key])]),
            );
        }
        throw new Error('ANALYSIS_ORDER_AUDIT_CHECKSUM_VALUE_INVALID');
    };

    const serialized = JSON.stringify(canonicalize(value));
    if (serialized === undefined) throw new Error('ANALYSIS_ORDER_AUDIT_CHECKSUM_VALUE_INVALID');
    return serialized;
}

export function stableChecksum(value: unknown): string {
    return createHash('sha256').update(stableSerialize(value), 'utf8').digest('hex');
}

const forbiddenOutputKeys = new Set([
    'userid', 'useruuid', 'ownerid', 'owneruuid', 'actorid', 'actoruuid',
    'requestid', 'orderid', 'preflightid', 'accountid', 'provideraccount',
    'provideraccountid', 'token', 'accesstoken', 'providertoken', 'authorization',
    'cookie', 'secret', 'session', 'sessionid', 'sessionkey', 'claimtoken', 'jobclaimtoken',
    'reservationtoken', 'producerclaimtoken', 'raw', 'rawdata', 'rawpayload',
    'providerpayload', 'providerresponse', 'payload', 'comment', 'commenttext',
    'username', 'handle',
    // Raw/anonymous device and browser/network identifiers.
    'device', 'deviceid', 'deviceidentifier', 'rawdevice', 'rawdeviceid',
    'rawdeviceidentifier', 'anonymousdevice', 'anonymousdeviceid',
    'anonymousdeviceidentifier', 'anonymousprincipal', 'anonymousprincipalid',
    'rawanonymousdevice', 'rawanonymousdeviceid', 'anonymousprincipalhash',
    'principalhash', 'anonymous', 'ua', 'useragent', 'rawuseragent', 'httpuseragent',
    'useragentstring',
    'clientuseragent', 'ip', 'ipaddress', 'clientip', 'remoteip', 'forwardedfor',
    'xforwardedfor', 'remoteaddr', 'clientaddr', 'forwardedaddr', 'ipv4', 'ipv6',
    'devicefingerprint', 'anonymousdevicefingerprint',
    // Credentials and key material, including camelCase/snake_case forms after
    // normalization below.
    'apikey', 'secretkey', 'accesskey', 'privatekey', 'signingkey', 'encryptionkey',
    'hashkey', 'hmac', 'hmackey', 'internalhmac', 'tokenhash', 'apikeyhash',
    'capturetokenhash',
]);
const forbiddenOutputKeyPatterns = [
    /(?:token|secret|credential|password|authorization|cookie)/,
    /(?:session|claim|reservation|producer)(?:key|token|hash)/,
    /(?:api|access|refresh|secret|private|signing|encryption)(?:key|token|secret|credential)/,
    /(?:raw|anonymous)?device(?:$|id|identifier|hash|fingerprint|data|value)/,
    /anonymous(?:device|principal)(?:$|id|identifier|hash|fingerprint|data|value)/,
    /(?:client|remote|forwarded|xforwarded)?ip(?:$|address|v4|v6|value)/,
    /(?:raw|http|client)?useragent(?:$|string|hash|value)/,
    /(?:hash|hmac)key/,
    // Identity and tracking aliases are forbidden even when callers add a
    // suffix or use snake_case/camelCase spelling.  Do not broaden this to
    // every hash: aggregate/content checksums are intentional evidence.
    /(?:user|owner|visitor|principal|actor|subject|account|identity|customer|member|profile|target|subscriber|tenant|organization|org|team|client|tracking|session|email|phone|mobile|contact)(?:id|uuid|hash|fingerprint)/,
    /(?:ip|address)(?:id|hash|fingerprint)/,
    /(?:visitor|tracking|browser|device|fingerprint)(?:id|uuid|hash|fingerprint)/,
    /fingerprint/,
];
const UUID_VALUE_PATTERN = UUID_PATTERN;
const EMAIL_VALUE_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_VALUE_PATTERN = /^https?:\/\//i;
const IPV4_VALUE_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6_VALUE_PATTERN = /^[0-9a-f:]{2,39}$/i;
const CREDENTIAL_VALUE_PATTERN = /^(?:bearer|basic)\s+|^(?:sk|pk|api[_-]?key|token)[_-]/i;

function normalizeOutputKey(key: string): string {
    return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isForbiddenOutputKey(key: string): boolean {
    const normalized = normalizeOutputKey(key);
    return forbiddenOutputKeys.has(normalized)
        || forbiddenOutputKeyPatterns.some(pattern => pattern.test(normalized));
}

/** Reject any value that could turn an aggregate report into an identifier/payload export. */
export function assertPiiSafeConsolidationOutput(value: unknown): void {
    const visit = (current: unknown): void => {
        if (Array.isArray(current)) {
            current.forEach(child => visit(child));
            return;
        }
        if (typeof current === 'string') {
            if (UUID_VALUE_PATTERN.test(current) || EMAIL_VALUE_PATTERN.test(current)
                || URL_VALUE_PATTERN.test(current) || IPV4_VALUE_PATTERN.test(current)
                || (current.includes(':') && IPV6_VALUE_PATTERN.test(current))
                || CREDENTIAL_VALUE_PATTERN.test(current)) {
                throw new Error('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
            }
            return;
        }
        if (!current || typeof current !== 'object') return;
        for (const [key, child] of Object.entries(current)) {
            if (isForbiddenOutputKey(key)) {
                throw new Error('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PII');
            }
            visit(child);
        }
    };
    visit(value);
}

function emptyParitySnapshot(): OrderAuditParitySnapshot {
    return {
        request: {
            completed: false,
            productionOrder: false,
            sourceDataPresent: false,
        },
        bundle: {
            present: false,
            completeness: null,
            costStatus: null,
            version: null,
        },
        recovery: {
            present: false,
            completed: false,
        },
        sections: {
            relationships: null,
            targetEvidence: null,
            candidates: null,
            risk: null,
            costLedger: null,
        },
    };
}

export type OrderAuditParityReport = Readonly<{
    schemaVersion: 'analysis-order-audit-parity-v1';
    status: 'ready' | 'mismatch' | 'blocked';
    parityPassed: boolean;
    request: OrderAuditParitySnapshot['request'];
    bundle: OrderAuditParitySnapshot['bundle'];
    recovery: OrderAuditParitySnapshot['recovery'];
    sections: OrderAuditParitySnapshot['sections'];
    mismatchPaths: readonly string[];
}>;

const sectionLabels: readonly [OrderAuditParitySectionName, string][] = [
    ['relationships', 'relationships'],
    ['targetEvidence', 'targetEvidence'],
    ['candidates', 'candidates'],
    ['risk', 'risk'],
    ['costLedger', 'costLedger'],
];

export function buildOrderAuditParityReport(
    rawSnapshot: OrderAuditParitySnapshot,
): OrderAuditParityReport {
    const snapshot = orderAuditParitySnapshotSchema.parse(rawSnapshot);
    const mismatchPaths: string[] = [];

    if (!snapshot.request.completed || !snapshot.request.productionOrder) {
        mismatchPaths.push('request.not-a-real-completed-production-order');
    }
    if (!snapshot.request.sourceDataPresent) mismatchPaths.push('source.no-data');
    if (!snapshot.bundle.present) {
        mismatchPaths.push('bundle.missing');
    } else {
        if (snapshot.bundle.completeness !== 'complete') {
            mismatchPaths.push('bundle.completeness');
        }
        if (snapshot.bundle.costStatus !== 'complete') {
            mismatchPaths.push('bundle.cost.status');
        }
    }
    if (!snapshot.recovery.present) {
        mismatchPaths.push('recovery.missing');
    } else if (!snapshot.recovery.completed) {
        mismatchPaths.push('recovery.incomplete');
    }

    for (const [key, label] of sectionLabels) {
        const section = snapshot.sections[key];
        if (!section) {
            if (snapshot.request.sourceDataPresent && snapshot.bundle.present) {
                mismatchPaths.push(`sections.${label}.missing`);
            }
            continue;
        }
        if (section.sourceCount === null || section.bundleCount === null
            || section.sourceChecksum === null || section.bundleChecksum === null) {
            mismatchPaths.push(`sections.${label}.incomplete`);
            continue;
        }
        if (section.sourceCount !== section.bundleCount) {
            mismatchPaths.push(`sections.${label}.count`);
        }
        if (section.sourceChecksum !== section.bundleChecksum) {
            mismatchPaths.push(`sections.${label}.checksum`);
        }
        if (section.sourceComplete !== true) mismatchPaths.push(`sections.${label}.source-incomplete`);
        if (section.bundleComplete !== true) mismatchPaths.push(`sections.${label}.bundle-incomplete`);
    }

    const sourceAndBundleAvailable = snapshot.request.sourceDataPresent && snapshot.bundle.present;
    const hasMissingEvidence = mismatchPaths.some(path =>
        path === 'source.no-data'
        || path === 'bundle.missing'
        || path.endsWith('.incomplete')
        || path.endsWith('.missing')
        || path.endsWith('-incomplete')
        || path === 'bundle.completeness'
        || path === 'bundle.cost.status'
        || path === 'recovery.missing'
        || path === 'recovery.incomplete'
        || path.startsWith('request.'),
    );
    const status = !sourceAndBundleAvailable || hasMissingEvidence
        ? 'blocked'
        : mismatchPaths.length > 0 ? 'mismatch' : 'ready';
    const report: OrderAuditParityReport = {
        schemaVersion: 'analysis-order-audit-parity-v1',
        status,
        parityPassed: status === 'ready',
        request: snapshot.request,
        bundle: snapshot.bundle,
        recovery: snapshot.recovery,
        sections: snapshot.sections,
        mismatchPaths,
    };
    assertPiiSafeConsolidationOutput(report);
    return report;
}

export type ConsolidationReadinessInput = Readonly<{
    genuineCompletedBundleCount: number;
    perOrderParityCount: number;
    aggregateChecksumsMatch: boolean;
    archiveManifestVerified: boolean;
    restoreDrillVerified: boolean;
    rollbackEvidenceVerified: boolean;
    dependencyInventoryComplete: boolean;
    separateApprovalGranted: boolean;
    observationWindowClosed: boolean;
    /** Production contract attestations are required and fail closed when false. */
    publicTableCount: number;
    canonicalSetMatch: boolean;
    catalogDependencyClean: boolean;
    paymentPendingDispositionRecorded: boolean;
    noActivationOrCanary: boolean;
    archiveRestoreChecksumMatch: boolean;
}>;

export type ConsolidationReadiness = Readonly<{
    status: 'ready-for-separate-approval' | 'blocked';
    gates: Readonly<Record<string, boolean>>;
    missingGates: readonly string[];
    destructiveOperations: 'refused';
}>;

export function evaluateConsolidationReadiness(
    input: ConsolidationReadinessInput,
): ConsolidationReadiness {
    const gates: Record<string, boolean> = {
        'genuine-completed-bundle': input.genuineCompletedBundleCount > 0,
        'per-order-parity': input.genuineCompletedBundleCount > 0
            && input.perOrderParityCount === input.genuineCompletedBundleCount,
        'aggregate-checksums': input.aggregateChecksumsMatch,
        'archive-manifest': input.archiveManifestVerified,
        'restore-drill': input.restoreDrillVerified,
        'rollback-evidence': input.rollbackEvidenceVerified,
        'dependency-inventory': input.dependencyInventoryComplete,
        'separate-approval': input.separateApprovalGranted,
        'observation-window': input.observationWindowClosed,
    };
    gates['public-table-count'] = input.publicTableCount === 22;
    gates['canonical-set'] = input.canonicalSetMatch === true;
    gates['catalog-dependency'] = input.catalogDependencyClean === true;
    gates['payment-pending-disposition'] = input.paymentPendingDispositionRecorded === true;
    gates['no-activation-or-canary'] = input.noActivationOrCanary === true;
    gates['archive-restore-checksum'] = input.archiveRestoreChecksumMatch === true;
    const missingGates = Object.entries(gates)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
    const readiness: ConsolidationReadiness = {
        status: missingGates.length === 0 ? 'ready-for-separate-approval' : 'blocked',
        gates,
        missingGates,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(readiness);
    return readiness;
}

export function assertConsolidationMutationRefused(): never {
    throw new Error('ANALYSIS_ORDER_AUDIT_CONSOLIDATION_MUTATION_REFUSED');
}

export type ArchiveManifest = Readonly<{
    schemaVersion: 'analysis-order-audit-archive-manifest-v1';
    mode: 'dry-run';
    reversible: true;
    destructiveOperations: 'refused';
    /** Retention is unknown until an external archive manifest is verified. */
    retention: string | null;
    selectedCount: number;
    aggregateChecksum: string | null;
    parityStatus: 'ready' | 'mismatch' | 'blocked';
    restore: Readonly<{
        status: 'not_run' | 'verified' | 'mismatch' | 'blocked';
        verified: boolean;
        mismatchPaths: readonly string[];
    }>;
}>;

export function createArchiveManifest(input: {
    selectedCount: number;
    aggregateChecksum: string | null;
    parityStatus: 'ready' | 'mismatch' | 'blocked';
}): ArchiveManifest {
    if (!Number.isSafeInteger(input.selectedCount) || input.selectedCount < 0) {
        throw new Error('ANALYSIS_ORDER_AUDIT_ARCHIVE_COUNT_INVALID');
    }
    if (input.parityStatus === 'ready' && input.selectedCount === 0) {
        throw new Error('ANALYSIS_ORDER_AUDIT_ARCHIVE_PARITY_EMPTY');
    }
    if (input.aggregateChecksum !== null && !HASH_PATTERN.test(input.aggregateChecksum)) {
        throw new Error('ANALYSIS_ORDER_AUDIT_ARCHIVE_CHECKSUM_INVALID');
    }
    const manifest: ArchiveManifest = {
        schemaVersion: 'analysis-order-audit-archive-manifest-v1',
        mode: 'dry-run',
        reversible: true,
        destructiveOperations: 'refused',
        retention: null,
        selectedCount: input.selectedCount,
        aggregateChecksum: input.aggregateChecksum,
        parityStatus: input.parityStatus,
        restore: {
            status: 'not_run',
            verified: false,
            mismatchPaths: [],
        },
    };
    assertPiiSafeConsolidationOutput(manifest);
    return manifest;
}

export function verifyArchiveRestore(
    manifest: ArchiveManifest,
    restored: { observedCount: number; observedChecksum: string | null },
): ArchiveManifest['restore'] {
    const mismatchPaths: string[] = [];
    if (manifest.parityStatus !== 'ready') mismatchPaths.push('parity.not-ready');
    if (restored.observedCount !== manifest.selectedCount) mismatchPaths.push('archive.count');
    if (restored.observedChecksum !== manifest.aggregateChecksum) {
        mismatchPaths.push('archive.checksum');
    }
    const status = mismatchPaths.includes('parity.not-ready')
        ? 'blocked'
        : mismatchPaths.length > 0 ? 'mismatch' : 'verified';
    const result = {
        status,
        verified: status === 'verified',
        mismatchPaths,
    } as ArchiveManifest['restore'];
    assertPiiSafeConsolidationOutput(result);
    return result;
}

export type OrderAuditParityAggregate = Readonly<{
    schemaVersion: 'analysis-order-audit-consolidation-v1';
    mode: 'parity' | 'shadow-read';
    selectedCount: number;
    realCompletedCount: number;
    parityPassedCount: number;
    blockedCount: number;
    mismatchCount: number;
    aggregateChecksum: string | null;
    reports: readonly OrderAuditParityReport[];
    readiness: ConsolidationReadiness;
    archive: ArchiveManifest;
}>;

export function buildOrderAuditParityAggregate(
    reports: readonly OrderAuditParityReport[],
    mode: 'parity' | 'shadow-read' = 'parity',
): OrderAuditParityAggregate {
    const realCompletedCount = reports.filter(
        report => report.request.completed
            && report.request.productionOrder
            && report.bundle.present
            && report.recovery.present
            && report.recovery.completed,
    ).length;
    const parityPassedCount = reports.filter(report => report.parityPassed).length;
    const blockedCount = reports.filter(report => report.status === 'blocked').length;
    const mismatchCount = reports.filter(report => report.status === 'mismatch').length;
    const aggregateChecksum = reports.length === 0
        ? null
        : stableChecksum(reports.map(report => ({
            status: report.status,
            parityPassed: report.parityPassed,
            bundle: report.bundle,
            recovery: report.recovery,
            sections: report.sections,
            mismatchPaths: report.mismatchPaths,
        })));
    const readiness = evaluateConsolidationReadiness({
        genuineCompletedBundleCount: realCompletedCount,
        perOrderParityCount: parityPassedCount,
        aggregateChecksumsMatch: realCompletedCount > 0
            && mismatchCount === 0
            && blockedCount === 0,
        archiveManifestVerified: false,
        restoreDrillVerified: false,
        rollbackEvidenceVerified: false,
        dependencyInventoryComplete: false,
        separateApprovalGranted: false,
        observationWindowClosed: false,
        publicTableCount: 0,
        canonicalSetMatch: false,
        catalogDependencyClean: false,
        paymentPendingDispositionRecorded: false,
        noActivationOrCanary: false,
        archiveRestoreChecksumMatch: false,
    });
    const archiveParityReady = reports.length > 0
        && realCompletedCount > 0
        && parityPassedCount === reports.length
        && blockedCount === 0
        && mismatchCount === 0;
    const archive = createArchiveManifest({
        selectedCount: reports.length,
        aggregateChecksum,
        parityStatus: archiveParityReady
            ? 'ready'
            : mismatchCount > 0 ? 'mismatch' : 'blocked',
    });
    const aggregate: OrderAuditParityAggregate = {
        schemaVersion: 'analysis-order-audit-consolidation-v1',
        mode,
        selectedCount: reports.length,
        realCompletedCount,
        parityPassedCount,
        blockedCount,
        mismatchCount,
        aggregateChecksum,
        reports,
        readiness,
        archive,
    };
    assertPiiSafeConsolidationOutput(aggregate);
    return aggregate;
}

export interface OrderAuditParityRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export async function readOrderAuditParitySnapshot(
    client: OrderAuditParityRpcClient,
    requestId: string,
): Promise<OrderAuditParitySnapshot> {
    if (!UUID_PATTERN.test(requestId)) {
        throw new Error('ANALYSIS_ORDER_AUDIT_PARITY_REQUEST_INVALID');
    }
    const { data, error } = await client.rpc('read_analysis_order_audit_parity_snapshot', {
        p_request_id: requestId,
    });
    if (error) throw new Error('ANALYSIS_ORDER_AUDIT_PARITY_READ_FAILED');
    if (data === null) return emptyParitySnapshot();
    const parsed = orderAuditParitySnapshotSchema.safeParse(data);
    if (!parsed.success) throw new Error('ANALYSIS_ORDER_AUDIT_PARITY_PAYLOAD_INVALID');
    assertPiiSafeConsolidationOutput(parsed.data);
    return parsed.data;
}
