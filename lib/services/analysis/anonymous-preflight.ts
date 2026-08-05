import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    launchStatusSnapshot,
    planCatalogSnapshot,
    preflightPolicyVersions,
    pricingSnapshot,
    storedPreflightFromRow,
    type CreatedPreflight,
    type StoredPreflight,
} from './preflight';
import {
    hashAnonymousPreflightClaim,
    readAnonymousPreflightClaim,
} from './anonymous-preflight-claim';
import { PLAN_PRICING_VERSION } from '@/lib/domain/analysis/plan-catalog';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;

export const ANONYMOUS_PREFLIGHT_DATABASE_NAMES = Object.freeze({
    budgetRpc: 'reserve_anonymous_preflight_budget',
    createRpc: 'create_anonymous_analysis_v2_preflight',
    readRpc: 'read_anonymous_analysis_v2_preflight_public',
    claimRpc: 'claim_anonymous_analysis_v2_preflight',
    exclusionRpc: 'set_anonymous_analysis_v2_preflight_exclusion',
    reserveDispatchRpc: 'reserve_anonymous_analysis_v2_preflight_dispatch',
    markDispatchedRpc: 'mark_anonymous_analysis_v2_preflight_dispatched',
});

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnonymousPreflightClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

interface ServiceOptions {
    client?: AnonymousPreflightClient;
    env?: Record<string, string | undefined>;
}

export class AnonymousPreflightClaimInvalidError extends Error {
    constructor() {
        super('ANONYMOUS_PREFLIGHT_CLAIM_INVALID');
        this.name = 'AnonymousPreflightClaimInvalidError';
    }
}

export class AnonymousPreflightIdempotencyConflictError extends Error {
    constructor() {
        super('ANONYMOUS_PREFLIGHT_IDEMPOTENCY_CONFLICT');
        this.name = 'AnonymousPreflightIdempotencyConflictError';
    }
}

export class AnonymousPreflightRateLimitedError extends Error {
    constructor(readonly reason: 'daily_cap' | 'rate_limited') {
        super('ANONYMOUS_PREFLIGHT_RATE_LIMITED');
        this.name = 'AnonymousPreflightRateLimitedError';
    }
}

function rpcRow(data: unknown, label: string): Record<string, unknown> | null {
    if (Array.isArray(data)) {
        if (data.length === 0) return null;
        if (data.length !== 1 || !data[0] || typeof data[0] !== 'object') {
            throw new Error(`ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:${label}`);
        }
        return data[0] as Record<string, unknown>;
    }
    if (data && typeof data === 'object') return data as Record<string, unknown>;
    if (data === null) return null;
    throw new Error(`ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:${label}`);
}

function rpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANONYMOUS_PREFLIGHT_IDEMPOTENCY_CONFLICT') {
        throw new AnonymousPreflightIdempotencyConflictError();
    }
    if (
        error.message === 'ANONYMOUS_PREFLIGHT_CLAIM_INVALID'
        || error.message === 'ANONYMOUS_PREFLIGHT_NOT_FOUND'
    ) {
        throw new AnonymousPreflightClaimInvalidError();
    }
    throw new Error(`ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:${operation}`);
}

function requireClaim(
    token: string,
    env: Record<string, string | undefined>,
): { tokenHash: string; expiresAt: string } {
    const parsed = readAnonymousPreflightClaim(token, { env });
    if (!parsed) throw new AnonymousPreflightClaimInvalidError();
    return {
        tokenHash: hashAnonymousPreflightClaim(token),
        expiresAt: parsed.expiresAt,
    };
}

function requireUuid(value: string, field: string): string {
    if (!UUID_PATTERN.test(value)) throw new Error(`ANONYMOUS_PREFLIGHT_INVALID_${field}`);
    return value.toLowerCase();
}

function requireHash(value: string, field: string): string {
    if (!HASH_PATTERN.test(value)) throw new Error(`ANONYMOUS_PREFLIGHT_INVALID_${field}`);
    return value;
}

function requireIdempotency(value: string): string {
    if (!IDEMPOTENCY_PATTERN.test(value)) {
        throw new Error('ANONYMOUS_PREFLIGHT_INVALID_IDEMPOTENCY');
    }
    return value;
}

function requireCreatedStatus(value: unknown): CreatedPreflight['status'] {
    if (
        value !== 'pending'
        && value !== 'processing'
        && value !== 'ready'
        && value !== 'blocked'
        && value !== 'expired'
        && value !== 'consumed'
    ) throw new Error('ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:status');
    return value;
}

export interface CreateAnonymousPreflightInput {
    targetInstagramId: string;
    targetInputHash: string;
    idempotencyKey: string;
    claimToken: string;
    env?: Record<string, string | undefined>;
}

export interface CreatedAnonymousPreflight extends CreatedPreflight {
    claimToken: string;
    claimExpiresAt: string;
}

export async function createAnonymousAnalysisV2Preflight(
    input: CreateAnonymousPreflightInput,
    options: ServiceOptions = {},
): Promise<CreatedAnonymousPreflight> {
    const env = input.env ?? options.env ?? process.env;
    const claim = requireClaim(input.claimToken, env);
    const targetInputHash = requireHash(input.targetInputHash, 'TARGET_HASH');
    const idempotencyKey = requireIdempotency(input.idempotencyKey);
    const client = options.client ?? supabaseAdmin;
    const { data, error } = await client.rpc(ANONYMOUS_PREFLIGHT_DATABASE_NAMES.createRpc, {
        p_target_instagram_id: input.targetInstagramId,
        p_target_input_hash: targetInputHash,
        p_idempotency_key: idempotencyKey,
        p_claim_token_hash: claim.tokenHash,
        p_claim_expires_at: claim.expiresAt,
        p_launch_status_snapshot: launchStatusSnapshot(),
        p_plan_catalog_snapshot: planCatalogSnapshot(),
        p_pricing_version: PLAN_PRICING_VERSION,
        p_pricing_snapshot: pricingSnapshot(),
        p_policy_versions_snapshot: preflightPolicyVersions('production'),
    });
    if (error) rpcError(error, 'create');
    const row = rpcRow(data, 'create');
    if (!row) throw new Error('ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:create');
    return {
        preflightId: requireUuid(String(row.preflight_id), 'ID'),
        expiresAt: String(row.expires_at),
        created: row.created === true,
        status: requireCreatedStatus(row.preflight_status),
        claimToken: input.claimToken,
        claimExpiresAt: claim.expiresAt,
    };
}

export async function readAnonymousAnalysisV2Preflight(
    preflightId: string,
    claimToken: string,
    options: ServiceOptions = {},
): Promise<StoredPreflight | null> {
    const id = requireUuid(preflightId, 'ID');
    const env = options.env ?? process.env;
    const claim = requireClaim(claimToken, env);
    const client = options.client ?? supabaseAdmin;
    const { data, error } = await client.rpc(ANONYMOUS_PREFLIGHT_DATABASE_NAMES.readRpc, {
        p_preflight_id: id,
        p_claim_token_hash: claim.tokenHash,
    });
    if (error) rpcError(error, 'read');
    const row = rpcRow(data, 'read');
    // The anonymous RPC deliberately omits the raw provider image URL. Keep the
    // shared row parser strict without widening the public projection.
    return row
        ? storedPreflightFromRow({ ...row, target_profile_image_url: null })
        : null;
}

export async function claimAnonymousAnalysisV2Preflight(
    preflightId: string,
    claimToken: string,
    userId: string,
    options: ServiceOptions = {},
): Promise<boolean> {
    const id = requireUuid(preflightId, 'ID');
    const ownerId = requireUuid(userId, 'USER');
    const env = options.env ?? process.env;
    const claim = requireClaim(claimToken, env);
    const client = options.client ?? supabaseAdmin;
    const { data, error } = await client.rpc(ANONYMOUS_PREFLIGHT_DATABASE_NAMES.claimRpc, {
        p_preflight_id: id,
        p_claim_token_hash: claim.tokenHash,
        p_user_id: ownerId,
    });
    if (error) rpcError(error, 'claim');
    const row = rpcRow(data, 'claim');
    if (!row || typeof row.claimed !== 'boolean') {
        throw new Error('ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:claim');
    }
    return row.claimed;
}

export async function setAnonymousAnalysisV2PreflightExclusion(input: {
    preflightId: string;
    claimToken: string;
    decision: 'exclude' | 'skip';
    excludedInstagramId: string | null;
}, options: ServiceOptions = {}): Promise<boolean> {
    const id = requireUuid(input.preflightId, 'ID');
    const env = options.env ?? process.env;
    const claim = requireClaim(input.claimToken, env);
    const client = options.client ?? supabaseAdmin;
    const { data, error } = await client.rpc(ANONYMOUS_PREFLIGHT_DATABASE_NAMES.exclusionRpc, {
        p_preflight_id: id,
        p_claim_token_hash: claim.tokenHash,
        p_decision: input.decision,
        p_excluded_instagram_id: input.excludedInstagramId,
    });
    if (error) rpcError(error, 'exclusion');
    if (typeof data !== 'boolean') {
        throw new Error('ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:exclusion');
    }
    return data;
}

export interface AnonymousDispatchReservation {
    shouldEnqueue: boolean;
    generation: number;
    reservationToken: string | null;
    status: CreatedPreflight['status'] | 'missing';
}

export async function reserveAnonymousAnalysisV2PreflightDispatch(
    preflightId: string,
    claimToken: string,
    options: ServiceOptions = {},
): Promise<AnonymousDispatchReservation> {
    const id = requireUuid(preflightId, 'ID');
    const env = options.env ?? process.env;
    const claim = requireClaim(claimToken, env);
    const client = options.client ?? supabaseAdmin;
    const dispatchToken = randomUUID();
    const { data, error } = await client.rpc(
        ANONYMOUS_PREFLIGHT_DATABASE_NAMES.reserveDispatchRpc,
        {
            p_preflight_id: id,
            p_claim_token_hash: claim.tokenHash,
            p_dispatch_token: dispatchToken,
        },
    );
    if (error) rpcError(error, 'dispatch reserve');
    const row = rpcRow(data, 'dispatch reserve');
    if (
        !row
        || typeof row.should_enqueue !== 'boolean'
        || !Number.isSafeInteger(row.dispatch_generation)
        || typeof row.preflight_status !== 'string'
    ) throw new Error('ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:dispatch reserve');
    const reservationToken = row.reservation_token === null
        ? null
        : requireUuid(String(row.reservation_token), 'DISPATCH_TOKEN');
    return {
        shouldEnqueue: row.should_enqueue,
        generation: row.dispatch_generation as number,
        reservationToken,
        status: row.preflight_status as AnonymousDispatchReservation['status'],
    };
}

export async function markAnonymousAnalysisV2PreflightDispatched(input: {
    preflightId: string;
    claimToken: string;
    generation: number;
    reservationToken: string;
}, options: ServiceOptions = {}): Promise<boolean> {
    const id = requireUuid(input.preflightId, 'ID');
    const reservationToken = requireUuid(input.reservationToken, 'DISPATCH_TOKEN');
    const env = options.env ?? process.env;
    const claim = requireClaim(input.claimToken, env);
    const client = options.client ?? supabaseAdmin;
    const { data, error } = await client.rpc(
        ANONYMOUS_PREFLIGHT_DATABASE_NAMES.markDispatchedRpc,
        {
            p_preflight_id: id,
            p_claim_token_hash: claim.tokenHash,
            p_dispatch_generation: input.generation,
            p_dispatch_token: reservationToken,
        },
    );
    if (error) rpcError(error, 'dispatch mark');
    if (typeof data !== 'boolean') {
        throw new Error('ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:dispatch mark');
    }
    return data;
}

export async function reserveAnonymousPreflightBudget(input: {
    ipHash: string;
    deviceHash: string;
    targetInputHash: string;
    dailyLimit?: number;
    client?: AnonymousPreflightClient;
}): Promise<{ allowed: boolean; reason: 'accepted' | 'daily_cap' | 'rate_limited'; dailyCount: number }> {
    requireHash(input.ipHash, 'IP_HASH');
    requireHash(input.deviceHash, 'DEVICE_HASH');
    requireHash(input.targetInputHash, 'TARGET_HASH');
    const { data, error } = await (input.client ?? supabaseAdmin).rpc(
        ANONYMOUS_PREFLIGHT_DATABASE_NAMES.budgetRpc,
        {
            p_ip_hash: input.ipHash,
            p_device_hash: input.deviceHash,
            p_target_input_hash: input.targetInputHash,
            p_daily_limit: input.dailyLimit ?? 300,
        },
    );
    if (error) rpcError(error, 'budget');
    const row = rpcRow(data, 'budget');
    if (
        !row
        || typeof row.allowed !== 'boolean'
        || !['accepted', 'daily_cap', 'rate_limited'].includes(String(row.reason))
        || !Number.isSafeInteger(row.daily_count)
    ) throw new Error('ANONYMOUS_PREFLIGHT_PERSISTENCE_ERROR:budget');
    return {
        allowed: row.allowed,
        reason: row.reason as 'accepted' | 'daily_cap' | 'rate_limited',
        dailyCount: row.daily_count as number,
    };
}

export function preflightStatusFromAnonymousRow(
    row: Record<string, unknown>,
): StoredPreflight {
    return storedPreflightFromRow(row);
}
