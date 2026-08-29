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
const MAX_FACE_TILE_RETRIES = 2;
const FACE_TILE_RETRY_DELAY_MS = 1_000;

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
}: {
    src: string | undefined;
    current: boolean;
}) {
    /*
     * Signed image URLs rotate independently of a tile's identity. Keep the
     * last image that actually loaded in the visible slot while probing a new
     * URL off-screen. A transient 403/timeout therefore cannot replace a
     * useful face with initials or a broken-image/placeholder tile.
     */
    const [lastGoodSrc, setLastGoodSrc] = useState<string | undefined>();
    const [pendingSrc, setPendingSrc] = useState<string | undefined>();
    const [exhaustedSrc, setExhaustedSrc] = useState<string | undefined>();
    const [retryVersion, setRetryVersion] = useState(0);
    const retryStateRef = useRef(new Map<string, {
        attempts: number;
        timer: ReturnType<typeof setTimeout> | undefined;
    }>());

    useEffect(() => {
        for (const [candidate, state] of retryStateRef.current) {
            if (candidate === src) continue;
            if (state.timer !== undefined) clearTimeout(state.timer);
            retryStateRef.current.delete(candidate);
        }
    }, [src]);

    useEffect(() => () => {
        for (const state of retryStateRef.current.values()) {
            if (state.timer !== undefined) clearTimeout(state.timer);
        }
        retryStateRef.current.clear();
    }, []);

    const scheduleRetry = (candidate: string) => {
        const state = retryStateRef.current.get(candidate) ?? {
            attempts: 0,
            timer: undefined,
        };
        if (state.timer !== undefined) clearTimeout(state.timer);
        if (state.attempts >= MAX_FACE_TILE_RETRIES) {
            setExhaustedSrc(candidate);
            setPendingSrc(currentPending => (
                currentPending === candidate ? undefined : currentPending
            ));
            retryStateRef.current.set(candidate, state);
            return;
        }

        state.attempts += 1;
        state.timer = setTimeout(() => {
            state.timer = undefined;
            setRetryVersion(version => version + 1);
        }, FACE_TILE_RETRY_DELAY_MS * state.attempts);
        retryStateRef.current.set(candidate, state);
    };

    const onImageLoad = (loadedSrc: string) => {
        if (loadedSrc !== src) return;
        const retryState = retryStateRef.current.get(loadedSrc);
        if (retryState?.timer !== undefined) clearTimeout(retryState.timer);
        retryStateRef.current.delete(loadedSrc);
        setExhaustedSrc(currentExhausted => (
            currentExhausted === loadedSrc ? undefined : currentExhausted
        ));
        setLastGoodSrc(loadedSrc);
        setPendingSrc(currentPending => (
            currentPending === loadedSrc ? undefined : currentPending
        ));
    };

    const onImageError = (failedImageSrc: string) => {
        if (failedImageSrc === lastGoodSrc) setLastGoodSrc(undefined);
        setPendingSrc(currentPending => currentPending ?? failedImageSrc);
        scheduleRetry(failedImageSrc);
    };

    const exhaustedCurrentSrc = exhaustedSrc === src;
    // A source with no prior good image stays invisible while its first probe
    // loads. Once it errors, only the invisible probe is retried; an exhausted
    // source stays blank instead of looping a broken image forever.
    const sourceChanged = src !== undefined && src !== lastGoodSrc;
    const activePendingSrc = pendingSrc === src ? pendingSrc : undefined;
    const displaySrc = lastGoodSrc;
    const probeSrc = exhaustedCurrentSrc
        ? undefined
        : activePendingSrc ?? (sourceChanged ? src : undefined);
    const hasVisibleImage = displaySrc !== undefined;
    return (
        <div
            className={`relative shrink-0 overflow-hidden ${
                hasVisibleImage
                    ? `border bg-panel ${current
                        ? 'border-blood shadow-[0_0_16px_-2px_rgba(228,19,42,0.45)]'
                        : 'border-line-2'}`
                    : 'border-transparent bg-transparent'
            }`}
            style={{ width: TILE_PX, height: TILE_PX }}
        >
            {displaySrc ? (
                <Image
                    src={displaySrc}
                    alt=""
                    width={TILE_PX}
                    height={TILE_PX}
                    unoptimized
                    loading="lazy"
                    className="h-full w-full object-cover"
                    onLoad={() => onImageLoad(displaySrc)}
                    onError={() => onImageError(displaySrc)}
                />
            ) : null}
            {probeSrc && probeSrc !== displaySrc ? (
                <Image
                    key={`probe:${retryVersion}`}
                    src={probeSrc}
                    alt=""
                    width={TILE_PX}
                    height={TILE_PX}
                    unoptimized
                    loading="eager"
                    aria-hidden="true"
                    data-progress-retry="true"
                    className="pointer-events-none absolute h-px w-px opacity-0"
                    onLoad={() => onImageLoad(probeSrc)}
                    onError={() => onImageError(probeSrc)}
                />
            ) : null}
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
       into a raw Instagram-CDN client or a blank placeholder tile. */
    const imageUrl = tile.imageUrl ?? undefined;
    const src = safeResultImageUrl(imageUrl);
    const safeSrc = src?.startsWith('/api/image-proxy?') ? src : undefined;
    if (!safeSrc) return null;
    return <FaceTile
        key={candidateTileKey(tile.occurrence, copyIndex, tile.mediaIndex)}
        src={safeSrc}
        current={current && tile.mediaIndex === 0}
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

    const mediaTiles = useMemo(() => (
        flattenScreenedCandidateMedia(candidates).filter(tile => {
            const imageUrl = tile.imageUrl ?? undefined;
            return safeResultImageUrl(imageUrl)?.startsWith('/api/image-proxy?') ?? false;
        })
    ), [candidates]);
    // Geometry, drift, and rendering all use the same safe real-media pool;
    // media-less or malformed candidates cannot create invisible gaps.
    const railRef = useFaceDrift(mediaTiles.length);
    const { copyCount } = progressRailCopyGeometry(mediaTiles.length);

    if (mediaTiles.length < MIN_SCREENED_CANDIDATES_TO_SHOW) return null;

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
