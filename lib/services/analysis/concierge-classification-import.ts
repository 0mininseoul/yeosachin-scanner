import { createHash } from 'node:crypto';

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;
const INSTAGRAM_URL_PATTERN = /^https:\/\/(?:www\.)?instagram\.com\/([a-z0-9._]{1,30})\/?$/i;
const CONFIDENCE_EVIDENCE_PATTERN = /^confidence=(?:unavailable|low|medium|high);evidence=[a-z0-9_]{1,64}$/;
export const CONCIERGE_ZERO_POST_PROVENANCE_MARKER = 'zero-post-complete-v1';

export type ConciergePartition = 'public' | 'private' | 'unresolved';
export type ConciergeClassification = 'male' | 'female' | 'unknown';
export type ConciergeConfidence = 'low' | 'medium' | 'high';
export type ConciergeEvidenceStatus =
    | 'collected'
    | 'not_collected'
    | 'failed'
    | 'not_applicable';

export interface ConciergeClassificationPass {
    status: ConciergeEvidenceStatus;
    fullNamePresent: boolean | null;
    profilePicPresent: boolean | null;
    feedDeclared: number | null;
    feedCollected: number | null;
    completeMedia: boolean | null;
    evidenceHash: string | null;
    evidenceMarker?: typeof CONCIERGE_ZERO_POST_PROVENANCE_MARKER | null;
}

export interface ConciergeEvidenceCoverage {
    declared: number;
    collected: number;
    selected: number;
    complete: boolean;
    basisPoints: number;
    hash: string;
}

export interface ConciergeManualOverrideProvenance {
    operatorRefHash: string;
    csvImportHash: string;
    rowHash: string;
    reasonCode: string;
    appliedAt: string;
    originalAiClassification: ConciergeClassification;
    overrideHash: string;
}

export interface ConciergeClassificationRecord {
    candidateId: string;
    instagramId: string;
    mutualOrdinal: number;
    partition: ConciergePartition;
    profileFetchStatus: 'success' | 'unavailable' | 'failed';
    firstPass: ConciergeClassificationPass;
    secondPass: ConciergeClassificationPass;
    originalAiClassification: ConciergeClassification | null;
    effectiveClassification: ConciergeClassification | null;
    confidence: ConciergeConfidence | null;
    evidenceCoverage: ConciergeEvidenceCoverage | null;
    classifier: string | null;
    modelName: string | null;
    promptVersion: string | null;
    schemaVersion: string | null;
    classificationOperationKey: string | null;
    classificationResultHash: string | null;
    classificationSource: 'ai' | 'manual' | 'not_applicable';
    manualOverride: ConciergeManualOverrideProvenance | null;
    /** Exact immutable fields retained from the operator review source when available. */
    sourceSnapshot?: Readonly<{
        instagramUrl: string;
        originalAiClassification: ConciergeClassification;
        confidenceEvidence: string;
        operatorNote: string;
    }>;
}

export interface ConciergeClassificationLedger {
    revision: 1;
    relationshipResultHash: string;
    partitionHash: string;
    mutualCount: number;
    hydratedPublicCount: number;
    hydratedPrivateCount: number;
    unresolvedCount: number;
    records: readonly ConciergeClassificationRecord[];
}

export interface ConciergeManualOverrideInput {
    instagramId: string;
    effectiveClassification: ConciergeClassification;
    operatorRefHash: string;
    csvImportHash: string;
    sourceRowIdentifier: string;
    appliedAt: string;
    reasonCode: string;
    rowHash: string;
    /** Immutable operator snapshot fields, when importing the reviewed six-column CSV. */
    sourceSnapshot?: Readonly<{
        instagramUrl: string;
        originalAiClassification: ConciergeClassification;
        confidenceEvidence: string;
        operatorNote: string;
    }>;
}

export interface ConciergeManualClassificationImport {
    orderId: string;
    requestId: string;
    mutualManifestHash: string;
    csvImportHash: string;
    operatorIdHash: string;
    importedAt: string;
    /** Exact immutable CSV content from which csvImportHash and rows were derived. */
    csvContent: string;
    rows: readonly ConciergeManualOverrideInput[];
}

function fail(code: string): never {
    throw new Error(code);
}

/** A locale-independent comparator for persisted ledger keys. */
function compareStable(left: string, right: string): number {
    const length = Math.min(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
        const leftCode = left.charCodeAt(index);
        const rightCode = right.charCodeAt(index);
        if (leftCode !== rightCode) return leftCode - rightCode;
    }
    return left.length - right.length;
}

function stableObject(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableObject);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => compareStable(left, right))
            .map(([key, entry]) => [key, stableObject(entry)]),
    );
}

function canonicalJson(value: unknown): string {
    return JSON.stringify(stableObject(value));
}

function hash(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function hashCsvContent(csv: string): string {
    return createHash('sha256').update(csv, 'utf8').digest('hex');
}

export function createConciergeZeroPostEvidenceHash(): string {
    return hash({
        schema: 'concierge-zero-post-provenance-v1',
        marker: CONCIERGE_ZERO_POST_PROVENANCE_MARKER,
        feedDeclared: 0,
        feedCollected: 0,
        completeMedia: true,
    });
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    if (Array.isArray(value)) {
        for (const entry of value) deepFreeze(entry);
    } else {
        for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
    }
    return Object.freeze(value);
}

function normalizeUsername(value: string): string {
    const username = value.trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_PATTERN.test(username)) fail('CONCIERGE_CLASSIFICATION_IMPORT_INVALID_USERNAME');
    return username;
}

function requireHash(value: string, code: string): string {
    if (!HASH_PATTERN.test(value)) fail(code);
    return value;
}

function validatePass(pass: ConciergeClassificationPass, code: string): void {
    if (!['collected', 'not_collected', 'failed', 'not_applicable'].includes(pass.status)) {
        fail(code);
    }
    for (const count of [pass.feedDeclared, pass.feedCollected]) {
        if (count !== null && (!Number.isInteger(count) || count < 0)) fail(code);
    }
    if (pass.feedDeclared !== null && pass.feedCollected !== null
        && pass.feedCollected > pass.feedDeclared) {
        fail(code);
    }
    if (pass.status === 'collected' && typeof pass.completeMedia !== 'boolean') fail(code);
    if (pass.status !== 'collected' && pass.completeMedia === true) fail(code);
    if (pass.evidenceHash !== null) requireHash(pass.evidenceHash, code);
    if (pass.status === 'collected') {
        if (pass.feedDeclared === null || pass.feedCollected === null || pass.evidenceHash === null) {
            fail(code);
        }
        const isZeroPostComplete = pass.feedDeclared === 0
            && pass.feedCollected === 0
            && pass.completeMedia === true;
        if (isZeroPostComplete) {
            if (pass.evidenceMarker !== CONCIERGE_ZERO_POST_PROVENANCE_MARKER
                || pass.evidenceHash !== createConciergeZeroPostEvidenceHash()) {
                fail(code);
            }
        } else if (pass.evidenceMarker !== undefined && pass.evidenceMarker !== null) {
            fail(code);
        }
    } else if (pass.evidenceMarker !== undefined && pass.evidenceMarker !== null) {
        fail(code);
    }
}

function validateCoverage(coverage: ConciergeEvidenceCoverage, code: string): void {
    if (![coverage.declared, coverage.collected, coverage.selected].every(
        value => Number.isInteger(value) && value >= 0,
    ) || coverage.collected > coverage.declared
        || coverage.selected > coverage.collected
        || !Number.isInteger(coverage.basisPoints)
        || coverage.basisPoints < 0 || coverage.basisPoints > 10_000
        || typeof coverage.complete !== 'boolean') {
        fail(code);
    }
    requireHash(coverage.hash, code);
}

function parseCsvRows(csv: string): string[][] {
    if (!csv || csv.charCodeAt(0) === 0xfeff || /\r(?!\n)/.test(csv)) {
        if (csv.charCodeAt(0) === 0xfeff) fail('CONCIERGE_CLASSIFICATION_IMPORT_ENCODING');
        fail('CONCIERGE_CLASSIFICATION_IMPORT_CSV_FORMAT');
    }
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    let fieldStarted = false;
    let afterQuote = false;
    const finishField = () => {
        row.push(field);
        field = '';
        fieldStarted = false;
        afterQuote = false;
    };
    const finishRow = () => {
        finishField();
        rows.push(row);
        row = [];
    };
    for (let index = 0; index < csv.length; index += 1) {
        const char = csv[index]!;
        if (quoted) {
            if (char === '"' && csv[index + 1] === '"') {
                field += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
                afterQuote = true;
            } else {
                field += char;
            }
        } else if (afterQuote) {
            if (char === ',') {
                finishField();
            } else if (char === '\n') {
                finishRow();
            } else if (char === '\r' && csv[index + 1] === '\n') {
                index += 1;
                finishRow();
            } else {
                fail('CONCIERGE_CLASSIFICATION_IMPORT_CSV_FORMAT');
            }
        } else if (char === '"' && field.length === 0) {
            quoted = true;
            fieldStarted = true;
        } else if (char === '"') {
            fail('CONCIERGE_CLASSIFICATION_IMPORT_CSV_FORMAT');
        } else if (char === ',') {
            finishField();
        } else if (char === '\n') {
            finishRow();
        } else if (char === '\r' && csv[index + 1] === '\n') {
            index += 1;
            finishRow();
        } else if (char === '\r') {
            fail('CONCIERGE_CLASSIFICATION_IMPORT_CSV_FORMAT');
        } else {
            field += char;
            fieldStarted = true;
        }
    }
    if (quoted) fail('CONCIERGE_CLASSIFICATION_IMPORT_CSV_FORMAT');
    if (field.length > 0 || fieldStarted || row.length > 0 || afterQuote) {
        finishField();
        rows.push(row);
    }
    if (rows.length < 1 || rows.some(item => item.some(value => value.includes('\0')))) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_CSV_FORMAT');
    }
    return rows;
}

function classification(value: string): ConciergeClassification {
    const normalized = value.trim().toLowerCase();
    if (normalized !== 'male' && normalized !== 'female' && normalized !== 'unknown') {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_INVALID_ENUM');
    }
    return normalized;
}

function parseSixColumnRow(
    values: readonly string[],
    csvImportHash: string,
    operatorIdHash: string,
    importedAt: string,
    rowNumber: number,
): ConciergeManualOverrideInput {
    const instagramId = normalizeUsername(values[0] ?? '');
    const instagramUrl = values[1] ?? '';
    const originalAiClassification = classification(values[2] ?? '');
    const confidenceEvidence = values[3] ?? '';
    const urlMatch = INSTAGRAM_URL_PATTERN.exec(instagramUrl);
    if (!urlMatch || normalizeUsername(urlMatch[1] ?? '') !== instagramId
        || instagramUrl.length > 2_000 || /[\r\n\0]/.test(instagramUrl)) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_INVALID_IMMUTABLE_FIELD');
    }
    if (!CONFIDENCE_EVIDENCE_PATTERN.test(confidenceEvidence)
        || confidenceEvidence.length > 200 || /[\r\n\0]/.test(confidenceEvidence)) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_INVALID_IMMUTABLE_FIELD');
    }
    const effectiveClassification = classification(values[4] ?? '');
    const operatorNote = values[5] ?? '';
    if (operatorNote.length > 2_000 || /[\r\n\0]/.test(operatorNote)) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_INVALID_IMMUTABLE_FIELD');
    }
    const reason = 'manual_review';
    const source = `snapshot-row:${rowNumber}`;
    const rowHash = hash({
        schema: 'concierge-manual-review-row-v1', rowNumber, instagramId,
        instagramUrl, originalAiClassification, confidenceEvidence,
        effectiveClassification, operatorNote,
    });
    return {
        instagramId, effectiveClassification, operatorRefHash: operatorIdHash,
        csvImportHash, sourceRowIdentifier: source, appliedAt: importedAt,
        reasonCode: reason, rowHash,
        sourceSnapshot: {
            instagramUrl,
            originalAiClassification,
            confidenceEvidence,
            operatorNote,
        },
    };
}

/** Parses only the exact reviewed six-column snapshot. */
export function parseConciergeClassificationCsv(
    csv: string,
    orderId: string,
    requestId: string,
    mutualManifestHash: string,
    operatorIdHash: string,
    importedAt: string,
): ConciergeManualClassificationImport {
    if (!orderId || !requestId) fail('CONCIERGE_CLASSIFICATION_IMPORT_SCOPE_INVALID');
    requireHash(mutualManifestHash, 'CONCIERGE_CLASSIFICATION_IMPORT_MANIFEST_INVALID');
    requireHash(operatorIdHash, 'CONCIERGE_CLASSIFICATION_IMPORT_OPERATOR_INVALID');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(importedAt) || Number.isNaN(Date.parse(importedAt))) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_TIMESTAMP_INVALID');
    }
    const rows = parseCsvRows(csv);
    const sixColumnHeader = [
        'username', 'instagram_url', 'ai_classification',
        'ai_confidence/evidence_status', 'manual_gender', 'operator_note',
    ];
    const header = rows[0]!;
    if (JSON.stringify(header) !== JSON.stringify(sixColumnHeader)) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_HEADERS_INVALID');
    }
    const csvImportHash = hashCsvContent(csv);
    const parsed = rows.slice(1).map((row, index) => {
        if (row.length !== header.length) fail('CONCIERGE_CLASSIFICATION_IMPORT_COLUMN_COUNT');
        return parseSixColumnRow(row, csvImportHash, operatorIdHash, importedAt, index + 1);
    });
    const usernames = new Set<string>();
    const sourceRows = new Set<string>();
    for (const row of parsed) {
        if (usernames.has(row.instagramId) || sourceRows.has(row.sourceRowIdentifier)) {
            fail('CONCIERGE_CLASSIFICATION_IMPORT_DUPLICATE');
        }
        usernames.add(row.instagramId);
        sourceRows.add(row.sourceRowIdentifier);
    }
    return deepFreeze({
        orderId, requestId, mutualManifestHash, csvImportHash,
        operatorIdHash, importedAt, csvContent: csv, rows: parsed,
    });
}

function validateRecord(record: ConciergeClassificationRecord): void {
    if (!USERNAME_PATTERN.test(record.instagramId)
        || !Number.isInteger(record.mutualOrdinal) || record.mutualOrdinal < 1) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_RECORD_INVALID');
    }
    if (record.partition === 'private') {
        if (record.originalAiClassification !== null
            || record.effectiveClassification !== null
            || record.confidence !== null
            || record.evidenceCoverage !== null
            || record.classifier !== null
            || record.modelName !== null
            || record.promptVersion !== null
            || record.schemaVersion !== null
            || record.classificationOperationKey !== null
            || record.classificationResultHash !== null
            || record.classificationSource !== 'not_applicable'
            || record.manualOverride !== null
            || record.sourceSnapshot !== undefined) {
            fail('CONCIERGE_CLASSIFICATION_LEDGER_PRIVATE_AI_DATA');
        }
        return;
    }
    validatePass(record.firstPass, 'CONCIERGE_CLASSIFICATION_LEDGER_FIRST_PASS_INVALID');
    validatePass(record.secondPass, 'CONCIERGE_CLASSIFICATION_LEDGER_SECOND_PASS_INVALID');
    if (record.firstPass.status === 'not_applicable'
        || record.secondPass.status === 'not_applicable') {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_SECOND_PASS_INVALID');
    }
    if ((record.originalAiClassification !== null
        && !['male', 'female', 'unknown'].includes(record.originalAiClassification))
        || (record.effectiveClassification !== null
            && !['male', 'female', 'unknown'].includes(record.effectiveClassification))) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_CLASSIFICATION_INVALID');
    }
    if (!['male', 'female', 'unknown'].includes(record.originalAiClassification ?? '')
        || !['male', 'female', 'unknown'].includes(record.effectiveClassification ?? '')
        || !record.effectiveClassification || !record.originalAiClassification
        || !record.confidence || !record.evidenceCoverage
        || !record.classifier || !record.modelName || !record.promptVersion
        || !record.schemaVersion || !record.classificationOperationKey
        || !record.classificationResultHash
        || !['ai', 'manual'].includes(record.classificationSource)) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_PUBLIC_AI_DATA');
    }
    requireHash(record.classificationResultHash, 'CONCIERGE_CLASSIFICATION_LEDGER_AI_PROVENANCE_INVALID');
    validateCoverage(record.evidenceCoverage, 'CONCIERGE_CLASSIFICATION_LEDGER_COVERAGE_INVALID');
    if (record.partition === 'unresolved' && record.effectiveClassification !== 'unknown') {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_UNRESOLVED_CLASSIFICATION');
    }
    if (record.partition === 'unresolved'
        && (record.originalAiClassification !== 'unknown'
            || record.effectiveClassification !== 'unknown'
            || record.classificationSource !== 'ai'
            || record.manualOverride !== null)) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_UNRESOLVED_MANUAL_OVERRIDE');
    }
    if (!record.sourceSnapshot) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_SOURCE_SNAPSHOT_REQUIRED');
    }
    const sourceUrl = INSTAGRAM_URL_PATTERN.exec(record.sourceSnapshot.instagramUrl);
    if (!sourceUrl || normalizeUsername(sourceUrl[1] ?? '') !== record.instagramId
        || record.sourceSnapshot.originalAiClassification !== record.originalAiClassification
        || !CONFIDENCE_EVIDENCE_PATTERN.test(record.sourceSnapshot.confidenceEvidence)
        || record.sourceSnapshot.instagramUrl.length > 2_000
        || record.sourceSnapshot.confidenceEvidence.length > 200
        || record.sourceSnapshot.operatorNote.length > 2_000
        || /[\r\n\0]/.test(record.sourceSnapshot.operatorNote)) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_SOURCE_SNAPSHOT_INVALID');
    }
    if (record.manualOverride) {
        requireHash(record.manualOverride.operatorRefHash, 'CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
        requireHash(record.manualOverride.csvImportHash, 'CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
        requireHash(record.manualOverride.rowHash, 'CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
        requireHash(record.manualOverride.overrideHash, 'CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
        if (record.classificationSource !== 'manual'
            || record.manualOverride.originalAiClassification !== record.originalAiClassification) {
            fail('CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
        }
    } else if (record.classificationSource === 'manual') {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
    }
    if (record.classificationSource === 'ai' && record.manualOverride !== null) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
    }
}

export function validateConciergeClassificationLedger(ledger: ConciergeClassificationLedger): void {
    if (ledger.revision !== 1 || !HASH_PATTERN.test(ledger.relationshipResultHash)
        || !HASH_PATTERN.test(ledger.partitionHash)
        || ledger.mutualCount !== ledger.hydratedPublicCount + ledger.hydratedPrivateCount + ledger.unresolvedCount
        || ledger.mutualCount < 0 || ledger.records.length !== ledger.mutualCount) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_SCOPE_INVALID');
    }
    const usernames = new Set<string>();
    const ordinals = new Set<number>();
    for (const record of ledger.records) {
        validateRecord(record);
        if (usernames.has(record.instagramId) || ordinals.has(record.mutualOrdinal)) {
            fail('CONCIERGE_CLASSIFICATION_LEDGER_DUPLICATE');
        }
        usernames.add(record.instagramId);
        ordinals.add(record.mutualOrdinal);
    }
    const counts = {
        public: ledger.records.filter(row => row.partition === 'public').length,
        private: ledger.records.filter(row => row.partition === 'private').length,
        unresolved: ledger.records.filter(row => row.partition === 'unresolved').length,
    };
    if (counts.public !== ledger.hydratedPublicCount
        || counts.private !== ledger.hydratedPrivateCount
        || counts.unresolved !== ledger.unresolvedCount) {
        fail('CONCIERGE_CLASSIFICATION_LEDGER_PARTITION_COUNT');
    }
}

export function createConciergeClassificationLedgerHash(ledger: ConciergeClassificationLedger): string {
    validateConciergeClassificationLedger(ledger);
    const canonical = {
        revision: ledger.revision,
        relationshipResultHash: ledger.relationshipResultHash,
        partitionHash: ledger.partitionHash,
        mutualCount: ledger.mutualCount,
        hydratedPublicCount: ledger.hydratedPublicCount,
        hydratedPrivateCount: ledger.hydratedPrivateCount,
        unresolvedCount: ledger.unresolvedCount,
        records: [...ledger.records]
            .sort((left, right) => left.mutualOrdinal - right.mutualOrdinal)
            .map(record => stableObject(record)),
    };
    return hash(canonical);
}

function overrideHash(row: ConciergeManualOverrideInput, original: ConciergeClassification): string {
    return hash({
        schema: 'concierge-manual-override-v1',
        csvImportHash: row.csvImportHash,
        rowHash: row.rowHash,
        originalAiClassification: original,
        effectiveClassification: row.effectiveClassification,
    });
}

function verifyExactImportProvenance(input: ConciergeManualClassificationImport): void {
    if (typeof input.csvContent !== 'string') {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_PROVENANCE_MISMATCH');
    }
    let parsed: ConciergeManualClassificationImport;
    try {
        parsed = parseConciergeClassificationCsv(
            input.csvContent,
            input.orderId,
            input.requestId,
            input.mutualManifestHash,
            input.operatorIdHash,
            input.importedAt,
        );
    } catch {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_PROVENANCE_MISMATCH');
    }
    if (input.csvImportHash !== parsed.csvImportHash
        || input.orderId !== parsed.orderId
        || input.requestId !== parsed.requestId
        || input.mutualManifestHash !== parsed.mutualManifestHash
        || input.operatorIdHash !== parsed.operatorIdHash
        || input.importedAt !== parsed.importedAt
        || canonicalJson(input.rows) !== canonicalJson(parsed.rows)) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_PROVENANCE_MISMATCH');
    }
}

export function applyConciergeManualClassificationImport(
    ledger: ConciergeClassificationLedger,
    input: ConciergeManualClassificationImport,
): ConciergeClassificationLedger {
    validateConciergeClassificationLedger(ledger);
    if (input.mutualManifestHash !== ledger.relationshipResultHash) {
        fail('CONCIERGE_CLASSIFICATION_IMPORT_MANIFEST_MISMATCH');
    }
    verifyExactImportProvenance(input);
    const byUsername = new Map(ledger.records.map(record => [record.instagramId, record]));
    const next = ledger.records.map(record => record);
    for (const row of input.rows) {
        const record = byUsername.get(row.instagramId);
        if (!record) fail('CONCIERGE_CLASSIFICATION_IMPORT_NON_MUTUAL');
        if (record.partition !== 'public' || record.originalAiClassification === null) {
            fail('CONCIERGE_CLASSIFICATION_IMPORT_PARTITION_REJECTED');
        }
        if (!row.sourceSnapshot) {
            fail('CONCIERGE_CLASSIFICATION_IMPORT_SOURCE_SNAPSHOT_REQUIRED');
        }
        if (!record.sourceSnapshot
            || row.sourceSnapshot.instagramUrl !== record.sourceSnapshot.instagramUrl
            || row.sourceSnapshot.originalAiClassification !== record.sourceSnapshot.originalAiClassification
            || row.sourceSnapshot.confidenceEvidence !== record.sourceSnapshot.confidenceEvidence
            || row.sourceSnapshot.operatorNote !== record.sourceSnapshot.operatorNote
            || row.sourceSnapshot.originalAiClassification !== record.originalAiClassification) {
            fail('CONCIERGE_CLASSIFICATION_IMPORT_IMMUTABLE_MISMATCH');
        }
        const expectedOverrideHash = overrideHash(row, record.originalAiClassification);
        if (record.manualOverride) {
            if (
                record.manualOverride.csvImportHash === row.csvImportHash
                && record.manualOverride.rowHash === row.rowHash
                && record.effectiveClassification === row.effectiveClassification
                && record.manualOverride.overrideHash === expectedOverrideHash
            ) continue;
            fail('CONCIERGE_CLASSIFICATION_IMPORT_CONFLICT');
        }
        const index = next.findIndex(candidate => candidate.instagramId === record.instagramId);
        if (index < 0) fail('CONCIERGE_CLASSIFICATION_IMPORT_NON_MUTUAL');
        next[index] = {
            ...record,
            effectiveClassification: row.effectiveClassification,
            classificationSource: 'manual',
            manualOverride: {
                operatorRefHash: row.operatorRefHash,
                csvImportHash: row.csvImportHash,
                rowHash: row.rowHash,
                reasonCode: row.reasonCode,
                appliedAt: row.appliedAt,
                originalAiClassification: record.originalAiClassification,
                overrideHash: expectedOverrideHash,
            },
        };
    }
    const result = Object.freeze({ ...ledger, records: Object.freeze(next) });
    validateConciergeClassificationLedger(result);
    return result;
}
