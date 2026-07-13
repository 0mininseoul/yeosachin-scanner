import { createHmac, timingSafeEqual } from 'node:crypto';
import { PLAN_IDS, type PlanId } from '@/lib/domain/analysis/plan-catalog';

const TOKEN_PREFIX = 'analysis-test-entitlement-v1';
const DEFAULT_TTL_SECONDS = 10 * 60;
const MAX_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/;

export interface AnalysisTestEntitlementPayload {
    version: 1;
    preflightId: string;
    userId: string;
    planId: PlanId;
    expiresAt: number;
    nonce: string;
}

export interface CreateAnalysisTestEntitlementInput {
    preflightId: string;
    userId: string;
    planId: PlanId;
    nonce: string;
    ttlSeconds?: number;
}

export interface AnalysisTestEntitlementOptions {
    nowMs?: number;
    secret?: string;
}

export interface ExpectedAnalysisTestEntitlement {
    preflightId: string;
    userId: string;
    planId: PlanId;
}

export function analysisTestEntitlementsEnabled(
    env: Record<string, string | undefined> = process.env
): boolean {
    const normalized = env.ANALYSIS_TEST_ENTITLEMENTS_ENABLED?.trim().toLowerCase();
    if (!normalized || ['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    throw new Error(
        'ANALYSIS_TEST_ENTITLEMENTS_ENABLED must be a boolean feature flag.'
    );
}

export function assertAnalysisTestEntitlementConfiguration(
    env: Record<string, string | undefined> = process.env
): void {
    if (!analysisTestEntitlementsEnabled(env)) {
        throw new Error('Analysis test entitlements are disabled.');
    }
    signingSecret(env.ANALYSIS_TEST_ENTITLEMENT_SECRET);
}

function signingSecret(override?: string): string {
    const secret = override ?? process.env.ANALYSIS_TEST_ENTITLEMENT_SECRET;
    const decoded = secret && /^[A-Za-z0-9_-]{43}$/.test(secret)
        ? Buffer.from(secret, 'base64url')
        : null;
    if (
        !secret
        || !decoded
        || decoded.length !== 32
        || decoded.toString('base64url') !== secret
    ) {
        throw new Error(
            'ANALYSIS_TEST_ENTITLEMENT_SECRET must be the canonical base64url encoding '
            + 'of exactly 32 random bytes.'
        );
    }
    return secret;
}

function normalizedUuid(value: string, field: string): string {
    const normalized = value.trim().toLowerCase();
    if (!UUID_PATTERN.test(normalized)) {
        throw new Error(`ANALYSIS_TEST_ENTITLEMENT_ERROR: invalid ${field}.`);
    }
    return normalized;
}

function validatedPlanId(value: unknown): PlanId {
    if (typeof value !== 'string' || !PLAN_IDS.includes(value as PlanId)) {
        throw new Error('ANALYSIS_TEST_ENTITLEMENT_ERROR: invalid planId.');
    }
    return value as PlanId;
}

function canonicalPayload(payload: AnalysisTestEntitlementPayload): string {
    return JSON.stringify({
        v: payload.version,
        p: payload.preflightId,
        u: payload.userId,
        plan: payload.planId,
        exp: payload.expiresAt,
        n: payload.nonce,
    });
}

function signature(payloadSegment: string, secret: string): string {
    return createHmac('sha256', secret)
        .update(`${TOKEN_PREFIX}\n${payloadSegment}`)
        .digest('base64url');
}

function parsePayload(payloadSegment: string): AnalysisTestEntitlementPayload | null {
    let value: unknown;
    try {
        value = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
        keys.length !== 6
        || !['v', 'p', 'u', 'plan', 'exp', 'n'].every(key => (
            Object.prototype.hasOwnProperty.call(record, key)
        ))
        || record.v !== 1
        || typeof record.p !== 'string'
        || typeof record.u !== 'string'
        || typeof record.exp !== 'number'
        || !Number.isSafeInteger(record.exp)
        || typeof record.n !== 'string'
    ) {
        return null;
    }

    let planId: PlanId;
    let preflightId: string;
    let userId: string;
    try {
        planId = validatedPlanId(record.plan);
        preflightId = normalizedUuid(record.p, 'preflightId');
        userId = normalizedUuid(record.u, 'userId');
    } catch {
        return null;
    }
    if (preflightId !== record.p || userId !== record.u || !NONCE_PATTERN.test(record.n)) {
        return null;
    }

    const payload: AnalysisTestEntitlementPayload = {
        version: 1,
        preflightId,
        userId,
        planId,
        expiresAt: record.exp,
        nonce: record.n,
    };
    const canonicalSegment = Buffer.from(canonicalPayload(payload), 'utf8').toString('base64url');
    return canonicalSegment === payloadSegment ? payload : null;
}

export function createAnalysisTestEntitlement(
    input: CreateAnalysisTestEntitlementInput,
    options: AnalysisTestEntitlementOptions = {}
): string {
    const ttlSeconds = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) {
        throw new RangeError(
            `ANALYSIS_TEST_ENTITLEMENT_ERROR: ttlSeconds must be between 1 and ${MAX_TTL_SECONDS}.`
        );
    }
    if (!NONCE_PATTERN.test(input.nonce)) {
        throw new Error('ANALYSIS_TEST_ENTITLEMENT_ERROR: invalid nonce.');
    }

    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    const payload: AnalysisTestEntitlementPayload = {
        version: 1,
        preflightId: normalizedUuid(input.preflightId, 'preflightId'),
        userId: normalizedUuid(input.userId, 'userId'),
        planId: validatedPlanId(input.planId),
        expiresAt: nowSeconds + ttlSeconds,
        nonce: input.nonce,
    };
    const payloadSegment = Buffer.from(canonicalPayload(payload), 'utf8').toString('base64url');
    return `v1.${payloadSegment}.${signature(payloadSegment, signingSecret(options.secret))}`;
}

export function verifyAnalysisTestEntitlement(
    token: string | null | undefined,
    expected: ExpectedAnalysisTestEntitlement,
    options: AnalysisTestEntitlementOptions = {}
): AnalysisTestEntitlementPayload | null {
    if (!token || token.length > 2_048 || token.trim() !== token) return null;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return null;

    let secret: string;
    try {
        secret = signingSecret(options.secret);
    } catch {
        return null;
    }
    const expectedSignature = Buffer.from(signature(match[1], secret));
    const suppliedSignature = Buffer.from(match[2]);
    if (
        suppliedSignature.length !== expectedSignature.length
        || !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
        return null;
    }

    const payload = parsePayload(match[1]);
    if (!payload) return null;
    const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
    if (
        payload.expiresAt < nowSeconds - CLOCK_SKEW_SECONDS
        || payload.expiresAt > nowSeconds + MAX_TTL_SECONDS + CLOCK_SKEW_SECONDS
    ) {
        return null;
    }

    let expectedPreflightId: string;
    let expectedUserId: string;
    try {
        expectedPreflightId = normalizedUuid(expected.preflightId, 'preflightId');
        expectedUserId = normalizedUuid(expected.userId, 'userId');
    } catch {
        return null;
    }
    return payload.preflightId === expectedPreflightId
        && payload.userId === expectedUserId
        && payload.planId === expected.planId
        ? payload
        : null;
}
