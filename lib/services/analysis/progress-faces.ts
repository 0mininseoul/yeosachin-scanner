export interface ScreenedFace {
    username: string;
    imageUrl: string;
}

/* The progress snapshot names only the profile being read right now, so the
   history of who has gone past is accumulated on the client. That makes it the
   client's job to bound it too. */
export const MAX_SCREENED_FACES = 20;

/** Below this the row reads as a loading placeholder rather than as people. */
export const MIN_SCREENED_FACES_TO_SHOW = 3;

/**
 * Appends the profile currently being read, if it is new.
 *
 * Returns the same array when nothing changed, so a caller can use identity to
 * decide whether to re-render. Every poll repeats the active profile for as long
 * as it is being read, which is why the guard is on the newest entry rather than
 * on membership: the same account can legitimately appear twice if the pipeline
 * revisits it, and dropping that would make the row disagree with the count.
 */
export function appendScreenedFace(
    current: readonly ScreenedFace[],
    active: { maskedUsername: string; imageUrl: string | null } | null,
): readonly ScreenedFace[] {
    if (!active?.imageUrl) return current;
    if (current.at(-1)?.username === active.maskedUsername) return current;

    const next = [...current, {
        username: active.maskedUsername,
        imageUrl: active.imageUrl,
    }];
    return next.length > MAX_SCREENED_FACES
        ? next.slice(next.length - MAX_SCREENED_FACES)
        : next;
}
