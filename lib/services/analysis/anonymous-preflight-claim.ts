import {
    createHash,
    createHmac,
    randomBytes as nodeRandomBytes,
    timingSafeEqual,
} from 'node:crypto';

const TOKEN_VERSION = 'v1';
const CLAIM_TTL_SECONDS = 10 * 60;
const MIN_SECRET_LENGTH = 32;
const TOKEN_PATTERN = /^v1\.([A-Za-z0-9_-]{16,256})\.([A-Za-z0-9_-]{40,128})$/;

interface ClaimPayload {
    v: 1;
    exp: number;
    nonce: string;
}

interface ClaimOptions {
    nowMs?: number;
    env?: Record<string, string | undefined>;
    randomBytes?: (size: number) => Buffer;
}

interface ReadClaimOptions {
    nowMs?: number;
    env?: Record<string, string | undefined>;
}

export interface AnonymousPreflightClaim {
    token: string;
    tokenHash: string;
    expiresAt: string;
}

function secretFromEnv(
    env: Record<string, string | undefined> = process.env,
): string {
    const secret = env.ANONYMOUS_PREFLIGHT_CLAIM_SECRET?.trim() ?? '';
    if (secret.length < MIN_SECRET_LENGTH) {
        throw new Error('ANONYMOUS_PREFLIGHT_CLAIM_CONFIG_ERROR');
    }
    return secret;
}

function encode(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}

function decode(value: string): string | null {
    try {
        const decoded = Buffer.from(value, 'base64url').toString('utf8');
        return decoded && decoded.length <= 1024 ? decoded : null;
    } catch {
        return null;
    }
}

function signature(input: string, secret: string): string {
    return createHmac('sha256', secret).update(input, 'utf8').digest('base64url');
}

function safeNowMs(value: number | undefined): number {
    return Number.isSafeInteger(value) && value !== undefined ? value : Date.now();
}

function parsePayload(value: string): ClaimPayload | null {
    const decoded = decode(value);
    if (!decoded) return null;
    try {
        const parsed: unknown = JSON.parse(decoded);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
        const candidate = parsed as Record<string, unknown>;
        if (
            candidate.v !== 1
            || !Number.isSafeInteger(candidate.exp)
            || typeof candidate.nonce !== 'string'
            || !/^[A-Za-z0-9_-]{24,128}$/.test(candidate.nonce)
        ) return null;
        return {
            v: 1,
            exp: candidate.exp as number,
            nonce: candidate.nonce,
        };
    } catch {
        return null;
    }
}

function expiresAtFromSeconds(exp: number): string {
    return new Date(exp * 1000).toISOString();
}

export function createAnonymousPreflightClaim({
    nowMs,
    env = process.env,
    randomBytes = nodeRandomBytes,
}: ClaimOptions = {}): AnonymousPreflightClaim {
    const now = safeNowMs(nowMs);
    const exp = Math.floor(now / 1000) + CLAIM_TTL_SECONDS;
    const payload = encode(JSON.stringify({
        v: 1,
        exp,
        nonce: randomBytes(24).toString('base64url'),
    } satisfies ClaimPayload));
    const signed = `${TOKEN_VERSION}.${payload}`;
    const token = `${signed}.${signature(signed, secretFromEnv(env))}`;
    return {
        token,
        tokenHash: hashAnonymousPreflightClaim(token),
        expiresAt: expiresAtFromSeconds(exp),
    };
}

export function hashAnonymousPreflightClaim(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readAnonymousPreflightClaim(
    token: string,
    { nowMs, env = process.env }: ReadClaimOptions = {},
): { expiresAt: string } | null {
    if (typeof token !== 'string' || token.length > 512) return null;
    const match = TOKEN_PATTERN.exec(token);
    if (!match) return null;
    const payload = parsePayload(match[1]);
    if (!payload) return null;
    if (payload.exp * 1000 <= safeNowMs(nowMs)) return null;

    const expected = Buffer.from(signature(`${TOKEN_VERSION}.${match[1]}`, secretFromEnv(env)));
    const actual = Buffer.from(match[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { expiresAt: expiresAtFromSeconds(payload.exp) };
}

export function anonymousRateLimitSecret(
    env: Record<string, string | undefined> = process.env,
): string {
    return secretFromEnv(env);
}

export function hashAnonymousRateLimitValue(
    value: string,
    kind: 'ip' | 'device',
    env: Record<string, string | undefined> = process.env,
): string {
    const bounded = value.trim().slice(0, 256);
    if (!bounded) throw new Error('ANONYMOUS_PREFLIGHT_RATE_LIMIT_INPUT_ERROR');
    return createHmac('sha256', anonymousRateLimitSecret(env))
        .update(`anonymous-preflight-rate:${kind}:v1:${bounded}`, 'utf8')
        .digest('hex');
}

export function requestClientIp(request: Request): string {
    const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    const real = request.headers.get('x-real-ip')?.trim();
    return (forwarded || real || 'unknown').slice(0, 256);
}
