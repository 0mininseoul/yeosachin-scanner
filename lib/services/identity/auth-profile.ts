import { normalizeKoreanMobileNumber } from './phone-number';

export interface AuthProfilePatch {
    name?: string;
    nickname?: string;
    profile_image?: string;
    gender?: string;
    birthyear?: string;
    phone_number?: string;
    phone_number_normalized?: string;
}

export interface AuthProfileSource {
    name?: readonly unknown[];
    nickname?: readonly unknown[];
    profileImage?: readonly unknown[];
    gender?: readonly unknown[];
    birthyear?: readonly unknown[];
    phoneNumber?: readonly unknown[];
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

function firstValidPhone(candidates: readonly unknown[] | undefined) {
    for (const candidate of candidates ?? []) {
        if (typeof candidate !== 'string') continue;
        const raw = candidate.trim();
        if (!raw) continue;
        const normalized = normalizeKoreanMobileNumber(raw);
        if (normalized) return { raw, normalized };
    }
    return undefined;
}

export function buildAuthProfilePatch(
    source: AuthProfileSource
): AuthProfilePatch {
    const patch: AuthProfilePatch = {};
    const name = firstTrimmedString(source.name);
    const nickname = firstTrimmedString(source.nickname);
    const profileImage = firstTrimmedString(source.profileImage);
    const gender = firstTrimmedString(source.gender);
    const birthyear = firstBirthyear(source.birthyear);
    const phone = firstValidPhone(source.phoneNumber);

    if (name) patch.name = name;
    if (nickname) patch.nickname = nickname;
    if (profileImage) patch.profile_image = profileImage;
    if (gender) patch.gender = gender;
    if (birthyear) patch.birthyear = birthyear;
    if (phone) {
        patch.phone_number = phone.raw;
        patch.phone_number_normalized = phone.normalized;
    }

    return patch;
}
