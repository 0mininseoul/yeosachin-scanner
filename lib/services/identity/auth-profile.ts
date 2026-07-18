import { normalizeKoreanMobileNumber } from './phone-number';

interface AuthProfileFields {
    name?: string;
    nickname?: string;
    profile_image?: string;
    gender?: string;
    birthyear?: string;
}

export type AuthPhonePatch =
    | {
        phone_number?: never;
        phone_number_normalized?: never;
    }
    | {
        phone_number: string;
        phone_number_normalized: string;
    }
    | {
        phone_number: null;
        phone_number_normalized: null;
    };

export type AuthProfilePatch = AuthProfileFields & AuthPhonePatch;

export type AuthPhoneSync =
    | { mode: 'preserve' }
    | { mode: 'synchronize'; value: unknown };

export interface AuthProfileSource {
    name?: readonly unknown[];
    nickname?: readonly unknown[];
    profileImage?: readonly unknown[];
    gender?: readonly unknown[];
    birthyear?: readonly unknown[];
    phone?: AuthPhoneSync;
}

function firstTrimmedString(candidates: readonly unknown[] | undefined) {
    for (const candidate of candidates ?? []) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (trimmed) return trimmed;
    }
    return undefined;
}

function firstBirthyear(candidates: readonly unknown[] | undefined) {
    for (const candidate of candidates ?? []) {
        if (typeof candidate === 'string') {
            const trimmed = candidate.trim();
            if (trimmed) return trimmed;
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return String(candidate);
        }
    }
    return undefined;
}

function buildPhonePatch(phone: AuthPhoneSync | undefined): AuthPhonePatch {
    if (!phone || phone.mode === 'preserve') return {};

    const raw = typeof phone.value === 'string' ? phone.value.trim() : '';
    const normalized = normalizeKoreanMobileNumber(raw);
    return raw && normalized
        ? {
            phone_number: raw,
            phone_number_normalized: normalized,
        }
        : {
            phone_number: null,
            phone_number_normalized: null,
        };
}

export function buildAuthProfilePatch(
    source: AuthProfileSource
): AuthProfilePatch {
    const patch: AuthProfileFields = {};
    const name = firstTrimmedString(source.name);
    const nickname = firstTrimmedString(source.nickname);
    const profileImage = firstTrimmedString(source.profileImage);
    const gender = firstTrimmedString(source.gender);
    const birthyear = firstBirthyear(source.birthyear);

    if (name) patch.name = name;
    if (nickname) patch.nickname = nickname;
    if (profileImage) patch.profile_image = profileImage;
    if (gender) patch.gender = gender;
    if (birthyear) patch.birthyear = birthyear;
    return { ...patch, ...buildPhonePatch(source.phone) };
}
