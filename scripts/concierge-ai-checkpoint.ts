import {
    existsSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { z } from 'zod';
import type { ReplayAccountAiDetail } from '@/lib/services/analysis/replay/replay-runner';

const CHECKPOINT_SCHEMA = 'concierge-basic-v211-ai-checkpoint-v1';

const checkpointDetailSchema = z.object({
    ordinal: z.number().int().positive(),
    finalClassification: z.enum([
        'verified_female',
        'verified_non_female',
        'unresolved',
        'unresolved_stage_conflict',
        'analysis_unavailable',
    ]),
    classificationSource: z.enum([
        'triage',
        'feature',
        'gender_resolution',
        'unknown',
        'unavailable',
    ]),
    featureOverview: z.string().nullable(),
    triage: z.unknown().nullable(),
    feature: z.unknown().nullable(),
}).strict();

const checkpointSchema = z.object({
    schema: z.literal(CHECKPOINT_SCHEMA),
    sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    replayInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    aiStagePolicy: z.string().min(1).max(128),
    details: z.array(checkpointDetailSchema),
}).strict();

export type ConciergeAiCheckpoint = {
    sourceFingerprint: string;
    replayInputFingerprint: string;
    aiStagePolicy: string;
    details: ReadonlyMap<number, ReplayAccountAiDetail>;
};

export function readConciergeAiCheckpoint(
    path: string,
    expected: Readonly<{
        sourceFingerprint: string;
        replayInputFingerprint: string;
        aiStagePolicy: string;
        allowReplayInputFingerprintMismatch?: boolean;
    }>,
): ReadonlyMap<number, ReplayAccountAiDetail> {
    if (!existsSync(path)) return new Map();
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
        throw new Error('CONCIERGE_AI_CHECKPOINT_INVALID');
    }
    const parsed = checkpointSchema.safeParse(parsedJson);
    if (!parsed.success) throw new Error('CONCIERGE_AI_CHECKPOINT_INVALID');
    if (
        parsed.data.sourceFingerprint !== expected.sourceFingerprint
        || (
            parsed.data.replayInputFingerprint !== expected.replayInputFingerprint
            && expected.allowReplayInputFingerprintMismatch !== true
        )
        || parsed.data.aiStagePolicy !== expected.aiStagePolicy
    ) {
        return new Map();
    }
    const details = new Map<number, ReplayAccountAiDetail>();
    for (const detail of parsed.data.details) {
        if (details.has(detail.ordinal)) throw new Error('CONCIERGE_AI_CHECKPOINT_INVALID');
        details.set(detail.ordinal, detail as ReplayAccountAiDetail);
    }
    return details;
}

export function writeConciergeAiCheckpoint(
    path: string,
    input: Readonly<{
        sourceFingerprint: string;
        replayInputFingerprint: string;
        aiStagePolicy: string;
        details: ReadonlyMap<number, ReplayAccountAiDetail>;
    }>,
): void {
    const details = [...input.details.values()]
        .sort((left, right) => left.ordinal - right.ordinal);
    const payload = {
        schema: CHECKPOINT_SCHEMA,
        sourceFingerprint: input.sourceFingerprint,
        replayInputFingerprint: input.replayInputFingerprint,
        aiStagePolicy: input.aiStagePolicy,
        details,
    };
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    renameSync(temporaryPath, path);
}

export function clearConciergeAiCheckpoint(path: string): void {
    if (existsSync(path)) unlinkSync(path);
}

/** Return only a safe machine error code; never expose command stderr or IDs. */
export function conciergeErrorCode(error: unknown): string {
    const candidates: string[] = [];
    if (error instanceof Error) candidates.push(error.message);
    if (error && typeof error === 'object') {
        const record = error as Record<string, unknown>;
        if (typeof record.message === 'string') candidates.push(record.message);
        for (const key of ['stderr', 'stdout']) {
            const value = record[key];
            if (typeof value === 'string') candidates.push(value);
            if (Buffer.isBuffer(value)) candidates.push(value.toString('utf8'));
        }
    }
    for (const candidate of candidates) {
        const scopedMatch = /\b(CONCIERGE_[A-Z0-9_]{2,119})\b/.exec(candidate);
        if (scopedMatch?.[1]) return scopedMatch[1];
    }
    for (const candidate of candidates.slice(1)) {
        const sqlState = /\bSQLSTATE\s+([A-Z0-9]{5})\b/i.exec(candidate);
        if (sqlState?.[1]) return `CONCIERGE_DATABASE_SQLSTATE_${sqlState[1].toUpperCase()}`;
    }
    for (const candidate of candidates.slice(1)) {
        const match = /\b([A-Z][A-Z0-9_]{2,119})\b/.exec(candidate);
        if (match?.[1]) return match[1];
    }
    const message = candidates[0];
    if (message) {
        const match = /\b([A-Z][A-Z0-9_]{2,119})\b/.exec(message);
        if (match?.[1]) return match[1];
    }
    return 'CONCIERGE_EXACT_CORRECTION_FAILED';
}
