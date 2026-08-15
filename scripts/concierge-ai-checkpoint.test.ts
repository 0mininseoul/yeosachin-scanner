import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAtomicPublicationSql } from './correct-concierge-basic-result';
import {
    clearConciergeAiCheckpoint,
    conciergeErrorCode,
    readConciergeAiCheckpoint,
    writeConciergeAiCheckpoint,
} from './concierge-ai-checkpoint';
import type { ReplayAccountAiDetail } from '@/lib/services/analysis/replay/replay-runner';

const expected = {
    sourceFingerprint: 'a'.repeat(64),
    replayInputFingerprint: 'b'.repeat(64),
    aiStagePolicy: 'ai-stage-policy-v2.11',
};

const detail = (ordinal: number): ReplayAccountAiDetail => ({
    ordinal,
    finalClassification: 'verified_female',
    classificationSource: 'feature',
    featureOverview: '공개 피드의 흐름을 중심으로 읽어볼 만한 계정입니다.',
    triage: { assessment: { confidence: 'high' } } as unknown as ReplayAccountAiDetail['triage'],
    feature: { features: { oneLineOverview: '공개 피드의 흐름을 중심으로 읽어볼 만한 계정입니다.' } } as unknown as ReplayAccountAiDetail['feature'],
});

describe('concierge AI checkpoint', () => {
    it('writes atomically and restores only the exact source scope', () => {
        const directory = mkdtempSync(join(tmpdir(), 'concierge-ai-checkpoint-'));
        const path = join(directory, 'checkpoint.json');
        try {
            writeConciergeAiCheckpoint(path, {
                ...expected,
                details: new Map([[2, detail(2)], [1, detail(1)]]),
            });
            const restored = readConciergeAiCheckpoint(path, expected);
            expect([...restored.keys()]).toEqual([1, 2]);
            expect(JSON.parse(readFileSync(path, 'utf8')).details.map((row: { ordinal: number }) => row.ordinal))
                .toEqual([1, 2]);
            expect(readConciergeAiCheckpoint(path, {
                ...expected,
                sourceFingerprint: 'c'.repeat(64),
            })).toEqual(new Map());
        } finally {
            clearConciergeAiCheckpoint(path);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('fails closed on malformed or duplicate details', () => {
        const directory = mkdtempSync(join(tmpdir(), 'concierge-ai-checkpoint-'));
        const path = join(directory, 'checkpoint.json');
        try {
            writeConciergeAiCheckpoint(path, {
                ...expected,
                details: new Map([[1, detail(1)]]),
            });
            const valid = JSON.parse(readFileSync(path, 'utf8')) as { details: unknown[] };
            valid.details.push(valid.details[0]);
            writeFileSync(path, JSON.stringify(valid));
            expect(() => readConciergeAiCheckpoint(path, expected))
                .toThrow('CONCIERGE_AI_CHECKPOINT_INVALID');
            writeFileSync(path, '{');
            expect(() => readConciergeAiCheckpoint(path, expected))
                .toThrow('CONCIERGE_AI_CHECKPOINT_INVALID');
        } finally {
            clearConciergeAiCheckpoint(path);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('requires explicit approval to resume an exact source after replay-input drift', () => {
        const directory = mkdtempSync(join(tmpdir(), 'concierge-ai-checkpoint-'));
        const path = join(directory, 'checkpoint.json');
        try {
            writeConciergeAiCheckpoint(path, {
                ...expected,
                details: new Map([[1, detail(1)]]),
            });
            expect(readConciergeAiCheckpoint(path, {
                ...expected,
                replayInputFingerprint: 'c'.repeat(64),
            })).toEqual(new Map());
            expect([...readConciergeAiCheckpoint(path, {
                ...expected,
                replayInputFingerprint: 'c'.repeat(64),
                allowReplayInputFingerprintMismatch: true,
            }).keys()]).toEqual([1]);
        } finally {
            clearConciergeAiCheckpoint(path);
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('extracts only uppercase machine codes from sanitized error fields', () => {
        expect(conciergeErrorCode(new Error('CONCIERGE_SCOPE_CONFLICT: hidden details')))
            .toBe('CONCIERGE_SCOPE_CONFLICT');
        expect(conciergeErrorCode({ stderr: Buffer.from('ERROR: CONCIERGE_RPC_REJECTED secret') }))
            .toBe('CONCIERGE_RPC_REJECTED');
        expect(conciergeErrorCode({
            message: 'Command failed: BEGIN; SELECT ...',
            stdout: Buffer.from('ERROR: CONCIERGE_BOOTSTRAP_PUBLICATION_PAYLOAD_INVALID'),
        })).toBe('CONCIERGE_BOOTSTRAP_PUBLICATION_PAYLOAD_INVALID');
        expect(conciergeErrorCode({
            message: 'Command failed: BEGIN; SELECT ...',
            stderr: 'query error: ERROR: check failed (SQLSTATE 23505)',
        })).toBe('CONCIERGE_DATABASE_SQLSTATE_23505');
        expect(conciergeErrorCode(new Error('ordinary failure')))
            .toBe('CONCIERGE_EXACT_CORRECTION_FAILED');
    });

    it('sends the bootstrap RPC as one prepared statement so its function transaction stays atomic', () => {
        const sql = buildAtomicPublicationSql({
            orderId: '123e4567-e89b-42d3-a456-426614174000',
            ownerId: '223e4567-e89b-42d3-a456-426614174000',
            sourceRequestId: '323e4567-e89b-42d3-a456-426614174000',
            firstRelationshipRequestId: '423e4567-e89b-42d3-a456-426614174000',
            secondRelationshipRequestId: '523e4567-e89b-42d3-a456-426614174000',
            failedPreflightId: '623e4567-e89b-42d3-a456-426614174000',
            rearmedPreflightId: '723e4567-e89b-42d3-a456-426614174000',
            requestId: '823e4567-e89b-42d3-a456-426614174000',
            targetUsername: 'target',
            counts: { male: 31, female: 16, unknown: 6 },
            mutualFollows: 149,
            hydration: { exactMutual: 149, hydrated: 148, public: 53, private: 95, unresolved: 1 },
            sourceFingerprint: 'a'.repeat(64),
            targetEvidenceManifest: 'b'.repeat(64),
            artifactHashes: {},
            followers: [],
            following: [],
            targetEvidence: [],
            femaleRows: [],
            privateRows: [],
            unresolvedUsernames: ['unresolved'],
            unavailablePublicUsernames: [],
        });
        expect(sql).toMatch(/^SELECT public\.bootstrap_earlybird_v211_concierge_first_order\(/);
        expect(sql).not.toContain('BEGIN;');
        expect(sql).not.toContain('COMMIT;');
        expect((sql.match(/;/g) ?? []).length).toBe(1);
    });
});
