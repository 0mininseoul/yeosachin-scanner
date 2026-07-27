import { createHash } from 'node:crypto';

export type HistoricalPartialSourceIdentity = {
    ordinal: number;
    username: string;
    partition: 'private' | 'public' | 'fetch_terminal';
};

type PartialInvariantInput = {
    sourceUniverseDigest: string;
    sourceIdentities: readonly HistoricalPartialSourceIdentity[];
    mediaUnavailable: readonly { ordinal: number }[];
    profiles: readonly {
        ordinal: number;
        username: string;
        isPrivate: boolean;
        media: readonly unknown[];
        coverage?: { selectedCount: number };
    }[];
};

export const HISTORICAL_PARTIAL_PAID_MIN_PROFILE_RETENTION_BPS = 9_850;
export const HISTORICAL_PARTIAL_PAID_MIN_MEDIA_RETENTION_BPS = 9_900;
export const HISTORICAL_PARTIAL_PAID_MIN_RETAINED_MEDIA = 1_904;
const MAX_SELECTED_MEDIA_PER_UNAVAILABLE_PUBLIC_PROFILE = 12;

export function historicalPartialPaidCoverage(input: PartialInvariantInput): {
    eligible: boolean;
    retainedProfiles: number;
    sourceProfiles: number;
    retainedMedia: number;
    conservativeSourceMedia: number;
} {
    const sourceProfiles = input.sourceIdentities.length;
    const retainedProfiles = input.profiles.length;
    const retainedMedia = input.profiles.reduce((sum, profile) => sum + profile.media.length, 0);
    const conservativeSourceMedia = input.profiles.reduce(
        (sum, profile) => sum + (profile.coverage?.selectedCount ?? profile.media.length),
        input.mediaUnavailable.length * MAX_SELECTED_MEDIA_PER_UNAVAILABLE_PUBLIC_PROFILE,
    );
    return {
        eligible: sourceProfiles > 0
            && conservativeSourceMedia > 0
            && retainedProfiles * 10_000 >= sourceProfiles * HISTORICAL_PARTIAL_PAID_MIN_PROFILE_RETENTION_BPS
            && retainedMedia >= HISTORICAL_PARTIAL_PAID_MIN_RETAINED_MEDIA
            && retainedMedia * 10_000 >= conservativeSourceMedia * HISTORICAL_PARTIAL_PAID_MIN_MEDIA_RETENTION_BPS,
        retainedProfiles,
        sourceProfiles,
        retainedMedia,
        conservativeSourceMedia,
    };
}

export function normalizeHistoricalPartialUsername(value: string): string {
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(normalized)) {
        throw new Error('ANALYSIS_V2_REPLAY_INPUT_INVALID');
    }
    return normalized;
}

export function canonicalHistoricalPartialSourceIdentities(
    identities: readonly HistoricalPartialSourceIdentity[],
): HistoricalPartialSourceIdentity[] {
    return identities.map(identity => ({
        ordinal: identity.ordinal,
        username: normalizeHistoricalPartialUsername(identity.username),
        partition: identity.partition,
    })).sort((left, right) => (
        left.ordinal - right.ordinal
        || left.username.localeCompare(right.username)
        || left.partition.localeCompare(right.partition)
    ));
}

export function historicalPartialSourceUniverseDigest(
    identities: readonly HistoricalPartialSourceIdentity[],
): string {
    const canonical = canonicalHistoricalPartialSourceIdentities(identities)
        .map(identity => `${identity.ordinal}\u0000${identity.username}\u0000${identity.partition}`)
        .join('\n');
    return createHash('sha256')
        .update(`analysis-v2-historical-partial-universe-v1\n${canonical}`)
        .digest('hex');
}

export function historicalPartialSourceIdentityIssues(
    identities: readonly HistoricalPartialSourceIdentity[],
): string[] {
    let canonical: HistoricalPartialSourceIdentity[];
    try {
        canonical = canonicalHistoricalPartialSourceIdentities(identities);
    } catch {
        return ['source_identity_invalid'];
    }
    const ordinals = new Set<number>();
    const usernames = new Set<string>();
    const issues: string[] = [];
    for (const identity of canonical) {
        if (!Number.isInteger(identity.ordinal) || identity.ordinal < 1) issues.push('source_ordinal_invalid');
        if (ordinals.has(identity.ordinal)) issues.push('source_ordinal_duplicate');
        if (usernames.has(identity.username)) issues.push('source_username_duplicate');
        ordinals.add(identity.ordinal);
        usernames.add(identity.username);
    }
    return issues;
}

export function historicalPartialBundleInvariantIssues(
    input: PartialInvariantInput,
): string[] {
    const issues = historicalPartialSourceIdentityIssues(input.sourceIdentities);
    let canonical: HistoricalPartialSourceIdentity[];
    try {
        canonical = canonicalHistoricalPartialSourceIdentities(input.sourceIdentities);
        if (historicalPartialSourceUniverseDigest(canonical) !== input.sourceUniverseDigest) {
            issues.push('source_digest_mismatch');
        }
    } catch {
        return [...issues, 'source_digest_invalid'];
    }
    const identities = new Map(canonical.map(identity => [identity.ordinal, identity]));
    const accounted = new Set<number>();
    for (const profile of input.profiles) {
        let username: string;
        try { username = normalizeHistoricalPartialUsername(profile.username); } catch {
            issues.push('retained_username_invalid');
            continue;
        }
        const identity = identities.get(profile.ordinal);
        if (
            !identity
            || identity.username !== username
            || identity.partition !== (profile.isPrivate ? 'private' : 'public')
            || (profile.isPrivate ? profile.media.length !== 0 : profile.media.length === 0)
            || accounted.has(profile.ordinal)
        ) issues.push('retained_identity_mismatch');
        accounted.add(profile.ordinal);
    }
    for (const terminal of input.mediaUnavailable) {
        if (
            identities.get(terminal.ordinal)?.partition !== 'public'
            || accounted.has(terminal.ordinal)
        ) issues.push('terminal_identity_mismatch');
        accounted.add(terminal.ordinal);
    }
    for (const identity of canonical) {
        const shouldBeAccounted = identity.partition !== 'fetch_terminal';
        if (accounted.has(identity.ordinal) !== shouldBeAccounted) {
            issues.push('partition_accounting_mismatch');
        }
    }
    return issues;
}
