export interface ScreenedCandidate {
    candidateKey?: string;
    username: string;
    occurrence: number;
    imageUrl: string | null;
    feedImageUrls: readonly string[];
}

export interface ActiveCandidateMedia {
    candidateKey?: string;
    maskedUsername: string;
    imageUrl: string | null;
    feedImageUrls?: readonly string[];
}

export interface ScreenedCandidateMediaTile {
    candidateKey?: string;
    username: string;
    occurrence: number;
    mediaIndex: number;
    imageUrl: string | null;
}

/* The progress snapshot names only the candidate being read right now, so the
   history of already screened candidates is accumulated on the client. */
export const MAX_SCREENED_CANDIDATES = 20;

/** One real tile is enough to make the continuous rail useful. */
export const MIN_SCREENED_CANDIDATES_TO_SHOW = 1;

function feedImages(active: ActiveCandidateMedia): readonly string[] {
    return active.feedImageUrls?.slice(0, 3) ?? [];
}

/** Progress is an owner-facing surface: never render raw or placeholder media. */
export function signedProgressCandidateMedia(
    candidate: Pick<ScreenedCandidate, 'imageUrl' | 'feedImageUrls'>,
): readonly string[] {
    return [candidate.imageUrl, ...candidate.feedImageUrls]
        .filter((url): url is string => (
            typeof url === 'string' && url.startsWith('/api/image-proxy?')
    ));
}

/**
 * Flattens each candidate's variable-sized media bundle into tile-sized items.
 * Candidates without usable media contribute no tile. The progress rail only
 * presents collected media, so an incomplete source read cannot flash a
 * bordered blank or fabricated avatar tile.
 */
export function flattenScreenedCandidateMedia(
    candidates: readonly ScreenedCandidate[],
): readonly ScreenedCandidateMediaTile[] {
    return candidates.flatMap(candidate => {
        const media = signedProgressCandidateMedia(candidate);
        if (media.length === 0) return [];
        return media.map<ScreenedCandidateMediaTile>((imageUrl, mediaIndex) => ({
            ...(candidate.candidateKey !== undefined
                ? { candidateKey: candidate.candidateKey }
                : {}),
            username: candidate.username,
            occurrence: candidate.occurrence,
            mediaIndex,
            imageUrl,
        }));
    });
}

function matchingScreenedCandidateIndex(
    current: readonly ScreenedCandidate[],
    candidate: ScreenedCandidate,
): number {
    if (candidate.candidateKey !== undefined) {
        const keyedIndex = current.findIndex(item => item.candidateKey === candidate.candidateKey);
        if (keyedIndex >= 0) return keyedIndex;
        return current.findIndex(item => (
            item.candidateKey === undefined && item.username === candidate.username
        ));
    }
    return current.findIndex(item => (
        item.candidateKey === undefined && item.username === candidate.username
    ));
}

/** Merges server history without moving older candidates on every fresh read. */
export function mergeScreenedCandidateHistory(
    current: readonly ScreenedCandidate[],
    incoming: readonly ScreenedCandidate[],
): readonly ScreenedCandidate[] {
    let next: readonly ScreenedCandidate[] = current;
    for (const candidate of incoming) {
        const index = matchingScreenedCandidateIndex(next, candidate);
        if (index < 0) {
            next = [...next, {
                ...candidate,
                occurrence: nextOccurrence(next),
            }];
            if (next.length > MAX_SCREENED_CANDIDATES) {
                next = next.slice(next.length - MAX_SCREENED_CANDIDATES);
            }
            continue;
        }
        const existing = next[index]!;
        const nextCandidate = {
            ...(candidate.candidateKey !== undefined
                ? { candidateKey: candidate.candidateKey }
                : existing.candidateKey !== undefined
                    ? { candidateKey: existing.candidateKey }
                    : {}),
            username: candidate.username,
            imageUrl: candidate.imageUrl ?? existing.imageUrl,
            feedImageUrls: candidate.feedImageUrls.length >= existing.feedImageUrls.length
                ? candidate.feedImageUrls
                : existing.feedImageUrls,
        };
        if (!sameCandidateData(existing, nextCandidate)) {
            next = [
                ...next.slice(0, index),
                { ...nextCandidate, occurrence: existing.occurrence },
                ...next.slice(index + 1),
            ];
        }
    }
    return next;
}

function sameCandidate(
    candidate: ScreenedCandidate,
    active: ActiveCandidateMedia,
): boolean {
    if (candidate.candidateKey !== undefined || active.candidateKey !== undefined) {
        return candidate.candidateKey !== undefined
            && candidate.candidateKey === active.candidateKey;
    }
    return candidate.username === active.maskedUsername;
}

function matchingCandidateIndex(
    current: readonly ScreenedCandidate[],
    active: ActiveCandidateMedia,
): number {
    if (active.candidateKey !== undefined) {
        const keyedIndex = current.findIndex(candidate => candidate.candidateKey === active.candidateKey);
        if (keyedIndex >= 0) return keyedIndex;
        return current.findIndex(candidate => (
            candidate.candidateKey === undefined
            && candidate.username === active.maskedUsername
        ));
    }
    const lastIndex = current.length - 1;
    return lastIndex >= 0 && sameCandidate(current[lastIndex], active) ? lastIndex : -1;
}

function sameCandidateData(
    candidate: ScreenedCandidate,
    next: Omit<ScreenedCandidate, 'occurrence'>,
): boolean {
    return candidate.candidateKey === next.candidateKey
        && candidate.username === next.username
        && candidate.imageUrl === next.imageUrl
        && candidate.feedImageUrls.length === next.feedImageUrls.length
        && candidate.feedImageUrls.every((url, index) => url === next.feedImageUrls[index]);
}

function nextOccurrence(current: readonly ScreenedCandidate[]): number {
    return current.reduce((highest, candidate) => (
        Math.max(highest, candidate.occurrence)
    ), 0) + 1;
}

/** Stable heartbeat identity, including the optional opaque candidate key. */
export function activeCandidateMediaKey(active: ActiveCandidateMedia): string {
    return JSON.stringify([
        active.candidateKey ?? null,
        active.maskedUsername,
        active.imageUrl,
        ...feedImages(active),
    ]);
}

/** Stable wrapper key for one occurrence in one rail copy. */
export function candidateCopyKey(occurrence: number, copyIndex: number): string {
    return `${occurrence}:${copyIndex}`;
}

/**
 * Stable tile identity. Signed proxy URLs rotate independently of the
 * candidate/media identity, so URL refreshes must not remount or flash tiles.
 */
export function candidateTileKey(
    occurrence: number,
    copyIndex: number,
    mediaIndex: number,
): string {
    return `${occurrence}:${copyIndex}:${mediaIndex}`;
}

export function progressCopyDistance(firstStart: number, secondStart: number): number {
    return Math.max(0, secondStart - firstStart);
}

export function nextDriftOffset(
    current: number,
    increment: number,
    copyDistance: number,
): number {
    if (copyDistance <= 0) return current;
    return (current + increment) % copyDistance;
}

/**
 * Adds or merges the candidate currently being screened.
 *
 * Profile and feed media are monotonic independently: a sparse retry cannot
 * erase either dimension, while refreshed proxy tokens at the same richness
 * can replace stale media.
 */
export function appendScreenedCandidate(
    current: readonly ScreenedCandidate[],
    active: ActiveCandidateMedia | null,
): readonly ScreenedCandidate[] {
    if (!active) return current;

    const existingIndex = matchingCandidateIndex(current, active);
    const existing = current[existingIndex];
    if (existing) {
        const incomingFeeds = feedImages(active);
        const candidateKey = active.candidateKey ?? existing.candidateKey;
        const next = {
            ...(candidateKey !== undefined ? { candidateKey } : {}),
            username: active.maskedUsername,
            imageUrl: active.imageUrl ?? existing.imageUrl,
            feedImageUrls: incomingFeeds.length >= existing.feedImageUrls.length
                ? incomingFeeds
                : existing.feedImageUrls,
        };
        const merged = sameCandidateData(existing, next)
            ? existing
            : { ...next, occurrence: existing.occurrence };
        if (existingIndex === current.length - 1) {
            return merged === existing
                ? current
                : [...current.slice(0, -1), merged];
        }
        return [
            ...current.slice(0, existingIndex),
            ...current.slice(existingIndex + 1),
            merged,
        ];
    }

    const next = [...current, {
        ...(active.candidateKey !== undefined ? { candidateKey: active.candidateKey } : {}),
        username: active.maskedUsername,
        occurrence: nextOccurrence(current),
        imageUrl: active.imageUrl,
        feedImageUrls: feedImages(active),
    }];
    return next.length > MAX_SCREENED_CANDIDATES
        ? next.slice(next.length - MAX_SCREENED_CANDIDATES)
        : next;
}
