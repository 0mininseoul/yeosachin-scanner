import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const PG_REVIEW_PATH = '/login/pg-review';
export const PG_REVIEW_EMAIL = 'pg-review@yeosachin.com';
export const PG_REVIEW_COOKIE = 'pg-review-session';
export const PG_REVIEW_SESSION_SECONDS = 60 * 60 * 8;

export function pgReviewCredential() {
    const [passwordHash, sessionKey, ...extra] = process.env.PG_REVIEW_CREDENTIAL?.split('.') ?? [];
    if (extra.length || !/^[a-f0-9]{64}$/.test(passwordHash ?? '')
        || !/^[a-f0-9]{64}$/.test(sessionKey ?? '')) return null;

    return {
        passwordHash: Buffer.from(passwordHash, 'hex'),
        sessionKey: Buffer.from(sessionKey, 'hex'),
    };
}

export function matchesPgReviewPassword(password: string, expectedHash: Buffer) {
    const actualHash = createHash('sha256').update(password, 'utf8').digest();
    const reviewerMatches = timingSafeEqual(actualHash, expectedHash);
    const ownerHash = process.env.PG_REVIEW_OWNER_PASSWORD_HASH?.trim() ?? '';
    const ownerMatches = /^[a-f0-9]{64}$/.test(ownerHash)
        && timingSafeEqual(actualHash, Buffer.from(ownerHash, 'hex'));
    return reviewerMatches || ownerMatches;
}

function signExpiry(expiry: string, key: Buffer) {
    return createHmac('sha256', key).update(`pg-review-session-v1:${expiry}`).digest();
}

export function createPgReviewSession(key: Buffer, now = Date.now()) {
    const expiry = String(Math.floor(now / 1000) + PG_REVIEW_SESSION_SECONDS);
    return `${expiry}.${signExpiry(expiry, key).toString('hex')}`;
}

export function isPgReviewSession(session: string | undefined, key: Buffer, now = Date.now()) {
    if (!session || !/^\d{1,12}\.[a-f0-9]{64}$/.test(session)) return false;

    const [expiry, signature] = session.split('.');
    return Number(expiry) > Math.floor(now / 1000)
        && timingSafeEqual(Buffer.from(signature, 'hex'), signExpiry(expiry, key));
}
