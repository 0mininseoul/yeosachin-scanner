import {
    createHmac,
    randomBytes,
    timingSafeEqual,
} from 'node:crypto';
import { z } from 'zod';

export type LandingLeadMappingStatus =
    | 'legacy_unlinked'
    | 'anonymous_device'
    | 'authenticated_user'
    | 'unlinked_after_deletion';

export type LandingLeadJourneyClaim = Readonly<{
    journeyId: string;
    tokenHash: string;
    mappingStatus: LandingLeadMappingStatus;
    created: boolean;
}>;

export class LandingLeadCaptureMismatchError extends Error {
    constructor() {
        super('LANDING_LEAD_CAPTURE_MISMATCH');
        this.name = 'LandingLeadCaptureMismatchError';
    }
}

export class LandingLeadCursorInvalidError extends Error {
    constructor() {
        super('LANDING_LEAD_CURSOR_INVALID');
        this.name = 'LandingLeadCursorInvalidError';
    }
}

export type LandingLeadJourneyRpcClient = {
    rpc(
        name: string,
        params: Record<string, unknown>,
    ): PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>;
};

export type LandingLeadListRow = Readonly<{
    instagramId: string;
    inputContext: 'target' | 'excluded';
    mappingStatus: LandingLeadMappingStatus;
    rowCountInJourney: number;
    firstSeenAt: string;
    lastSeenAt: string;
}>;

export type LandingLeadAdminProjection = Readonly<{
    rows: readonly LandingLeadListRow[];
    nextCursor: string | null;
}>;

const LANDING_LEAD_CAPTURE_DOMAIN = 'yeosachin:landing-lead:capture:v1';
const LANDING_LEAD_PRINCIPAL_DOMAIN = 'yeosachin:landing-lead:anonymous-principal:v1';
const LANDING_LEAD_CURSOR_DOMAIN = 'yeosachin:landing-lead:admin-cursor:v1';
const DEFAULT_LOCAL_SECRET = 'landing-lead-local-development-secret-please-configure';
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTAGRAM_PATTERN = /^[a-z0-9._]{1,30}$/;

const landingLeadMappingStatusSchema = z.enum([
    'legacy_unlinked',
    'anonymous_device',
    'authenticated_user',
    'unlinked_after_deletion',
]);

export const landingLeadListRowSchema = z.object({
    instagramId: z.string().regex(INSTAGRAM_PATTERN),
    inputContext: z.enum(['target', 'excluded']),
    mappingStatus: landingLeadMappingStatusSchema,
    rowCountInJourney: z.number().int().positive().max(100),
    firstSeenAt: z.string().datetime({ offset: true }),
    lastSeenAt: z.string().datetime({ offset: true }),
}).strict();

const adminProjectionInputSchema = z.object({
    context: z.enum(['target', 'excluded']).optional(),
    mappingStatus: landingLeadMappingStatusSchema.optional(),
    instagramId: z.string().regex(INSTAGRAM_PATTERN).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    cursor: z.string().max(512).optional(),
    pageSize: z.number().int().min(1).max(50).default(25),
}).strict();

function secretFor(env: Record<string, string | undefined> = process.env): string {
    const configured = env.LANDING_LEAD_CAPTURE_SECRET?.trim()
        || env.ANONYMOUS_PREFLIGHT_CLAIM_SECRET?.trim();
    if (configured) {
        if (configured.length < 32) throw new Error('LANDING_LEAD_CAPTURE_CONFIG_ERROR');
        return configured;
    }
    if (env.NODE_ENV === 'production') throw new Error('LANDING_LEAD_CAPTURE_CONFIG_ERROR');
    return DEFAULT_LOCAL_SECRET;
}

export function landingLeadCaptureSecret(
    env: Record<string, string | undefined> = process.env,
): string {
    return secretFor(env);
}

function digest(domain: string, value: string, secret: string): string {
    return createHmac('sha256', secret)
        .update(`${domain}\0${value}`, 'utf8')
        .digest('hex');
}

export function deriveAnonymousPrincipalHash(
    deviceId: string,
    secret: string = secretFor(),
): string {
    if (!deviceId || deviceId.length > 256) throw new Error('LANDING_LEAD_DEVICE_INVALID');
    return digest(LANDING_LEAD_PRINCIPAL_DOMAIN, deviceId, secret);
}

export function hashCaptureToken(
    token: string,
    secret: string = secretFor(),
): string {
    if (!token || token.length > 512) throw new Error('LANDING_LEAD_CAPTURE_TOKEN_INVALID');
    return digest(LANDING_LEAD_CAPTURE_DOMAIN, token, secret);
}

function signatureFor(payload: string, secret: string): string {
    return createHmac('sha256', secret)
        .update(`${LANDING_LEAD_CAPTURE_DOMAIN}\0${payload}`, 'utf8')
        .digest('base64url');
}

export type LandingLeadCaptureToken = Readonly<{
    token: string;
    tokenHash: string;
    journeyId: string;
}>;

export function createCaptureToken(
    _deviceId: string,
    secret: string = secretFor(),
    deterministicSeed?: string,
): LandingLeadCaptureToken {
    const nonce = deterministicSeed
        ? createHmac('sha256', secret)
            .update(`${LANDING_LEAD_CAPTURE_DOMAIN}:nonce\0${deterministicSeed}`, 'utf8')
            .digest('base64url')
            .slice(0, 32)
        : randomBytes(24).toString('base64url');
    const payload = `v1.${nonce}`;
    const token = `${payload}.${signatureFor(payload, secret)}`;
    const tokenHash = hashCaptureToken(token, secret);
    return { token, tokenHash, journeyId: captureJourneyId(tokenHash) };
}

function captureJourneyId(tokenHash: string): string {
    const bytes = Buffer.from(tokenHash, 'hex').subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function readCaptureToken(
    token: string,
    secret: string = secretFor(),
): { tokenHash: string } | null {
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return null;
    const payload = `v1.${match[1]}`;
    const expected = Buffer.from(signatureFor(payload, secret));
    const received = Buffer.from(match[2]);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
    const tokenHash = hashCaptureToken(token, secret);
    return { tokenHash };
}

export function captureTokenJourneyId(tokenHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error('LANDING_LEAD_CAPTURE_HASH_INVALID');
    return captureJourneyId(tokenHash);
}

function validUuid(value: string, field: string): string {
    if (!UUID_PATTERN.test(value)) throw new Error(`LANDING_LEAD_${field}_INVALID`);
    return value.toLowerCase();
}

function rpcRow(data: unknown, label: string): Record<string, unknown> | null {
    if (Array.isArray(data)) {
        if (data.length === 0) return null;
        if (data.length !== 1 || !data[0] || typeof data[0] !== 'object') {
            throw new Error(`LANDING_LEAD_PERSISTENCE_ERROR:${label}`);
        }
        return data[0] as Record<string, unknown>;
    }
    if (data && typeof data === 'object') return data as Record<string, unknown>;
    return null;
}

function throwRpc(error: { message?: string; code?: string } | null, operation: string): never {
    if (error?.message === 'LANDING_LEAD_JOURNEY_CLAIM_CONFLICT') {
        throw new Error('LANDING_LEAD_JOURNEY_CLAIM_CONFLICT');
    }
    if (error?.message === 'LANDING_LEAD_CAPTURE_MISMATCH') {
        throw new LandingLeadCaptureMismatchError();
    }
    throw new Error(`LANDING_LEAD_PERSISTENCE_ERROR:${operation}`);
}

function normalizeInstagramId(value: string): string {
    const normalized = value.trim().toLowerCase();
    if (!INSTAGRAM_PATTERN.test(normalized)) throw new Error('LANDING_LEAD_INSTAGRAM_INVALID');
    return normalized;
}

export async function createOrReplayLandingLeadCapture(
    client: LandingLeadJourneyRpcClient,
    input: {
        journeyId: string;
        instagramId: string;
        inputContext: 'target' | 'excluded';
        anonymousPrincipalHash: string;
        captureTokenHash: string;
    },
): Promise<LandingLeadJourneyClaim> {
    const journeyId = validUuid(input.journeyId, 'JOURNEY');
    const instagramId = normalizeInstagramId(input.instagramId);
    if (input.inputContext !== 'target') throw new Error('LANDING_LEAD_CAPTURE_CONTEXT_INVALID');
    if (!/^[a-f0-9]{64}$/.test(input.anonymousPrincipalHash)) throw new Error('LANDING_LEAD_PRINCIPAL_HASH_INVALID');
    if (!/^[a-f0-9]{64}$/.test(input.captureTokenHash)) throw new Error('LANDING_LEAD_CAPTURE_HASH_INVALID');
    const result = await client.rpc('create_or_replay_landing_lead_capture', {
        p_journey_id: journeyId,
        p_instagram_id: instagramId,
        p_input_context: input.inputContext,
        p_anonymous_principal_hash: input.anonymousPrincipalHash,
        p_capture_token_hash: input.captureTokenHash,
    });
    if (result.error) throwRpc(result.error, 'capture');
    const row = rpcRow(result.data, 'capture');
    if (!row || typeof row.journey_id !== 'string' || typeof row.created !== 'boolean') {
        throw new Error('LANDING_LEAD_PERSISTENCE_ERROR:capture');
    }
    const returnedJourneyId = validUuid(String(row.journey_id), 'JOURNEY');
    if (returnedJourneyId !== journeyId) throw new LandingLeadCaptureMismatchError();
    return {
        journeyId: returnedJourneyId,
        tokenHash: input.captureTokenHash,
        mappingStatus: 'anonymous_device',
        created: row.created,
    };
}

export type LandingLeadBindingResult = Readonly<{
    bound: true;
    repaired: boolean;
    journeyId: string;
}>;

export async function captureAndBindLandingLeadJourney(
    client: LandingLeadJourneyRpcClient,
    input: {
        preflightId: string;
        targetInstagramId: string;
        landingCaptureToken?: string | null;
        anonymousDeviceId?: string | null;
        authUserId?: string | null;
        secret?: string;
        env?: Record<string, string | undefined>;
    },
): Promise<LandingLeadBindingResult> {
    const preflightId = validUuid(input.preflightId, 'PREFLIGHT');
    const instagramId = normalizeInstagramId(input.targetInstagramId);
    const deviceId = input.anonymousDeviceId?.trim();
    if (!deviceId) throw new Error('LANDING_LEAD_DEVICE_REQUIRED');
    const secret = input.secret ?? landingLeadCaptureSecret(input.env);
    const anonymousPrincipalHash = deriveAnonymousPrincipalHash(deviceId, secret);
    const requestedToken = input.landingCaptureToken?.trim() || null;
    // Include only the derived principal in deterministic repair seeds. This
    // keeps same-device retries idempotent while preventing a different
    // browser from replaying the prior browser's repair journey.
    const deterministicSeed = `preflight:${preflightId}:${anonymousPrincipalHash}`;
    const retrySeed = `${deterministicSeed}:repair`;
    const deterministicToken = createCaptureToken(deviceId, secret, deterministicSeed).token;
    let repaired = false;

    const persistCapture = async (token: string): Promise<LandingLeadJourneyClaim> => {
        const parsed = readCaptureToken(token, secret);
        if (!parsed) throw new LandingLeadCaptureMismatchError();
        return createOrReplayLandingLeadCapture(client, {
            journeyId: captureTokenJourneyId(parsed.tokenHash),
            instagramId,
            inputContext: 'target',
            anonymousPrincipalHash,
            captureTokenHash: parsed.tokenHash,
        });
    };

    let captured: LandingLeadJourneyClaim;
    try {
        captured = await persistCapture(
            requestedToken ?? deterministicToken,
        );
    } catch (error) {
        if (!(error instanceof LandingLeadCaptureMismatchError)) throw error;
        // A stale handoff must never be rebound to a different account, device,
        // or context. Create a fresh opaque capture and bind that exact target.
        repaired = true;
        captured = await persistCapture(createCaptureToken(deviceId, secret, retrySeed).token);
    }

    const bound = await bindLandingLeadJourneyToPreflight(
        client,
        captured.journeyId,
        preflightId,
    );
    if (!bound) throw new Error('LANDING_LEAD_BINDING_FAILED');
    if (input.authUserId) {
        const claimed = await claimLandingLeadJourney(
            client,
            captured.journeyId,
            input.authUserId,
        );
        if (!claimed) throw new Error('LANDING_LEAD_CLAIM_FAILED');
    }
    return { bound: true, repaired, journeyId: captured.journeyId };
}

export async function bindLandingLeadJourneyToPreflight(
    client: LandingLeadJourneyRpcClient,
    journeyId: string,
    preflightId: string,
): Promise<boolean> {
    const result = await client.rpc('bind_landing_lead_journey_to_preflight', {
        p_journey_id: validUuid(journeyId, 'JOURNEY'),
        p_source_preflight_id: validUuid(preflightId, 'PREFLIGHT'),
    });
    if (result.error) throwRpc(result.error, 'bind');
    return result.data === true;
}

export async function claimLandingLeadJourney(
    client: LandingLeadJourneyRpcClient,
    journeyId: string,
    userId: string,
): Promise<boolean> {
    const result = await client.rpc('claim_landing_lead_journey', {
        p_journey_id: validUuid(journeyId, 'JOURNEY'),
        p_user_id: validUuid(userId, 'USER'),
    });
    if (result.error) throwRpc(result.error, 'claim');
    return result.data === true;
}

export async function unlinkLandingLeadJourneyAfterDeletion(
    client: LandingLeadJourneyRpcClient,
    subjectId: string,
): Promise<boolean> {
    const result = await client.rpc('unlink_landing_lead_journey_after_deletion', {
        p_subject_id: validUuid(subjectId, 'SUBJECT'),
    });
    if (result.error) throwRpc(result.error, 'unlink');
    return result.data === true;
}

type InternalAdminRow = {
    instagramId: unknown;
    inputContext: unknown;
    mappingStatus: unknown;
    rowCountInJourney: unknown;
    firstSeenAt: unknown;
    lastSeenAt: unknown;
    cursorCreatedAt: unknown;
    cursorId: unknown;
};

function cursorSecret(env: Record<string, string | undefined> = process.env): string {
    return secretFor(env);
}

function encodeAdminCursor(createdAt: string, id: string, secret: string): string {
    const payload = `${LANDING_LEAD_CURSOR_DOMAIN}\0${createdAt}\0${id}`;
    const signature = createHmac('sha256', secret).update(payload).digest('base64url');
    return Buffer.from(JSON.stringify({ v: 1, createdAt, id, signature }), 'utf8').toString('base64url');
}

function decodeAdminCursor(cursor: string, secret: string): { createdAt: string; id: string } {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (parsed.v !== 1 || typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string' || typeof parsed.signature !== 'string') {
            throw new Error('invalid');
        }
        const expected = createHmac('sha256', secret)
            .update(`${LANDING_LEAD_CURSOR_DOMAIN}\0${parsed.createdAt}\0${parsed.id}`)
            .digest('base64url');
        if (expected !== parsed.signature || !UUID_PATTERN.test(parsed.id)) throw new Error('invalid');
        z.string().datetime({ offset: true }).parse(parsed.createdAt);
        return { createdAt: parsed.createdAt, id: parsed.id };
    } catch {
        throw new LandingLeadCursorInvalidError();
    }
}

export async function loadLandingLeadAdminProjection(
    client: LandingLeadJourneyRpcClient,
    input: z.input<typeof adminProjectionInputSchema>,
    env: Record<string, string | undefined> = process.env,
): Promise<LandingLeadAdminProjection> {
    const parsed = adminProjectionInputSchema.parse(input);
    const cursor = parsed.cursor ? decodeAdminCursor(parsed.cursor, cursorSecret(env)) : null;
    const result = await client.rpc('load_landing_lead_admin_projection', {
        p_input_context: parsed.context ?? null,
        p_mapping_status: parsed.mappingStatus ?? null,
        p_instagram_id: parsed.instagramId ?? null,
        p_from: parsed.from ?? null,
        p_to: parsed.to ?? null,
        p_cursor_created_at: cursor?.createdAt ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_page_size: parsed.pageSize + 1,
    });
    if (result.error) throwRpc(result.error, 'admin_projection');
    const payload = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
        ? result.data as { rows?: unknown }
        : { rows: result.data };
    const rows = Array.isArray(payload.rows) ? payload.rows as InternalAdminRow[] : [];
    const hasNext = rows.length > parsed.pageSize;
    const visibleRows = rows.slice(0, parsed.pageSize).map(row => landingLeadListRowSchema.parse({
        instagramId: row.instagramId,
        inputContext: row.inputContext,
        mappingStatus: row.mappingStatus,
        rowCountInJourney: Math.min(100, Number(row.rowCountInJourney)),
        firstSeenAt: String(row.firstSeenAt),
        lastSeenAt: String(row.lastSeenAt),
    }));
    const last = hasNext ? rows[parsed.pageSize - 1] : null;
    const nextCursor = last && typeof last.cursorCreatedAt === 'string' && typeof last.cursorId === 'string'
        ? encodeAdminCursor(last.cursorCreatedAt, last.cursorId, cursorSecret(env))
        : null;
    return { rows: visibleRows, nextCursor };
}
