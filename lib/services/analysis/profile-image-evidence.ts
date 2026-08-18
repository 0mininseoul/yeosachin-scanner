import { createHash } from 'node:crypto';

/** Instagram's current anonymous profile asset ID (all sizes share this path). */
export const INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID =
    '573323465_1219825463302212_7278921664109726296_n.png';

/**
 * SHA-256 fingerprints observed after bounded image normalization.  Keep the
 * set additive: Instagram can change the encoded size/format without changing
 * the underlying anonymous avatar.
 */
export const INSTAGRAM_DEFAULT_PROFILE_IMAGE_NORMALIZED_SHA256 = Object.freeze([
    // JPEG 150px, WebP 150px, and JPEG 320px at the routing policy.
    '7edcde60c739d5723a0ea6285e44e0d1bed4942b53aeaaeca9c60dc8a5bd10ef',
    'ddd024f05c503446782f8267e861c40cf4d878c6326a655c43df205cc0562a0f',
    '376147675d9b7307dfa755412a30297f6dcf94b08f306e536fd06e4c83c8c437',
    // The same source normalized at the legacy routing policy and replay policy.
    'bb22bca7e030136364cecc2fb1daf089de74a6edf82fdc7472dd4a3760fe8893',
    'ebe47330e1ae690dd499879b8fe38d608f06bbfeebe106900c5dae27a6020575',
    'd5728beb1bff1b0074422cec1ab1a4673d96e367b0b42069903b825ff54187a4',
    'fb3b29f9cc4b8441f56d03d0a35e7edb12f0bc2c6a7eff8c87b913fa4bf5da1f',
    'ac2d1f0bad0d25c77ce9e91f9ee37a5c63e95f2fe5dc3cac88d6d46bcc87f40b',
    '4a9c82a031c76dd61d97e6345b33324af7ea4d31a559058a5eadf48f29669af9',
    // Raw CDN bytes are retained for transport-free adapters that normalize upstream.
    '09c3cf34d4f117d99fa6285f4bfd3a0d888d7ab2cbca665b16097f6b93ca0de6',
    'a4706fb0ba5d81667ae1f673d224d3067dabb6b5481b6c17ddc9da6d30ee6877',
    '3e0ce106f723a42009104565fd278c839a240d9d98ea529df4b00be5fb5b8001',
] as const);

const DEFAULT_PROFILE_IMAGE_HASHES = new Set<string>(
    INSTAGRAM_DEFAULT_PROFILE_IMAGE_NORMALIZED_SHA256,
);
const ANONYMOUS_PROFILE_IMAGE_MARKER = /(?:anonymous_profile_pic|YW5vbnltb3VzX3Byb2ZpbGVfcGlj)/iu;

function urlCandidates(value: string): readonly string[] {
    const candidates = [value];
    try {
        candidates.push(decodeURIComponent(value));
    } catch {
        // A malformed provider escape must not disable the URL marker check.
    }
    return candidates;
}

function hasDefaultMediaId(value: string): boolean {
    return urlCandidates(value).some(candidate => {
        if (ANONYMOUS_PROFILE_IMAGE_MARKER.test(candidate)) return true;
        try {
            const pathname = decodeURIComponent(new URL(candidate).pathname);
            return pathname.endsWith(`/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}`)
                || pathname === INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID;
        } catch {
            const pathname = candidate.split(/[?#]/u, 1)[0] ?? candidate;
            return pathname.endsWith(`/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}`)
                || pathname === INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID;
        }
    });
}

function sha256(value: Uint8Array): string {
    return createHash('sha256').update(value).digest('hex');
}

export function isDefaultInstagramProfileImage(input: {
    url?: string | null;
    normalizedBytes?: Uint8Array | null;
    normalizedSha256?: string | null;
}): boolean {
    if (typeof input.url === 'string' && input.url.trim() && hasDefaultMediaId(input.url)) {
        return true;
    }
    if (typeof input.normalizedSha256 === 'string'
        && DEFAULT_PROFILE_IMAGE_HASHES.has(input.normalizedSha256.trim().toLowerCase())) {
        return true;
    }
    return input.normalizedBytes instanceof Uint8Array
        && DEFAULT_PROFILE_IMAGE_HASHES.has(sha256(input.normalizedBytes));
}

export function preferredInstagramProfileImageUrl(profile: {
    profilePicUrl?: string | null;
    profilePicUrlHD?: string | null;
}): string | undefined {
    const standard = profile.profilePicUrl?.trim() || undefined;
    const hd = profile.profilePicUrlHD?.trim() || undefined;
    const preferred = hd && hd !== standard ? hd : standard ?? hd;
    return preferred && !isDefaultInstagramProfileImage({ url: preferred })
        ? preferred
        : undefined;
}
