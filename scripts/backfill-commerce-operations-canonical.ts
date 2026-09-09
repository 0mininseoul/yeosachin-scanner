import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED =
    'PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED';

export type ProviderNoSaleEvidence = Readonly<{
    disposition: 'no_sale';
    checkedAt: string;
}>;

export type PaymentDisposition =
    | { status: 'blocked'; code: typeof PAYMENT_PENDING_PROVIDER_EVIDENCE_REQUIRED }
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
}

type ReadBatch = (
    limit: number,
    cursor: string | null,
) => Promise<readonly LegacyBackfillRecord[]>;

export interface CommerceCanonicalBackfillOptions {
    limit?: number;
    cursor?: string | null;
    reportOnly: boolean;
    readBatch?: ReadBatch;
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

function hashBatch(records: readonly LegacyBackfillRecord[]): Record<BackfillFamily, string> {
    const checksums = emptyChecksums();
    for (const family of families) {
        const digest = createHash('sha256');
        for (const record of records
            .filter(candidate => candidate.family === family)
            .sort((left, right) => left.key.localeCompare(right.key))) {
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
}

function familyCounts(records: readonly LegacyBackfillRecord[]): Record<BackfillFamily, number> {
    const counts = Object.fromEntries(families.map(family => [family, 0])) as Record<BackfillFamily, number>;
    for (const record of records) counts[record.family] += 1;
    return counts;
}

export function compareCanonicalParity(
    sourceRecords: readonly LegacyBackfillRecord[],
    canonicalRecords: readonly LegacyBackfillRecord[],
): CanonicalParityReport {
    const sourceChecksums = hashBatch(sourceRecords);
    const canonicalChecksums = hashBatch(canonicalRecords);
    const mismatchedFamilies = families.filter(family =>
        sourceChecksums[family] !== canonicalChecksums[family]
        || familyCounts(sourceRecords)[family] !== familyCounts(canonicalRecords)[family]
    );
    return {
        status: mismatchedFamilies.length === 0 ? 'match' : 'mismatch',
        mismatchedFamilies,
        sourceCounts: familyCounts(sourceRecords),
        canonicalCounts: familyCounts(canonicalRecords),
        sourceChecksums,
        canonicalChecksums,
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

function blockedReport(
    limit: number,
    reason: string,
): CommerceCanonicalBackfillReport {
    return {
        status: 'blocked',
        mode: 'report_only',
        processed: 0,
        batchSize: limit,
        nextCursorHash: null,
        unknownEvidenceCount: 0,
        blockedReasons: [reason],
        familyChecksums: emptyChecksums(),
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

    const records = (await options.readBatch(limit, options.cursor ?? null)).slice(0, limit);
    const blockedReasons = new Set<string>();
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
