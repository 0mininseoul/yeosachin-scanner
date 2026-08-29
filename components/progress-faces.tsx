'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
    activeCandidateMediaKey,
    appendScreenedCandidate,
    candidateCopyKey,
    candidateTileKey,
    flattenScreenedCandidateMedia,
    mergeScreenedCandidateHistory,
    MIN_SCREENED_CANDIDATES_TO_SHOW,
    nextDriftOffset,
    progressCopyDistance,
    type ActiveCandidateMedia,
    type ScreenedCandidateMediaTile,
    type ScreenedCandidate,
} from '@/lib/services/analysis/progress-faces';
import type { ProgressCandidateMediaV1 } from '@/lib/contracts/analysis-v2';
import { safeResultImageUrl } from '@/lib/services/result-local-image';

const TILE_PX = 84;
const RAIL_GAP_PX = 10; // Tailwind gap-2.5.
const RAIL_HORIZONTAL_PADDING_PX = 40; // Tailwind px-5 on both sides.
const PROGRESS_RAIL_MAX_WIDTH_PX = 460;
const DEFAULT_PROGRESS_COPY_COUNT = 3;

/**
 * Size the repeated rail copies so the max-width progress viewport can scroll
 * through at least one whole copy before the browser reaches its clamp.
 * Larger histories naturally need only the default three copies.
 */
export function progressRailCopyGeometry(tileCount: number) {
    const normalizedTileCount = Math.max(1, Math.floor(tileCount));
    const copyWidth = normalizedTileCount * TILE_PX
        + Math.max(0, normalizedTileCount - 1) * RAIL_GAP_PX;
    const copyDistance = copyWidth + RAIL_GAP_PX;
    const minimumCopySpan = PROGRESS_RAIL_MAX_WIDTH_PX
        + copyDistance
        + RAIL_GAP_PX
        - RAIL_HORIZONTAL_PADDING_PX;
    const copyCount = Math.max(
        DEFAULT_PROGRESS_COPY_COUNT,
        Math.ceil(minimumCopySpan / copyDistance),
    );
    const scrollWidth = RAIL_HORIZONTAL_PADDING_PX
        + copyCount * copyWidth
        + Math.max(0, copyCount - 1) * RAIL_GAP_PX;

    return {
        copyCount,
        copyDistance,
        scrollWidth,
        maxScrollLeft: scrollWidth - PROGRESS_RAIL_MAX_WIDTH_PX,
    };
}

// Slow enough to read a face, fast enough that the row is never still.
const DRIFT_PX_PER_SECOND = 26;

function FaceTile({
    src,
    current,
    label,
}: {
    src: string | undefined;
    current: boolean;
    label: string;
}) {
    // Remember the source that failed instead of resetting state in an effect.
    // A refreshed signed proxy path then naturally becomes a new attempt while
    // preserving this tile's React identity.
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const failed = src !== undefined && failedSrc === src;
    return (
        <div
            className={`relative shrink-0 overflow-hidden border bg-panel ${
                current
                    ? 'border-blood shadow-[0_0_16px_-2px_rgba(228,19,42,0.45)]'
                    : 'border-line-2'
            }`}
            style={{ width: TILE_PX, height: TILE_PX }}
        >
            {src && !failed ? (
                <Image
                    src={src}
                    alt=""
                    width={TILE_PX}
                    height={TILE_PX}
                    unoptimized
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onError={() => setFailedSrc(src ?? null)}
                />
            ) : (
                <div
                    aria-hidden="true"
                    className="flex h-full w-full items-center justify-center bg-panel-2 text-[20px] font-bold text-fg-mute"
                >
                    {label.replace(/\*/g, '').charAt(0).toUpperCase() || '?'}
                </div>
            )}
        </div>
    );
}

function CandidateMediaTile({
    tile,
    copyIndex,
    current,
}: {
    tile: ScreenedCandidateMediaTile;
    copyIndex: number;
    current: boolean;
}) {
    /* Heartbeats contain signed, owner-scoped proxy paths. Keep the rendering
       boundary defensive too: a malformed heartbeat must not turn the browser
       into a raw Instagram-CDN client, and demo fallback art is not real
       progress media. */
    const imageUrl = tile.imageUrl ?? undefined;
    const src = safeResultImageUrl(imageUrl);
    const safeSrc = src?.startsWith('/api/image-proxy?') ? src : undefined;
    return <FaceTile
        key={candidateTileKey(tile.occurrence, copyIndex, tile.mediaIndex, safeSrc)}
        src={safeSrc}
        current={current && tile.mediaIndex === 0}
        label={tile.username}
    />;
}

/* Drifts the row sideways forever by wrapping through repeated copies of itself.
 *
 * A strip that only moved when a face arrived sat still between polls, which is
 * most of the time. Wrapping keeps it alive without pretending more accounts
 * exist than have been read — the same faces come back around.
 *
 * Yields while a finger is held down, the way the review strip does; scrolling
 * by hand is a reasonable thing to want and fighting it is not.
 */
function useFaceDrift(faceCount: number) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el || faceCount === 0) return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const copyElements = el.querySelectorAll<HTMLElement>('[data-progress-copy]');
        if (copyElements.length < 2) return;

        let frame = 0;
        let last = 0;
        let carry = 0;
        let pressed = false;

        const onPressStart = () => { pressed = true; };
        const onPressEnd = () => { pressed = false; };
        const onVisibility = () => { last = 0; };

        const tick = (now: number) => {
            frame = requestAnimationFrame(tick);
            if (pressed || document.visibilityState !== 'visible') {
                last = now;
                carry = 0;
                return;
            }
            if (last === 0) last = now;
            carry += ((now - last) / 1000) * DRIFT_PX_PER_SECOND;
            last = now;

            const whole = Math.floor(carry);
            if (whole <= 0) return;
            carry -= whole;

            const copyDistance = progressCopyDistance(
                copyElements[0].offsetLeft,
                copyElements[1].offsetLeft,
            );
            el.scrollLeft = nextDriftOffset(el.scrollLeft, whole, copyDistance);
        };

        el.addEventListener('pointerdown', onPressStart, { passive: true });
        el.addEventListener('touchstart', onPressStart, { passive: true });
        for (const event of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const) {
            window.addEventListener(event, onPressEnd, { passive: true });
        }
        document.addEventListener('visibilitychange', onVisibility);
        frame = requestAnimationFrame(tick);

        return () => {
            cancelAnimationFrame(frame);
            el.removeEventListener('pointerdown', onPressStart);
            el.removeEventListener('touchstart', onPressStart);
            for (const event of ['pointerup', 'pointercancel', 'touchend', 'touchcancel'] as const) {
                window.removeEventListener(event, onPressEnd);
            }
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [faceCount]);

    return ref;
}

/* The accounts already screened.
 *
 * The snapshot names the profile being read right now and the owner read can
 * include a bounded outcome history. The browser still retains its own merged
 * view so a transient empty read cannot erase a tile already on screen.
 *
 * Each candidate is flattened into a bounded profile/feed tile pool. The
 * active heartbeat is merged first and the freshly signed server history last,
 * so equal-richness history wins while active-only candidates are retained.
 */
export function ProgressFaces({
    active,
    candidateMedia = [],
    publicationLagReset = false,
}: {
    active: ActiveCandidateMedia | null;
    candidateMedia?: readonly ProgressCandidateMediaV1[];
    publicationLagReset?: boolean;
}) {
    const [candidates, setCandidates] = useState<readonly ScreenedCandidate[]>([]);
    const [lastSnapshotKey, setLastSnapshotKey] = useState<string | null>(null);
    const serverCandidates = useMemo(() => candidateMedia.map(({
        candidateKey,
        maskedUsername,
        imageUrl,
        feedImageUrls,
    }) => ({
        ...(candidateKey !== undefined
            ? { candidateKey }
            : {}),
        username: maskedUsername,
        occurrence: 0,
        imageUrl,
        feedImageUrls,
    })), [candidateMedia]);
    const snapshotKey = useMemo(() => JSON.stringify([
        publicationLagReset,
        active ? activeCandidateMediaKey(active) : null,
        serverCandidates,
    ]), [active, publicationLagReset, serverCandidates]);

    /* Adjusted during render rather than in an effect: the list is derived from
       a prop that changes over time, and an effect would paint the old row once
       before correcting it. The stable snapshot key makes repeated heartbeats a
       no-op while allowing the same candidate to be enriched with feed media. */
    if (publicationLagReset && snapshotKey !== lastSnapshotKey) {
        setLastSnapshotKey(snapshotKey);
        setCandidates([]);
    } else if (active && snapshotKey !== lastSnapshotKey) {
        setLastSnapshotKey(snapshotKey);
        setCandidates(current => {
            const withActive = appendScreenedCandidate(current, active);
            return mergeScreenedCandidateHistory(withActive, serverCandidates);
        });
    }

    if (!publicationLagReset && !active && candidateMedia.length > 0 && snapshotKey !== lastSnapshotKey) {
        setLastSnapshotKey(snapshotKey);
        setCandidates(current => mergeScreenedCandidateHistory(current, serverCandidates));
    }

    const mediaTiles = useMemo(
        () => flattenScreenedCandidateMedia(candidates),
        [candidates],
    );
    const hasRealMedia = useMemo(() => mediaTiles.some(tile => {
        const imageUrl = tile.imageUrl ?? undefined;
        return safeResultImageUrl(imageUrl)?.startsWith('/api/image-proxy?');
    }), [mediaTiles]);
    // Let the drift effect initialize when a fallback-only snapshot is enriched
    // into real media without changing the tile count.
    const railRef = useFaceDrift(hasRealMedia ? mediaTiles.length : 0);
    const { copyCount } = progressRailCopyGeometry(mediaTiles.length);

    if (!hasRealMedia || mediaTiles.length < MIN_SCREENED_CANDIDATES_TO_SHOW) return null;

    const newestOccurrence = candidates.at(-1)?.occurrence;

    return (
        /* Faded at both edges so the row reads as a window onto something longer
           rather than as a list that happens to be cut off. */
        <div
            className="relative -mx-5 mt-5"
            style={{
                maskImage: 'linear-gradient(90deg, transparent, #000 40px, #000 calc(100% - 40px), transparent)',
                WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 40px, #000 calc(100% - 40px), transparent)',
            }}
        >
            <div
                ref={railRef}
                aria-hidden="true"
                className="scroll-thin flex gap-2.5 overflow-x-auto px-5"
            >
                {/* Enough explicit copies cover the viewport while one wraps. */}
                {Array.from({ length: copyCount }, (_, copyIndex) => (
                    <div
                        key={`copy-${copyIndex}`}
                        data-progress-copy
                        className="flex shrink-0 gap-2.5"
                    >
                        {mediaTiles.map(tile => (
                            <CandidateMediaTile
                                key={`${candidateCopyKey(tile.occurrence, copyIndex)}:${tile.mediaIndex}`}
                                tile={tile}
                                copyIndex={copyIndex}
                                current={tile.occurrence === newestOccurrence}
                            />
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}
