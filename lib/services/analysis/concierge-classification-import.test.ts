import { describe, expect, it } from 'vitest';
import {
    applyConciergeManualClassificationImport,
    CONCIERGE_ZERO_POST_PROVENANCE_MARKER,
    createConciergeClassificationLedgerHash,
    createConciergeZeroPostEvidenceHash,
    parseConciergeClassificationCsv,
    validateConciergeClassificationLedger,
    type ConciergeClassificationLedger,
} from './concierge-classification-import';

const HASH = 'a'.repeat(64);
const OPERATOR_HASH = 'b'.repeat(64);

function reverseObjectKeys<T>(value: T): T {
    if (Array.isArray(value)) return value.map(reverseObjectKeys) as T;
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .reverse()
            .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
    ) as T;
}

function ledger(): ConciergeClassificationLedger {
    return {
        revision: 1,
        relationshipResultHash: HASH,
        partitionHash: 'c'.repeat(64),
        mutualCount: 3,
        hydratedPublicCount: 2,
        hydratedPrivateCount: 1,
        unresolvedCount: 0,
        records: [
            {
                candidateId: 'candidate:one',
                instagramId: 'one',
                mutualOrdinal: 1,
                partition: 'public',
                profileFetchStatus: 'success',
                firstPass: { status: 'collected', fullNamePresent: true, profilePicPresent: true, feedDeclared: 8, feedCollected: 8, completeMedia: true, evidenceHash: '1'.repeat(64) },
                secondPass: { status: 'collected', fullNamePresent: null, profilePicPresent: null, feedDeclared: 8, feedCollected: 8, completeMedia: true, evidenceHash: '2'.repeat(64) },
                originalAiClassification: 'unknown',
                effectiveClassification: 'unknown',
                confidence: 'low',
                evidenceCoverage: { declared: 8, collected: 8, selected: 8, complete: true, basisPoints: 10_000, hash: '3'.repeat(64) },
                classifier: 'replay', modelName: 'model', promptVersion: 'prompt', schemaVersion: 'schema',
                classificationOperationKey: 'gender-triage:' + '4'.repeat(64), classificationResultHash: '5'.repeat(64),
                classificationSource: 'ai', manualOverride: null,
                sourceSnapshot: {
                    instagramUrl: 'https://instagram.com/one',
                    originalAiClassification: 'unknown',
                    confidenceEvidence: 'confidence=low;evidence=model_ambiguous',
                    operatorNote: '',
                },
            },
            {
                candidateId: 'candidate:two', instagramId: 'two', mutualOrdinal: 2,
                partition: 'public', profileFetchStatus: 'success',
                firstPass: { status: 'collected', fullNamePresent: true, profilePicPresent: true, feedDeclared: 8, feedCollected: 8, completeMedia: true, evidenceHash: '6'.repeat(64) },
                secondPass: { status: 'collected', fullNamePresent: null, profilePicPresent: null, feedDeclared: 8, feedCollected: 8, completeMedia: true, evidenceHash: '7'.repeat(64) },
                originalAiClassification: 'female', effectiveClassification: 'female', confidence: 'high',
                evidenceCoverage: { declared: 8, collected: 8, selected: 8, complete: true, basisPoints: 10_000, hash: '8'.repeat(64) },
                classifier: 'replay', modelName: 'model', promptVersion: 'prompt', schemaVersion: 'schema',
                classificationOperationKey: 'gender-triage:' + '9'.repeat(64), classificationResultHash: 'a'.repeat(64),
                classificationSource: 'ai', manualOverride: null,
                sourceSnapshot: {
                    instagramUrl: 'https://instagram.com/two',
                    originalAiClassification: 'female',
                    confidenceEvidence: 'confidence=high;evidence=model_ambiguous',
                    operatorNote: '',
                },
            },
            {
                candidateId: 'candidate:private', instagramId: 'private', mutualOrdinal: 3,
                partition: 'private', profileFetchStatus: 'success',
                firstPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null },
                secondPass: { status: 'not_applicable', fullNamePresent: null, profilePicPresent: null, feedDeclared: null, feedCollected: null, completeMedia: null, evidenceHash: null },
                originalAiClassification: null, effectiveClassification: null, confidence: null, evidenceCoverage: null,
                classifier: null, modelName: null, promptVersion: null, schemaVersion: null,
                classificationOperationKey: null, classificationResultHash: null, classificationSource: 'not_applicable', manualOverride: null,
            },
        ],
    };
}

describe('concierge manual classification import', () => {
    it('canonicalizes nested ledger object keys before hashing', () => {
        const original = ledger();
        const permuted = reverseObjectKeys(original);
        expect(createConciergeClassificationLedgerHash(permuted)).toBe(
            createConciergeClassificationLedgerHash(original),
        );
    });

    it('accepts the reviewed snapshot format and preserves original AI provenance', () => {
        const csv = [
            'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note',
            'one,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,female,',
        ].join('\n') + '\n';
        const input = parseConciergeClassificationCsv(csv, 'order', 'request', HASH, OPERATOR_HASH, '2026-08-14T00:00:00.000Z');
        const next = applyConciergeManualClassificationImport(ledger(), input);
        const record = next.records.find(row => row.instagramId === 'one');
        expect(record?.effectiveClassification).toBe('female');
        expect(record?.classificationSource).toBe('manual');
        expect(record?.originalAiClassification).toBe('unknown');
        expect(record?.classificationResultHash).toBe('5'.repeat(64));
        expect(record?.manualOverride?.csvImportHash).toBe(input.csvImportHash);
        expect(createConciergeClassificationLedgerHash(next)).toMatch(/^[a-f0-9]{64}$/);
    });

    it('accepts a reviewed header-only snapshot when there are no manual overrides', () => {
        const csv = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\n';
        const input = parseConciergeClassificationCsv(
            csv,
            'order',
            'request',
            HASH,
            OPERATOR_HASH,
            '2026-08-14T00:00:00.000Z',
        );
        expect(input.rows).toHaveLength(0);
        expect(input.csvContent).toBe(csv);
    });

    it('rejects the legacy four-column format and malformed RFC quoting', () => {
        expect(() => parseConciergeClassificationCsv(
            'username,effective_classification,reason_code,source_row_identifier\none,male,review,1\n',
            'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString(),
        )).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_HEADERS_INVALID');
        expect(() => parseConciergeClassificationCsv(
            'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,male,"1"x\n',
            'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString(),
        )).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_CSV_FORMAT');
    });

    it('binds every frozen review snapshot field before applying a manual gender', () => {
        const csv = [
            'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note',
            'one,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,female,changed',
        ].join('\n') + '\n';
        expect(() => applyConciergeManualClassificationImport(
            ledger(),
            parseConciergeClassificationCsv(csv, 'order', 'request', HASH, OPERATOR_HASH, '2026-08-14T00:00:00.000Z'),
        )).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_IMMUTABLE_MISMATCH');
    });

    it('rejects invalid runtime enums and manual provenance on unresolved AI-only rows', () => {
        const invalid = structuredClone(ledger()) as ConciergeClassificationLedger;
        invalid.records = [{
            ...invalid.records[0]!, originalAiClassification: 'bogus' as never,
        }, ...invalid.records.slice(1)];
        expect(() => validateConciergeClassificationLedger(invalid)).toThrow(
            'CONCIERGE_CLASSIFICATION_LEDGER_CLASSIFICATION_INVALID',
        );
        const unresolved = structuredClone(ledger()) as ConciergeClassificationLedger;
        unresolved.records = [{
            ...unresolved.records[0]!, partition: 'unresolved', effectiveClassification: 'unknown',
            classificationSource: 'manual', manualOverride: {
                operatorRefHash: OPERATOR_HASH, csvImportHash: HASH, rowHash: HASH,
                reasonCode: 'review', appliedAt: '2026-08-14T00:00:00.000Z',
                originalAiClassification: 'unknown', overrideHash: HASH,
            },
        }, ...unresolved.records.slice(1)];
        unresolved.hydratedPublicCount = 1;
        unresolved.unresolvedCount = 1;
        expect(() => validateConciergeClassificationLedger(unresolved)).toThrow(
            'CONCIERGE_CLASSIFICATION_LEDGER_UNRESOLVED_MANUAL_OVERRIDE',
        );
    });

    it('requires an immutable source snapshot for every public ledger row', () => {
        const missing = structuredClone(ledger()) as ConciergeClassificationLedger;
        delete (missing.records[0] as { sourceSnapshot?: unknown }).sourceSnapshot;
        expect(() => validateConciergeClassificationLedger(missing)).toThrow(
            'CONCIERGE_CLASSIFICATION_LEDGER_SOURCE_SNAPSHOT_REQUIRED',
        );
    });

    it('rejects invalid evidence coverage and second-pass provenance invariants', () => {
        const badCoverage = structuredClone(ledger()) as ConciergeClassificationLedger;
        badCoverage.records = [{
            ...badCoverage.records[0]!,
            evidenceCoverage: { ...badCoverage.records[0]!.evidenceCoverage!, selected: 9 },
        }, ...badCoverage.records.slice(1)];
        expect(() => validateConciergeClassificationLedger(badCoverage)).toThrow(
            'CONCIERGE_CLASSIFICATION_LEDGER_COVERAGE_INVALID',
        );
        const badSecondPass = structuredClone(ledger()) as ConciergeClassificationLedger;
        badSecondPass.records = [{
            ...badSecondPass.records[0]!,
            secondPass: { ...badSecondPass.records[0]!.secondPass, status: 'unexpected' as never },
        }, ...badSecondPass.records.slice(1)];
        expect(() => validateConciergeClassificationLedger(badSecondPass)).toThrow(
            'CONCIERGE_CLASSIFICATION_LEDGER_SECOND_PASS_INVALID',
        );

        const missingEvidence = structuredClone(ledger()) as ConciergeClassificationLedger;
        missingEvidence.records = [{
            ...missingEvidence.records[0]!,
            secondPass: { ...missingEvidence.records[0]!.secondPass, evidenceHash: null },
        }, ...missingEvidence.records.slice(1)];
        expect(() => validateConciergeClassificationLedger(missingEvidence)).toThrow(
            'CONCIERGE_CLASSIFICATION_LEDGER_SECOND_PASS_INVALID',
        );

        const zeroPost = structuredClone(ledger()) as ConciergeClassificationLedger;
        zeroPost.records = [{
            ...zeroPost.records[0]!,
            secondPass: {
                ...zeroPost.records[0]!.secondPass,
                feedDeclared: 0,
                feedCollected: 0,
                completeMedia: true,
                evidenceMarker: CONCIERGE_ZERO_POST_PROVENANCE_MARKER,
                evidenceHash: createConciergeZeroPostEvidenceHash(),
            },
        }, ...zeroPost.records.slice(1)];
        expect(() => validateConciergeClassificationLedger(zeroPost)).not.toThrow();
    });

    it('freezes exact CSV snapshots and rejects caller-supplied provenance changes', () => {
        const csv = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,male,\n';
        const input = parseConciergeClassificationCsv(csv, 'order', 'request', HASH, OPERATOR_HASH, '2026-08-14T00:00:00.000Z');
        expect(Object.isFrozen(input.rows[0])).toBe(true);
        expect(Object.isFrozen(input.rows[0]?.sourceSnapshot)).toBe(true);
        expect(() => applyConciergeManualClassificationImport(ledger(), {
            ...input,
            csvImportHash: 'c'.repeat(64),
        })).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_PROVENANCE_MISMATCH');
        expect(() => applyConciergeManualClassificationImport(ledger(), {
            ...input,
            csvContent: csv.replace(',male,', ',female,'),
        })).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_PROVENANCE_MISMATCH');
    });

    it('rejects invalid classes and duplicate rows without partial acceptance', () => {
        const header = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note';
        expect(() => parseConciergeClassificationCsv(
            `${header}\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,mystery,\n`, 'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString(),
        )).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_INVALID_ENUM');
        expect(() => parseConciergeClassificationCsv(
            `${header}\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,male,\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,female,\n`, 'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString(),
        )).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_DUPLICATE');
        expect(() => parseConciergeClassificationCsv(
            'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\none,https://example.test/one,unknown,confidence=low;evidence=model_ambiguous,male,\n',
            'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString(),
        )).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_INVALID_IMMUTABLE_FIELD');
    });

    it('rejects private and unknown-snapshot rows', () => {
        const header = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note';
        expect(() => applyConciergeManualClassificationImport(ledger(), parseConciergeClassificationCsv(
            `${header}\nprivate,https://instagram.com/private,unknown,confidence=low;evidence=model_ambiguous,male,\n`, 'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString(),
        ))).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_PARTITION_REJECTED');
        expect(() => applyConciergeManualClassificationImport(ledger(), {
            ...parseConciergeClassificationCsv(`${header}\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,male,\n`, 'order', 'request', 'd'.repeat(64), OPERATOR_HASH, new Date().toISOString()),
        })).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_MANIFEST_MISMATCH');
    });

    it('replays the same import idempotently and rejects a changed override', () => {
        const csv = 'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,male,\n';
        const input = parseConciergeClassificationCsv(csv, 'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString());
        const first = applyConciergeManualClassificationImport(ledger(), input);
        const second = applyConciergeManualClassificationImport(first, input);
        expect(createConciergeClassificationLedgerHash(second)).toBe(createConciergeClassificationLedgerHash(first));
        const changed = parseConciergeClassificationCsv(
            'username,instagram_url,ai_classification,ai_confidence/evidence_status,manual_gender,operator_note\none,https://instagram.com/one,unknown,confidence=low;evidence=model_ambiguous,female,\n',
            'order', 'request', HASH, OPERATOR_HASH, new Date().toISOString(),
        );
        expect(() => applyConciergeManualClassificationImport(first, changed)).toThrow('CONCIERGE_CLASSIFICATION_IMPORT_CONFLICT');
    });

    function nameOnlyLedger(overrides: {
        partition?: 'public' | 'private' | 'unresolved';
        profilePicPresent?: boolean | null;
        secondPassStatus?: 'collected' | 'not_collected' | 'failed' | 'not_applicable';
        secondPassCompleteMedia?: boolean | null;
    } = {}): ConciergeClassificationLedger {
        const base = ledger();
        const collectedSecondPass = overrides.secondPassStatus === 'collected';
        const nameOnlyRecord = {
            ...base.records[0]!,
            partition: overrides.partition ?? 'public',
            firstPass: {
                status: 'failed' as const,
                fullNamePresent: true,
                profilePicPresent: overrides.profilePicPresent ?? false,
                feedDeclared: null,
                feedCollected: null,
                completeMedia: null,
                evidenceHash: '1'.repeat(64),
            },
            secondPass: {
                status: overrides.secondPassStatus ?? 'not_collected',
                fullNamePresent: true,
                profilePicPresent: false,
                feedDeclared: collectedSecondPass ? 8 : null,
                feedCollected: collectedSecondPass ? 8 : null,
                completeMedia: overrides.secondPassCompleteMedia ?? null,
                evidenceHash: collectedSecondPass ? 'f'.repeat(64) : null,
            },
            originalAiClassification: 'female' as const,
            effectiveClassification: 'female' as const,
            confidence: 'medium' as const,
            classificationSource: 'name_only' as const,
            sourceSnapshot: {
                instagramUrl: 'https://instagram.com/one',
                originalAiClassification: 'female' as const,
                confidenceEvidence: 'confidence=medium;evidence=name_only',
                operatorNote: '',
            },
        };
        return { ...base, records: [nameOnlyRecord, ...base.records.slice(1)] };
    }

    it('accepts a definitionally correct name-only record: no image, no collected second pass', () => {
        expect(() => validateConciergeClassificationLedger(nameOnlyLedger())).not.toThrow();
    });

    it('rejects a name-only record whose recorded firstPass retains a usable profile image', () => {
        expect(() => validateConciergeClassificationLedger(nameOnlyLedger({ profilePicPresent: true })))
            .toThrow('CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
    });

    it('rejects a name-only record whose second pass claims collected media', () => {
        expect(() => validateConciergeClassificationLedger(
            nameOnlyLedger({ secondPassStatus: 'collected', secondPassCompleteMedia: true }),
        )).toThrow('CONCIERGE_CLASSIFICATION_LEDGER_OVERRIDE_INVALID');
    });

    it('rejects a name-only record outside the public partition', () => {
        expect(() => validateConciergeClassificationLedger(nameOnlyLedger({ partition: 'unresolved' })))
            .toThrow();
    });
});
