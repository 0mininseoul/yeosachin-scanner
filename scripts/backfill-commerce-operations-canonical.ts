import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED =
    'PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED';
export const PAYMENT_PENDING_PROVIDER_EVIDENCE_INVALID =
    'PAYMENT_PENDING_PROVIDER_EVIDENCE_INVALID';

export type ProviderNoSaleEvidence = Readonly<{
    disposition: 'no_sale';
    checkedAt: string;
}>;

export type PaymentDisposition =
    | {
        status: 'blocked';
        code:
            | typeof PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED
            | typeof PAYMENT_PENDING_PROVIDER_EVIDENCE_INVALID;
    }
    | { status: 'eligible_for_separate_reconciliation' }
    | { status: 'unchanged' };

export function derivePaymentDisposition(input: {
    orderStatus: string;
    providerEvidence: ProviderNoSaleEvidence | null;
}): PaymentDisposition {
    if (input.orderStatus !== 'payment_pending') {
        return { status: 'unchanged' };
    }
    if (input.providerEvidence === null) {
        return {
            status: 'blocked',
            code: PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED,
        };
    }
    const checkedAtValue = input.providerEvidence.checkedAt;
    const checkedAt = typeof checkedAtValue === 'string' ? new Date(checkedAtValue) : null;
    if (
        input.providerEvidence.disposition !== 'no_sale'
        || !checkedAt
        || Number.isNaN(checkedAt.getTime())
        || checkedAtValue.trim() === ''
    ) {
        return {
            status: 'blocked',
            code: PAYMENT_PENDING_PROVIDER_EVIDENCE_INVALID,
        };
    }
    return { status: 'eligible_for_separate_reconciliation' };
}

export type BackfillFamily =
    | 'payment'
    | 'fulfillment'
    | 'notification'
    | 'account'
    | 'config'
    | 'lease'
    | 'maintenance';

export const LEGACY_COMMERCE_OPERATION_SOURCES = [
    'earlybird_webhook_events',
    'earlybird_fulfillments',
    'earlybird_payment_discord_outbox',
    'kakao_signup_discord_outbox',
    'sentry_discord_alert_outbox',
    'account_classification_audit',
    'account_paid_evidence',
    'account_deletion_jobs',
    'account_ledger_rollout_state',
    'analysis_v2_recovery_provider_run_adoptions',
    'analysis_provider_admission_leases',
    'analysis_v2_gemini_leases',
] as const;

export type LegacyBackfillRecord = Readonly<{
    family: BackfillFamily;
    key: string;
    content: string;
    /** Field values are compared in memory and only mismatch field names leave the process. */
    fields?: Readonly<Record<string, unknown>>;
    orderStatus?: string;
    providerEvidence?: ProviderNoSaleEvidence | null;
}>;

export interface CommerceCanonicalBackfillReport {
    status: 'complete' | 'blocked';
    mode: 'report_only';
    processed: number;
    batchSize: number;
    nextCursorHash: string | null;
    unknownEvidenceCount: number;
    blockedReasons: readonly string[];
    familyChecksums: Readonly<Record<BackfillFamily, string>>;
    canonicalFamilyChecksums: Readonly<Record<BackfillFamily, string>>;
    parity: CanonicalParityReport;
}

export type BackfillReadResult =
    | readonly LegacyBackfillRecord[]
    | Readonly<{
        records: readonly LegacyBackfillRecord[];
        truncated?: boolean;
    }>;

type ReadBatch = (
    limit: number,
    cursor: string | null,
) => Promise<BackfillReadResult>;

export interface CommerceCanonicalBackfillOptions {
    limit?: number;
    cursor?: string | null;
    reportOnly: boolean;
    readBatch?: ReadBatch;
    readCanonicalBatch?: ReadBatch;
    destructive?: boolean;
    activate?: boolean;
    cutover?: boolean;
}

const families: readonly BackfillFamily[] = [
    'payment',
    'fulfillment',
    'notification',
    'account',
    'config',
    'lease',
    'maintenance',
];

function emptyChecksums(): Record<BackfillFamily, string> {
    return Object.fromEntries(
        families.map(family => [family, createHash('sha256').update(family).digest('hex')]),
    ) as Record<BackfillFamily, string>;
}

const PARITY_LIMIT = 100;

function hashBatch(records: readonly LegacyBackfillRecord[]): Record<BackfillFamily, string> {
    const checksums = emptyChecksums();
    for (const family of families) {
        const digest = createHash('sha256');
        for (const record of records
            .filter(candidate => candidate.family === family)
            .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
            .slice(0, PARITY_LIMIT)) {
            digest.update(`${record.key.length}:${record.key}\n${record.content.length}:${record.content}\n`);
        }
        checksums[family] = digest.digest('hex');
    }
    return checksums;
}

export interface CanonicalParityReport {
    status: 'match' | 'mismatch';
    mismatchedFamilies: readonly BackfillFamily[];
    sourceCounts: Readonly<Record<BackfillFamily, number>>;
    canonicalCounts: Readonly<Record<BackfillFamily, number>>;
    sourceChecksums: Readonly<Record<BackfillFamily, string>>;
    canonicalChecksums: Readonly<Record<BackfillFamily, string>>;
    comparedCounts: Readonly<Record<BackfillFamily, number>>;
    fieldMismatches: Readonly<Record<BackfillFamily, readonly string[]>>;
    truncatedFamilies: readonly BackfillFamily[];
}

function familyCounts(records: readonly LegacyBackfillRecord[]): Record<BackfillFamily, number> {
    const counts = Object.fromEntries(families.map(family => [family, 0])) as Record<BackfillFamily, number>;
    for (const record of records) counts[record.family] += 1;
    return counts;
}

function recordFields(record: LegacyBackfillRecord): Readonly<Record<string, unknown>> {
    return record.fields ?? { content: record.content };
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
                .map(([key, child]) => [key, stableValue(child)]),
        );
    }
    return value;
}

function stableFieldValue(value: unknown): string {
    return JSON.stringify(stableValue(value));
}

function fieldParity(
    sourceRecords: readonly LegacyBackfillRecord[],
    canonicalRecords: readonly LegacyBackfillRecord[],
): {
    compared: number;
    mismatches: string[];
} {
    const sourceByKey = new Map(sourceRecords.map(record => [record.key, record]));
    const canonicalByKey = new Map(canonicalRecords.map(record => [record.key, record]));
    const fields = new Set<string>();
    let compared = 0;
    if (sourceByKey.size !== sourceRecords.length || canonicalByKey.size !== canonicalRecords.length) {
        fields.add('duplicate_key');
    }
    for (const [key, source] of sourceByKey) {
        const canonical = canonicalByKey.get(key);
        if (!canonical) {
            fields.add('missing_record');
            continue;
        }
        compared += 1;
        const sourceFields = recordFields(source);
        const canonicalFields = recordFields(canonical);
        const allFields = new Set([
            ...Object.keys(sourceFields),
            ...Object.keys(canonicalFields),
        ]);
        for (const field of allFields) {
            const sourceValue = stableFieldValue(sourceFields[field]);
            const canonicalValue = stableFieldValue(canonicalFields[field]);
            if (sourceValue !== canonicalValue) fields.add(field);
        }
    }
    for (const key of canonicalByKey.keys()) {
        if (!sourceByKey.has(key)) fields.add('missing_record');
    }
    if (sourceByKey.size !== canonicalByKey.size) fields.add('record_count');
    return {
        compared,
        mismatches: [...fields].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    };
}

export function compareCanonicalParity(
    sourceRecords: readonly LegacyBackfillRecord[],
    canonicalRecords: readonly LegacyBackfillRecord[],
    options: Readonly<{
        sourceTruncated?: boolean;
        canonicalTruncated?: boolean;
    }> = {},
): CanonicalParityReport {
    const sourceChecksums = hashBatch(sourceRecords);
    const canonicalChecksums = hashBatch(canonicalRecords);
    const sourceCounts = familyCounts(sourceRecords);
    const canonicalCounts = familyCounts(canonicalRecords);
    const comparedCounts = Object.fromEntries(families.map(family => [family, 0])) as Record<BackfillFamily, number>;
    const fieldMismatches = Object.fromEntries(families.map(family => [family, []])) as unknown as Record<BackfillFamily, readonly string[]>;
    const truncatedFamilies: BackfillFamily[] = [];
    for (const family of families) {
        const sourceFamily = sourceRecords
            .filter(record => record.family === family)
            .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
        const canonicalFamily = canonicalRecords
            .filter(record => record.family === family)
            .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
        const source = sourceFamily.slice(0, PARITY_LIMIT);
        const canonical = canonicalFamily.slice(0, PARITY_LIMIT);
        const parity = fieldParity(source, canonical);
        comparedCounts[family] = parity.compared;
        const mismatches = new Set(parity.mismatches);
        if (
            sourceFamily.length > PARITY_LIMIT
            || canonicalFamily.length > PARITY_LIMIT
            || (options.sourceTruncated && sourceFamily.length > 0)
            || (options.canonicalTruncated && canonicalFamily.length > 0)
        ) truncatedFamilies.push(family);
        if (
            sourceFamily.length > PARITY_LIMIT
            || canonicalFamily.length > PARITY_LIMIT
            || options.sourceTruncated
            || options.canonicalTruncated
        ) {
            // The reader metadata applies to the whole bounded batch. Mark
            // only families represented in the batch so an empty family does
            // not create a synthetic parity mismatch.
            if (sourceFamily.length > 0 || canonicalFamily.length > 0) {
                mismatches.add('truncated');
            } else if (options.sourceTruncated || options.canonicalTruncated) {
                // A reader can report a truncated empty page when the cursor
                // moved past the visible batch. Keep this standalone parity
                // helper fail-closed even when no family row survived the
                // bounded page.
                mismatches.add('truncated');
            }
        }
        fieldMismatches[family] = [...mismatches].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    }
    const mismatchedFamilies = families.filter(family =>
        sourceChecksums[family] !== canonicalChecksums[family]
        || sourceCounts[family] !== canonicalCounts[family]
        || fieldMismatches[family].length > 0
    );
    return {
        status: mismatchedFamilies.length === 0 ? 'match' : 'mismatch',
        mismatchedFamilies,
        sourceCounts,
        canonicalCounts,
        sourceChecksums,
        canonicalChecksums,
        comparedCounts,
        fieldMismatches,
        truncatedFamilies,
    };
}

function cursorHash(records: readonly LegacyBackfillRecord[]): string | null {
    const last = records.at(-1);
    return last
        ? createHash('sha256').update(last.key, 'utf8').digest('hex')
        : null;
}

function boundedLimit(value: number | undefined): number {
    if (value === undefined) return 100;
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error('LIMIT_INVALID');
    }
    return Math.min(value, 100);
}

function unpackReadResult(result: BackfillReadResult): {
    records: readonly LegacyBackfillRecord[];
    truncated: boolean;
} {
    if (Array.isArray(result)) {
        return { records: result as readonly LegacyBackfillRecord[], truncated: false };
    }
    const objectResult = result as {
        records?: readonly LegacyBackfillRecord[];
        truncated?: boolean;
    } | null;
    if (!objectResult || !Array.isArray(objectResult.records)) {
        throw new Error('BACKFILL_READ_RESULT_INVALID');
    }
    return {
        records: objectResult.records,
        truncated: objectResult.truncated === true,
    };
}

function boundedRead(
    result: BackfillReadResult,
    limit: number,
): { records: readonly LegacyBackfillRecord[]; truncated: boolean } {
    const unpacked = unpackReadResult(result);
    if (unpacked.records.length > limit) {
        return {
            records: unpacked.records.slice(0, limit),
            truncated: true,
        };
    }
    return unpacked;
}

function blockedReport(
    limit: number,
    reason: string,
): CommerceCanonicalBackfillReport {
    const parity = compareCanonicalParity([], []);
    return {
        status: 'blocked',
        mode: 'report_only',
        processed: 0,
        batchSize: limit,
        nextCursorHash: null,
        unknownEvidenceCount: 0,
        blockedReasons: [reason],
        familyChecksums: emptyChecksums(),
        canonicalFamilyChecksums: emptyChecksums(),
        parity,
    };
}

export async function backfillCommerceOperationsCanonical(
    options: CommerceCanonicalBackfillOptions,
): Promise<CommerceCanonicalBackfillReport> {
    const limit = boundedLimit(options.limit);
    if (options.reportOnly !== true) {
        throw new Error('REPORT_ONLY_REQUIRED');
    }
    if (options.destructive === true || options.activate === true || options.cutover === true) {
        throw new Error('DESTRUCTIVE_OPTION_FORBIDDEN');
    }
    if (!options.readBatch) {
        return blockedReport(limit, 'SOURCE_NOT_CONFIGURED');
    }

    let sourceRead: { records: readonly LegacyBackfillRecord[]; truncated: boolean };
    try {
        sourceRead = boundedRead(
            // Probe one record past the bounded batch. A reader that returns
            // only `limit` rows cannot distinguish a complete page from a
            // truncated tail, so the sentinel is required for fail-closed
            // parity.
            await options.readBatch(Math.min(limit + 1, PARITY_LIMIT + 1), options.cursor ?? null),
            limit,
        );
    } catch {
        return blockedReport(limit, 'SOURCE_READ_FAILED');
    }
    const records = sourceRead.records;
    let canonicalRead: { records: readonly LegacyBackfillRecord[]; truncated: boolean };
    const blockedReasons = new Set<string>();
    if (!options.readCanonicalBatch) {
        canonicalRead = { records: [], truncated: false };
        blockedReasons.add('CANONICAL_SOURCE_NOT_CONFIGURED');
    } else {
        try {
            canonicalRead = boundedRead(
                await options.readCanonicalBatch(Math.min(limit + 1, PARITY_LIMIT + 1), options.cursor ?? null),
                limit,
            );
        } catch {
            canonicalRead = { records: [], truncated: false };
            blockedReasons.add('CANONICAL_READ_FAILED');
        }
    }
    const parity = compareCanonicalParity(
        records,
        canonicalRead.records,
        {
            sourceTruncated: sourceRead.truncated,
            canonicalTruncated: canonicalRead.truncated,
        },
    );
    if (parity.status !== 'match') blockedReasons.add('CANONICAL_PARITY_MISMATCH');
    if (sourceRead.truncated) blockedReasons.add('SOURCE_TAIL_TRUNCATED');
    if (canonicalRead.truncated) blockedReasons.add('CANONICAL_TAIL_TRUNCATED');
    let unknownEvidenceCount = 0;
    for (const record of records) {
        if (record.family !== 'payment' || record.orderStatus === undefined) continue;
        const disposition = derivePaymentDisposition({
            orderStatus: record.orderStatus,
            providerEvidence: record.providerEvidence ?? null,
        });
        if (disposition.status === 'blocked') {
            unknownEvidenceCount += 1;
            blockedReasons.add(disposition.code);
        }
    }

    return {
        status: blockedReasons.size > 0 ? 'blocked' : 'complete',
        mode: 'report_only',
        processed: records.length,
        batchSize: limit,
        nextCursorHash: cursorHash(records),
        unknownEvidenceCount,
        blockedReasons: [...blockedReasons].sort(),
        familyChecksums: hashBatch(records),
        canonicalFamilyChecksums: hashBatch(canonicalRead.records),
        parity,
    };
}

function parseCliArguments(argv: readonly string[]): {
    limit: number;
    reportOnly: boolean;
} {
    let limit = 100;
    let reportOnly = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--report-only') {
            reportOnly = true;
            continue;
        }
        if (argument === '--limit') {
            const value = Number(argv[index + 1]);
            index += 1;
            limit = boundedLimit(value);
            continue;
        }
        if (argument.startsWith('--limit=')) {
            limit = boundedLimit(Number(argument.slice('--limit='.length)));
            continue;
        }
        if (argument === '--apply' || argument === '--delete' || argument === '--cutover' || argument === '--activate') {
            throw new Error('DESTRUCTIVE_OPTION_FORBIDDEN');
        }
        throw new Error('UNKNOWN_OPTION');
    }
    return { limit, reportOnly };
}

export async function runBackfillCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const { limit, reportOnly } = parseCliArguments(argv);
    const report = await backfillCommerceOperationsCanonical({
        limit,
        reportOnly,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
}

const invokedPath = process.argv[1]
    ? pathToFileURL(process.argv[1]).href
    : null;
if (invokedPath === import.meta.url) {
    runBackfillCli().catch(error => {
        const message = error instanceof Error ? error.message : 'BACKFILL_FAILED';
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
