import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    progressEventV1Schema,
    progressSnapshotV1Schema,
    type ProgressEventV1,
    type ProgressSnapshotV1,
} from '@/lib/contracts/analysis-v2';
import {
    PROGRESS_TRACK_IDS,
    advancePersistedProgress,
    calculateTrackProgressBp,
    type AnalysisProgressStatus,
    type ProgressTrackId,
} from '@/lib/domain/analysis/progress-policy';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const STAGE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MASKED_USERNAME_PATTERN = /^[A-Za-z0-9._]*\*[A-Za-z0-9._*]*$/;

export const ANALYSIS_V2_PROGRESS_DATABASE_NAMES = Object.freeze({
    stateTable: 'analysis_progress_state',
    eventTable: 'analysis_progress_events',
    activeProfileHeartbeatTable: 'analysis_v2_active_profile_heartbeats',
    checkpointRpc: 'checkpoint_analysis_v2_progress',
    heartbeatRpc: 'checkpoint_analysis_v2_active_profile_heartbeat',
    loadRpc: 'load_analysis_v2_progress',
});

export const ANALYSIS_V2_PROGRESS_EVENT_CODES = [
    'TARGET_PROFILE_READY',
    'RELATIONSHIP_PROGRESS',
    'PROFILE_SCREENED',
    'SHORTLIST_READY',
    'POTENTIAL_HIGH_RISK_FOUND',
    'FINDING_CORRECTED',
    'FINDING_CONFIRMED',
    'ANALYSIS_COMPLETED',
] as const;

export type AnalysisV2ProgressEventCode =
    typeof ANALYSIS_V2_PROGRESS_EVENT_CODES[number];
export type AnalysisV2ProgressEventState = 'provisional' | 'confirmed' | 'corrected';
export type AnalysisV2ProgressTrackState = 'pending' | 'running' | 'completed' | 'failed';

const trackInputSchema = z.object({
    state: z.enum(['pending', 'running', 'completed', 'failed']),
    stageCode: z.string().regex(STAGE_CODE_PATTERN),
    done: z.number().int().min(0).max(1_000_000),
    total: z.number().int().min(0).max(1_000_000),
}).strict().superRefine((value, context) => {
    if (value.done > value.total) {
        context.addIssue({
            code: 'custom',
            path: ['done'],
            message: 'Track done cannot exceed total.',
        });
    }
    if (value.state === 'pending' && value.done !== 0) {
        context.addIssue({
            code: 'custom',
            path: ['done'],
            message: 'A pending track cannot report completed work.',
        });
    }
    if (value.state === 'completed' && value.done !== value.total) {
        context.addIssue({
            code: 'custom',
            path: ['done'],
            message: 'A completed track must finish all work.',
        });
    }
});

const tracksInputSchema = z.object({
    relationshipAi: trackInputSchema,
    interactions: trackInputSchema,
    finalization: trackInputSchema,
}).strict();

const activeProfileInputSchema = z.object({
    maskedUsername: z.string().min(1).max(30).regex(MASKED_USERNAME_PATTERN),
    imageUrl: z.string()
        .trim()
        .min(1)
        .max(2_048)
        .refine(value => value.startsWith('/api/image-proxy?'))
        .nullable(),
}).strict();

const activeProfileHeartbeatInputSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    claimToken: z.string().regex(UUID_PATTERN),
    jobInputHash: z.string().regex(SHA256_PATTERN),
    startedAt: z.string().datetime({ offset: true }),
    totalCount: z.number().int().min(1).max(30),
    maskedUsername: z.string().min(1).max(30).regex(MASKED_USERNAME_PATTERN),
    imageUrl: z.string()
        .trim()
        .min(1)
        .max(2_048)
        .refine(value => value.startsWith('/api/image-proxy?'))
        .nullable(),
}).strict();

const etaInputSchema = z.object({
    lowSeconds: z.number().int().min(0).max(3_600),
    highSeconds: z.number().int().min(0).max(3_600),
}).strict().refine(value => value.lowSeconds <= value.highSeconds, {
    message: 'ETA low bound cannot exceed the high bound.',
});

const progressEventInputSchema = z.object({
    state: z.enum(['provisional', 'confirmed', 'corrected']),
    eventCode: z.enum(ANALYSIS_V2_PROGRESS_EVENT_CODES),
    copyCode: z.string().regex(STAGE_CODE_PATTERN),
    aggregateCount: z.number().int().min(0).max(10_000).nullable(),
}).strict().superRefine((value, context) => {
    const requiredState = value.eventCode === 'POTENTIAL_HIGH_RISK_FOUND'
        ? 'provisional'
        : value.eventCode === 'FINDING_CORRECTED'
            ? 'corrected'
            : ['SHORTLIST_READY', 'FINDING_CONFIRMED', 'ANALYSIS_COMPLETED']
                .includes(value.eventCode)
                ? 'confirmed'
                : null;
    if (requiredState !== null && value.state !== requiredState) {
        context.addIssue({
            code: 'custom',
            path: ['state'],
            message: `${value.eventCode} requires the ${requiredState} state.`,
        });
    }
});

const checkpointInputSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    claimToken: z.string().regex(UUID_PATTERN),
    jobInputHash: z.string().regex(SHA256_PATTERN),
    status: z.enum(['queued', 'processing', 'completed', 'failed', 'upgrade_required']),
    backgroundProcessing: z.boolean(),
    tracks: tracksInputSchema,
    activeProfile: activeProfileInputSchema.nullable(),
    etaRange: etaInputSchema.nullable(),
    event: progressEventInputSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
    if (
        (value.status === 'queued' || value.status === 'processing')
        && !value.backgroundProcessing
    ) {
        context.addIssue({
            code: 'custom',
            path: ['backgroundProcessing'],
            message: 'Active V2 work must remain server-owned.',
        });
    }
    if (
        value.status === 'completed'
        && Object.values(value.tracks).some(track => track.state !== 'completed')
    ) {
        context.addIssue({
            code: 'custom',
            path: ['tracks'],
            message: 'Completed progress requires every track to be complete.',
        });
    }
    if (value.status === 'completed' && value.event?.eventCode !== 'ANALYSIS_COMPLETED') {
        context.addIssue({
            code: 'custom',
            path: ['event'],
            message: 'The completed transition must append its terminal event.',
        });
    }
    if (value.event?.eventCode === 'ANALYSIS_COMPLETED' && value.status !== 'completed') {
        context.addIssue({
            code: 'custom',
            path: ['event', 'eventCode'],
            message: 'The completion event requires completed progress.',
        });
    }
    if (
        ['failed', 'upgrade_required'].includes(value.status)
        && value.event != null
    ) {
        context.addIssue({
            code: 'custom',
            path: ['event'],
            message: 'A non-success terminal transition cannot append a finding event.',
        });
    }
    if (
        ['completed', 'failed', 'upgrade_required'].includes(value.status)
        && (
            value.backgroundProcessing
            || value.activeProfile !== null
            || value.etaRange !== null
        )
    ) {
        context.addIssue({
            code: 'custom',
            path: ['activeProfile'],
            message: 'Terminal progress cannot retain background, profile, or ETA state.',
        });
    }
});

const checkpointResponseSchema = z.object({
    snapshot: progressSnapshotV1Schema,
    event: progressEventV1Schema.nullable(),
    advanced: z.boolean(),
}).strict();

const loadResponseSchema = z.object({
    snapshot: progressSnapshotV1Schema,
    events: z.array(progressEventV1Schema).max(200),
}).strict().superRefine((value, context) => {
    for (let index = 1; index < value.events.length; index += 1) {
        if (value.events[index]!.seq !== value.events[index - 1]!.seq + 1) {
            context.addIssue({
                code: 'custom',
                path: ['events', index, 'seq'],
                message: 'Progress event pages must be contiguous.',
            });
        }
    }
    if (value.events.some(event => event.revision > value.snapshot.revision)) {
        context.addIssue({
            code: 'custom',
            path: ['events'],
            message: 'An event cannot be newer than its snapshot.',
        });
    }
});

export interface AnalysisV2ProgressTrackInput {
    state: AnalysisV2ProgressTrackState;
    stageCode: string;
    done: number;
    total: number;
}

export type AnalysisV2ProgressTracksInput = Readonly<
    Record<ProgressTrackId, AnalysisV2ProgressTrackInput>
>;

export interface AnalysisV2ProgressEventInput {
    state: AnalysisV2ProgressEventState;
    eventCode: AnalysisV2ProgressEventCode;
    copyCode: string;
    aggregateCount: number | null;
}

export interface AnalysisV2ProgressCheckpointInput {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
    status: AnalysisProgressStatus;
    backgroundProcessing: boolean;
    tracks: AnalysisV2ProgressTracksInput;
    activeProfile: {
        maskedUsername: string;
        imageUrl: string | null;
    } | null;
    etaRange: { lowSeconds: number; highSeconds: number } | null;
    event?: AnalysisV2ProgressEventInput | null;
}

export interface AnalysisV2ProgressCheckpointResult {
    snapshot: ProgressSnapshotV1;
    event: ProgressEventV1 | null;
    advanced: boolean;
}

export interface AnalysisV2ProgressReadResult {
    snapshot: ProgressSnapshotV1;
    events: ProgressEventV1[];
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2ProgressSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface AnalysisV2ProgressStore {
    checkpoint(input: AnalysisV2ProgressCheckpointInput):
        Promise<AnalysisV2ProgressCheckpointResult>;
    heartbeatActiveProfile?(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        startedAt: string;
        totalCount: number;
        maskedUsername: string;
        imageUrl: string | null;
    }): Promise<boolean>;
    loadForOwner(input: {
        requestId: string;
        userId: string;
        afterSequence?: number;
        eventLimit?: number;
    }): Promise<AnalysisV2ProgressReadResult | null>;
}

export class AnalysisV2ProgressFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_PROGRESS_FENCE_MISMATCH');
        this.name = 'AnalysisV2ProgressFenceError';
    }
}

export class AnalysisV2ProgressConflictError extends Error {
    constructor(message = 'ANALYSIS_V2_PROGRESS_CONFLICT') {
        super(message);
        this.name = 'AnalysisV2ProgressConflictError';
    }
}

function maskCharacters(value: string): string {
    const characters = [...value];
    if (characters.length === 1) return '*';
    if (characters.length === 2) return `${characters[0]}*`;
    return `${characters[0]}${'*'.repeat(Math.min(12, characters.length - 2))}${characters.at(-1)}`;
}

/** Converts a raw handle to a bounded public progress label before persistence. */
export function maskAnalysisV2ProgressUsername(rawUsername: string): string {
    const normalized = rawUsername.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(normalized)) {
        throw new Error('ANALYSIS_V2_PROGRESS_VALIDATION_ERROR: invalid username.');
    }
    return maskCharacters(normalized);
}

function snapshotFingerprint(input: z.infer<typeof checkpointInputSchema>): string {
    const publicSnapshot = {
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        status: input.status,
        backgroundProcessing: input.backgroundProcessing,
        tracks: PROGRESS_TRACK_IDS.map(trackId => [trackId, input.tracks[trackId]]),
        activeProfile: input.activeProfile,
        etaRange: input.etaRange,
    };
    return createHash('sha256')
        .update('analysis-v2-progress-snapshot-v1\n', 'utf8')
        .update(JSON.stringify(publicSnapshot), 'utf8')
        .digest('hex');
}

function progressEventKey(
    input: z.infer<typeof checkpointInputSchema>,
    fingerprint: string
): string | null {
    if (!input.event) return null;
    return createHash('sha256')
        .update('analysis-v2-progress-event-v1\n', 'utf8')
        .update(input.requestId.toLowerCase(), 'utf8')
        .update('\n', 'utf8')
        .update(input.jobKey, 'utf8')
        .update('\n', 'utf8')
        .update(input.jobInputHash, 'utf8')
        .update('\n', 'utf8')
        .update(fingerprint, 'utf8')
        .update('\n', 'utf8')
        .update(JSON.stringify(input.event), 'utf8')
        .digest('hex');
}

function databaseTracks(input: z.infer<typeof tracksInputSchema>): Record<string, unknown> {
    return Object.fromEntries(PROGRESS_TRACK_IDS.map(trackId => {
        const track = input[trackId];
        return [trackId, {
            state: track.state,
            stageCode: track.stageCode,
            done: track.done,
            total: track.total,
            progressBp: calculateTrackProgressBp(track),
        }];
    }));
}

function nullableObjectsMatch(
    left: Record<string, unknown> | null,
    right: Record<string, unknown> | null
): boolean {
    if (left === null || right === null) return left === right;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => (
            key === rightKeys[index] && left[key] === right[key]
        ));
}

function snapshotMatchesCheckpoint(
    snapshot: ProgressSnapshotV1,
    input: z.infer<typeof checkpointInputSchema>
): boolean {
    if (
        snapshot.status !== input.status
        || snapshot.backgroundProcessing !== input.backgroundProcessing
        || !nullableObjectsMatch(snapshot.activeProfile, input.activeProfile)
        || !nullableObjectsMatch(snapshot.etaRange, input.etaRange)
    ) {
        return false;
    }

    return PROGRESS_TRACK_IDS.every(trackId => {
        const actual = snapshot.tracks[trackId];
        const expected = input.tracks[trackId];
        return actual.state === expected.state
            && actual.stageCode === expected.stageCode
            && actual.done === expected.done
            && actual.total === expected.total
            && actual.progressBp === calculateTrackProgressBp(expected);
    });
}

function hasTerminalTransientState(snapshot: ProgressSnapshotV1): boolean {
    return ['completed', 'failed', 'upgrade_required'].includes(snapshot.status)
        && (
            snapshot.backgroundProcessing
            || snapshot.activeProfile !== null
            || snapshot.etaRange !== null
        );
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH') {
        throw new AnalysisV2ProgressFenceError();
    }
    if (
        error.message === 'ANALYSIS_V2_PROGRESS_CONFLICT'
        || error.message === 'ANALYSIS_V2_PROGRESS_REGRESSION'
        || error.message === 'ANALYSIS_V2_PROGRESS_EVENT_CONFLICT'
    ) {
        throw new AnalysisV2ProgressConflictError(error.message);
    }
    throw new Error(
        `ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

export function createAnalysisV2ProgressStore(
    client: AnalysisV2ProgressSupabaseClient = supabaseAdmin
): AnalysisV2ProgressStore {
    return {
        async heartbeatActiveProfile(rawInput) {
            const input = activeProfileHeartbeatInputSchema.parse(rawInput);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROGRESS_DATABASE_NAMES.heartbeatRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_started_at: input.startedAt,
                    p_total_count: input.totalCount,
                    p_masked_username: input.maskedUsername,
                    p_image_url: input.imageUrl,
                }
            );
            if (error) throwRpcError(error, 'active profile heartbeat');
            if (typeof data !== 'boolean') {
                throw new Error(
                    'ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: invalid heartbeat response.'
                );
            }
            return data;
        },

        async checkpoint(rawInput) {
            const input = checkpointInputSchema.parse(rawInput);
            const fingerprint = snapshotFingerprint(input);
            const calculated = advancePersistedProgress({
                previous: {
                    revision: 0,
                    overallProgressBp: 0,
                    status: 'queued',
                    lastEventSeq: 0,
                    snapshotFingerprint: '0'.repeat(64),
                },
                tracks: Object.fromEntries(PROGRESS_TRACK_IDS.map(trackId => [
                    trackId,
                    {
                        done: input.tracks[trackId].done,
                        total: input.tracks[trackId].total,
                    },
                ])) as Record<ProgressTrackId, { done: number; total: number }>,
                status: input.status,
                lastEventSeq: input.event ? 1 : 0,
                snapshotFingerprint: fingerprint,
            });
            const progressBp = calculated.calculatedProgressBp;
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROGRESS_DATABASE_NAMES.checkpointRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_claim_token: input.claimToken.toLowerCase(),
                    p_job_input_hash: input.jobInputHash,
                    p_status: input.status,
                    p_progress_bp: progressBp,
                    p_background_processing: input.backgroundProcessing,
                    p_tracks: databaseTracks(input.tracks),
                    p_active_profile: input.activeProfile,
                    p_eta_range: input.etaRange,
                    p_snapshot_fingerprint: fingerprint,
                    p_event: input.event ?? null,
                    p_event_key: progressEventKey(input, fingerprint),
                }
            );
            if (error) throwRpcError(error, 'checkpoint');
            const parsed = checkpointResponseSchema.safeParse(data);
            if (!parsed.success) {
                throw new Error(
                    'ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: invalid checkpoint response.'
                );
            }
            if (
                parsed.data.snapshot.requestId !== input.requestId.toLowerCase()
                || !snapshotMatchesCheckpoint(parsed.data.snapshot, input)
                || parsed.data.snapshot.progressBp < progressBp
                || hasTerminalTransientState(parsed.data.snapshot)
            ) {
                throw new Error(
                    'ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: checkpoint response drift.'
                );
            }
            return parsed.data;
        },

        async loadForOwner(rawInput) {
            const input = z.object({
                requestId: z.string().regex(UUID_PATTERN),
                userId: z.string().regex(UUID_PATTERN),
                afterSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
                eventLimit: z.number().int().min(1).max(200).default(100),
            }).strict().parse(rawInput);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_PROGRESS_DATABASE_NAMES.loadRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_user_id: input.userId.toLowerCase(),
                    p_after_sequence: input.afterSequence,
                    p_event_limit: input.eventLimit,
                }
            );
            if (error) throwRpcError(error, 'owner load');
            if (data === null) return null;
            const parsed = loadResponseSchema.safeParse(data);
            if (
                !parsed.success
                || parsed.data.snapshot.requestId !== input.requestId.toLowerCase()
                || (
                    parsed.data.events.length > 0
                    && parsed.data.events[0]!.seq !== input.afterSequence + 1
                )
                || (
                    parsed.data.events.at(-1)?.seq !== undefined
                    && parsed.data.events.at(-1)!.seq > parsed.data.snapshot.lastEventSeq
                )
                || parsed.data.events.some((event, index, events) => (
                    index > 0 && event.revision <= events[index - 1]!.revision
                ))
                || hasTerminalTransientState(parsed.data.snapshot)
            ) {
                throw new Error(
                    'ANALYSIS_V2_PROGRESS_PERSISTENCE_ERROR: invalid owner load response.'
                );
            }
            return parsed.data;
        },
    };
}

export const analysisV2ProgressStore = createAnalysisV2ProgressStore();
