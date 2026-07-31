import { createHmac } from 'node:crypto';
import { canonicalizeAnalysisV2ProgressUsername } from './progress-username';

export const PREFLIGHT_IDENTITY_HMAC_SECRET_ENV =
    'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET';

const HMAC_DOMAIN = 'yeosachin:analysis-v2:preflight-target:v1\0';
const PROGRESS_CANDIDATE_HMAC_DOMAIN =
    'yeosachin:analysis-v2:progress-candidate:v1\0';
const MINIMUM_HMAC_KEY_BYTES = 32;
const BASE64_SECRET_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

function decodeSecret(value: string): Buffer {
    const trimmed = value.trim();
    if (!BASE64_SECRET_PATTERN.test(trimmed) || trimmed.length % 4 === 1) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: preflight identity HMAC secret must be base64 encoded.'
        );
    }
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoded = Buffer.from(normalized + padding, 'base64');
    if (
        decoded.length < MINIMUM_HMAC_KEY_BYTES
        || decoded.toString('base64').replace(/=+$/, '') !== normalized
    ) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: preflight identity HMAC secret must contain at least 32 random bytes.'
        );
    }
    return decoded;
}

export function assertPreflightIdentityHmacConfiguration(
    env: Record<string, string | undefined> = process.env
): void {
    const value = env[PREFLIGHT_IDENTITY_HMAC_SECRET_ENV];
    if (!value) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: preflight identity HMAC secret is required.'
        );
    }
    decodeSecret(value);
}

export function preflightTargetInputHash(
    username: string,
    env: Record<string, string | undefined> = process.env
): string {
    const value = env[PREFLIGHT_IDENTITY_HMAC_SECRET_ENV];
    if (!value) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: preflight identity HMAC secret is required.'
        );
    }
    const key = decodeSecret(value);
    const canonicalUsername = username.trim().toLowerCase();
    return createHmac('sha256', key)
        .update(HMAC_DOMAIN, 'utf8')
        .update(canonicalUsername, 'utf8')
        .digest('hex');
}

/** Stable opaque identity for correlating one candidate across progress heartbeats. */
export function analysisV2ProgressCandidateKey(
    requestId: string,
    username: string,
    env: Record<string, string | undefined> = process.env
): string {
    const value = env[PREFLIGHT_IDENTITY_HMAC_SECRET_ENV];
    if (!value) {
        throw new Error(
            'PREFLIGHT_TASKS_CONFIG_ERROR: preflight identity HMAC secret is required.'
        );
    }
    const key = decodeSecret(value);
    const canonicalRequestId = requestId.trim().toLowerCase();
    const canonicalUsername = canonicalizeAnalysisV2ProgressUsername(username);
    return createHmac('sha256', key)
        .update(PROGRESS_CANDIDATE_HMAC_DOMAIN, 'utf8')
        .update(canonicalRequestId, 'utf8')
        .update('\0', 'utf8')
        .update(canonicalUsername, 'utf8')
        .digest('hex');
}
