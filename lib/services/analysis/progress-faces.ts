export interface ScreenedCandidate {
    username: string;
    imageUrl: string | null;
    feedImageUrls: readonly string[];
}

export interface ActiveCandidateMedia {
    maskedUsername: string;
    imageUrl: string | null;
    feedImageUrls?: readonly string[];
}

/* The progress snapshot names only the candidate being read right now, so the
   history of already screened candidates is accumulated on the client. */
export const MAX_SCREENED_CANDIDATES = 20;

/** Below this the row reads as a loading placeholder rather than as people. */
export const MIN_SCREENED_CANDIDATES_TO_SHOW = 3;

function feedImages(active: ActiveCandidateMedia): readonly string[] {
    return active.feedImageUrls?.slice(0, 3) ?? [];
}

function sameMedia(
    candidate: ScreenedCandidate,
    active: ActiveCandidateMedia,
): boolean {
    const activeFeedImages = feedImages(active);
    return candidate.imageUrl === active.imageUrl
        && candidate.feedImageUrls.length === activeFeedImages.length
        && candidate.feedImageUrls.every((url, index) => url === activeFeedImages[index]);
}

function regressesMedia(
    candidate: ScreenedCandidate,
    active: ActiveCandidateMedia,
): boolean {
    return (candidate.imageUrl !== null && active.imageUrl === null)
        || feedImages(active).length < candidate.feedImageUrls.length;
}

/**
 * A stable representation of the current snapshot. The component uses it to
 * process a heartbeat once while still accepting richer media for its current
 * username on a later heartbeat.
 */
export function activeCandidateMediaKey(active: ActiveCandidateMedia): string {
    return JSON.stringify([
        active.maskedUsername,
        active.imageUrl,
        ...feedImages(active),
    ]);
}

/**
 * Adds or updates the candidate currently being screened.
 *
 * The most recent username can first arrive with no media during profile fetch
 * and then be enriched by profile AI. That is one candidate bundle, not two.
 */
export function appendScreenedCandidate(
    current: readonly ScreenedCandidate[],
    active: ActiveCandidateMedia | null,
): readonly ScreenedCandidate[] {
    if (!active) return current;

    const last = current.at(-1);
    if (last?.username === active.maskedUsername) {
        if (sameMedia(last, active)) return current;
        if (regressesMedia(last, active)) return current;
        return [...current.slice(0, -1), {
            username: active.maskedUsername,
            imageUrl: active.imageUrl,
            feedImageUrls: feedImages(active),
        }];
    }

    const next = [...current, {
        username: active.maskedUsername,
        imageUrl: active.imageUrl,
        feedImageUrls: feedImages(active),
    }];
    return next.length > MAX_SCREENED_CANDIDATES
        ? next.slice(next.length - MAX_SCREENED_CANDIDATES)
        : next;
}
