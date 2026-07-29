import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
} from 'node:crypto';
import type {
    AnalysisV2ResultImageKind,
    AnalysisV2ResultImageLocator,
} from '@/lib/services/media/image-proxy-token';

const SHARE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SEALED_VALUE_PATTERN = /^[A-Za-z0-9_-]{40,4096}$/;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

type CandidateImageLocator = AnalysisV2ResultImageLocator & {
    kind: Exclude<AnalysisV2ResultImageKind, 'target'>;
    candidateId: string;
};

function signingSecret(): string {
    const secret = process.env.IMAGE_PROXY_SIGNING_SECRET;
    if (!secret || secret.length < 32) {
        throw new Error(
            'IMAGE_PROXY_SIGNING_SECRET must contain at least 32 characters'
        );
    }
    return secret;
}

function encryptionKey(domain: string): Buffer {
    return createHash('sha256')
        .update(`${domain}\n`, 'utf8')
        .update(signingSecret(), 'utf8')
        .digest();
}

function aad(domain: string, shareToken: string): Buffer {
    return Buffer.from(`${domain}\n${shareToken}`, 'utf8');
}

function seal(
    domain: string,
    shareToken: string,
    payload: Buffer
): string {
    if (!SHARE_TOKEN_PATTERN.test(shareToken)) {
        throw new Error('INVALID_V2_SHARE_PRIVACY_INPUT');
    }
    const key = encryptionKey(domain);
    const nonce = createHmac('sha256', key)
        .update(shareToken, 'utf8')
        .update('\n', 'utf8')
        .update(payload)
        .digest()
        .subarray(0, NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(domain, shareToken));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return Buffer.concat([
        nonce,
        cipher.getAuthTag(),
        ciphertext,
    ]).toString('base64url');
}

function open(
    domain: string,
    shareToken: string,
    sealedValue: string
): Buffer | null {
    if (
        !SHARE_TOKEN_PATTERN.test(shareToken)
        || !SEALED_VALUE_PATTERN.test(sealedValue)
    ) {
        return null;
    }
    try {
        const sealed = Buffer.from(sealedValue, 'base64url');
        if (
            sealed.toString('base64url') !== sealedValue
            || sealed.length <= NONCE_BYTES + AUTH_TAG_BYTES
        ) {
            return null;
        }
        const decipher = createDecipheriv(
            'aes-256-gcm',
            encryptionKey(domain),
            sealed.subarray(0, NONCE_BYTES)
        );
        decipher.setAAD(aad(domain, shareToken));
        decipher.setAuthTag(
            sealed.subarray(NONCE_BYTES, NONCE_BYTES + AUTH_TAG_BYTES)
        );
        return Buffer.concat([
            decipher.update(sealed.subarray(NONCE_BYTES + AUTH_TAG_BYTES)),
            decipher.final(),
        ]);
    } catch {
        return null;
    }
}

export function maskSharedHandle(value: string): string {
    const characters = Array.from(value);
    return characters.slice(0, 2).join('')
        + '•'.repeat(Math.max(0, characters.length - 2));
}

export function maskSharedFullName(value: string | null): string | null {
    if (value === null) return null;
    return Array.from(value)
        .map(character => /\s/u.test(character) ? character : '•')
        .join('');
}

export function createV2SharedAccountKey(
    shareToken: string,
    kind: 'female' | 'private',
    instagramId: string
): string {
    if (
        !SHARE_TOKEN_PATTERN.test(shareToken)
        || !/^[A-Za-z0-9._]{1,30}$/.test(instagramId)
    ) {
        throw new Error('INVALID_V2_SHARE_PRIVACY_INPUT');
    }
    const key = encryptionKey('analysis-v2-share-account-key-v1');
    const digest = createHmac('sha256', key)
        .update(shareToken, 'utf8')
        .update('\n', 'utf8')
        .update(kind, 'utf8')
        .update('\n', 'utf8')
        .update(instagramId.toLowerCase(), 'utf8')
        .digest('base64url');
    return `account_${digest}`;
}

export function sealV2SharedImageLocator(
    shareToken: string,
    locator: CandidateImageLocator
): string {
    if (
        !['female', 'private'].includes(locator.kind)
        || !CANDIDATE_ID_PATTERN.test(locator.candidateId)
    ) {
        throw new Error('INVALID_V2_SHARE_PRIVACY_INPUT');
    }
    return seal(
        'analysis-v2-share-image-locator-v1',
        shareToken,
        Buffer.from(JSON.stringify({
            k: locator.kind,
            c: locator.candidateId,
        }), 'utf8')
    );
}

export function openV2SharedImageLocator(
    shareToken: string,
    sealedLocator: string
): Omit<CandidateImageLocator, 'requestId'> | null {
    const payload = open(
        'analysis-v2-share-image-locator-v1',
        shareToken,
        sealedLocator
    );
    if (!payload || payload.length > 256) return null;
    try {
        const value = JSON.parse(payload.toString('utf8')) as unknown;
        if (
            !value
            || typeof value !== 'object'
            || Array.isArray(value)
        ) {
            return null;
        }
        const locator = value as Record<string, unknown>;
        if (
            Object.keys(locator).sort().join(',') !== 'c,k'
            || (locator.k !== 'female' && locator.k !== 'private')
            || typeof locator.c !== 'string'
            || !CANDIDATE_ID_PATTERN.test(locator.c)
        ) {
            return null;
        }
        return {
            kind: locator.k,
            candidateId: locator.c,
        };
    } catch {
        return null;
    }
}

export function sealV2SharedCursor(
    shareToken: string,
    ownerCursor: string
): string {
    if (ownerCursor.length < 1 || ownerCursor.length > 1_024) {
        throw new Error('INVALID_V2_SHARE_PRIVACY_INPUT');
    }
    return seal(
        'analysis-v2-share-cursor-v1',
        shareToken,
        Buffer.from(ownerCursor, 'utf8')
    );
}

export function openV2SharedCursor(
    shareToken: string,
    sharedCursor: string
): string | null {
    const payload = open(
        'analysis-v2-share-cursor-v1',
        shareToken,
        sharedCursor
    );
    if (!payload || payload.length > 1_024) return null;
    return payload.toString('utf8');
}
