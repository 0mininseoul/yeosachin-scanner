'use client';

import Image from 'next/image';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    activeCandidateMediaKey,
    candidateTileKey,
    flattenScreenedCandidateMedia,
    mergeScreenedCandidateHistory,
    MIN_SCREENED_CANDIDATES_TO_SHOW,
    nextDriftOffset,
    progressCopyDistance,
    type ActiveCandidateMedia,
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

interface RailImageState {
    src: string;
    status: 'ready' | 'recovering' | 'recovered' | 'unavailable';
}

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
    displaySrc,
    current,
    onError,
}: {
    displaySrc: string;
    current: boolean;
    onError: () => void;
}) {
    return (
        <div
            className={`relative shrink-0 overflow-hidden border bg-panel ${current
                ? 'border-blood shadow-[0_0_16px_-2px_rgba(228,19,42,0.45)]'
                : 'border-line-2'}`}
            style={{ width: TILE_PX, height: TILE_PX }}
        >
            <Image
                src={displaySrc}
                alt=""
                width={TILE_PX}
                height={TILE_PX}
                unoptimized
                loading="lazy"
                className="h-full w-full object-cover"
                onError={onError}
            />
        </div>
    );
}

function safeProgressImageUrl(imageUrl: string | undefined, allowLocalAssets: boolean): string | undefined {
    if (allowLocalAssets) return imageUrl && /^\/demo-avatars\/synthetic-blurred-avatar-[1-4]-v1\.png$/.test(imageUrl) ? imageUrl : undefined;
    const src = safeResultImageUrl(imageUrl);
    return src?.startsWith('/api/image-proxy?') ? src : undefined;
}

function FaceTileProbe({
    probeSrc,
    onReady,
}: {
    probeSrc: string;
    onReady: () => void;
}) {
    const [attempt, setAttempt] = useState(0);
    const retryRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mounted = useRef(false);

    useLayoutEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            clearTimeout(retryRef.current);
            retryRef.current = undefined;
        };
    }, []);

    return (
        <Image
            key={attempt}
            src={probeSrc}
            alt=""
            width={TILE_PX}
            height={TILE_PX}
            unoptimized
            loading="eager"
            aria-hidden="true"
            data-progress-retry="true"
            className="absolute h-px w-px opacity-0"
            onLoad={() => {
                if (mounted.current) onReady();
            }}
            onError={() => {
                if (!mounted.current || retryRef.current !== undefined || attempt >= MAX_FACE_TILE_RETRIES) return;
                retryRef.current = setTimeout(() => {
                    retryRef.current = undefined;
                    setAttempt(attempt + 1);
                }, FACE_TILE_RETRY_DELAY_MS * (attempt + 1));
            }}
        />
    );
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
function useFaceDrift(hasVisibleRail: boolean) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el || !hasVisibleRail) return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const copyElements = el.querySelectorAll<HTMLElement>('[data-progress-copy]');
        if (copyElements.length < 2) return;

        let frame = 0;
        let last = 0;
        let carry = 0;
        let pressed = false;

        const onPressStart = () => { pressed = true; };
        const onPressEnd = () => {
            pressed = false;
            last = 0;
            carry = 0;
        };

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
        for (const event of ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'] as const) {
            window.addEventListener(event, onPressEnd, { passive: true });
        }
        document.addEventListener('visibilitychange', onPressEnd);
        frame = requestAnimationFrame(tick);

        return () => {
            cancelAnimationFrame(frame);
            el.removeEventListener('pointerdown', onPressStart);
            el.removeEventListener('touchstart', onPressStart);
            for (const event of ['pointerup', 'pointercancel', 'touchend', 'touchcancel', 'blur'] as const) {
                window.removeEventListener(event, onPressEnd);
            }
            document.removeEventListener('visibilitychange', onPressEnd);
        };
    }, [hasVisibleRail]);

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
    allowLocalAssets = false,
}: {
    active: ActiveCandidateMedia | null;
    candidateMedia?: readonly ProgressCandidateMediaV1[];
    publicationLagReset?: boolean;
    allowLocalAssets?: boolean;
}) {
    const [candidates, setCandidates] = useState<readonly ScreenedCandidate[]>([]);
    const [lastSnapshotKey, setLastSnapshotKey] = useState<string | null>(null);
    const [imageStates, setImageStates] = useState<ReadonlyMap<string, RailImageState>>(() => new Map());
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
    if ((active || candidateMedia.length > 0) && snapshotKey !== lastSnapshotKey) {
        setLastSnapshotKey(snapshotKey);
        setCandidates(current => mergeScreenedCandidateHistory(current, serverCandidates, active));
    }

    const mediaTiles = useMemo(() => {
        // The production flattener deliberately excludes synthetic avatars.
        // Dev uses an explicit local pool without weakening that default.
        const pool = allowLocalAssets ? candidates.flatMap(({ candidateKey, username, occurrence, imageUrl, feedImageUrls }) => [imageUrl, ...feedImageUrls]
            .filter((url): url is string => Boolean(safeProgressImageUrl(url ?? undefined, true)))
            .map((imageUrl, mediaIndex) => ({ ...(candidateKey !== undefined ? { candidateKey } : {}), username,
                occurrence, mediaIndex, imageUrl }))) : flattenScreenedCandidateMedia(candidates);
        return pool.flatMap(tile => {
            const src = safeProgressImageUrl(tile.imageUrl ?? undefined, allowLocalAssets);
            return src ? [{ ...tile, src, key: `${tile.occurrence}:${tile.mediaIndex}` }] : [];
        });
    }, [allowLocalAssets, candidates]);
    const tileKeys = useMemo(() => new Set(mediaTiles.map(tile => tile.key)), [mediaTiles]);
    const displayedTiles = mediaTiles.flatMap(tile => {
        const image = imageStates.get(tile.key);
        const displaySrc = image?.status === 'ready' || image?.status === 'recovered'
            ? safeProgressImageUrl(image.src, allowLocalAssets)
            : undefined;
        return displaySrc ? [{ ...tile, displaySrc }] : [];
    });
    // A source uses its last successfully decoded image while a new signature
    // is loading. All copies share that image and omit pending or failed tiles.
    const hasVisibleRail = displayedTiles.length >= MIN_SCREENED_CANDIDATES_TO_SHOW;
    const railRef = useFaceDrift(hasVisibleRail);
    const { copyCount } = progressRailCopyGeometry(displayedTiles.length);
    const newestOccurrence = candidates.at(-1)?.occurrence;

    function recordImageState(key: string, src: string, loaded: boolean) {
        setImageStates(current => {
            const existing = current.get(key);
            let status: RailImageState['status'];
            if (loaded) {
                if (existing?.src === src && existing.status !== 'recovering') return current;
                status = existing?.src === src ? 'recovered' : 'ready';
            } else {
                // Duplicate errors and errors from an old display source cannot
                // clear a replacement or start another recovery wave.
                if (existing?.src !== src || (existing.status !== 'ready' && existing.status !== 'recovered')) {
                    return current;
                }
                status = existing.status === 'ready' ? 'recovering' : 'unavailable';
            }
            return new Map([...current].filter(([key]) => tileKeys.has(key))).set(key, { src, status });
        });
    }

    if (mediaTiles.length === 0) return null;

    return (
        <>
            <div className="pointer-events-none absolute h-0 w-0 overflow-hidden" aria-hidden="true">
                {mediaTiles.map(tile => {
                    const image = imageStates.get(tile.key);
                    if (image?.src === tile.src && image.status !== 'recovering') return null;
                    return <FaceTileProbe
                        key={`${tile.key}:${tile.src}`}
                        probeSrc={tile.src}
                        onReady={() => recordImageState(tile.key, tile.src, true)}
                    />;
                })}
            </div>
            {hasVisibleRail && <div
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
                            {displayedTiles.map(tile => (
                                <FaceTile
                                    key={candidateTileKey(tile.occurrence, copyIndex, tile.mediaIndex)}
                                    displaySrc={tile.displaySrc}
                                    current={tile.occurrence === newestOccurrence && tile.mediaIndex === 0}
                                    onError={() => recordImageState(tile.key, tile.displaySrc, false)}
                                />
                            ))}
                        </div>
                    ))}
                </div>
            </div>}
        </>
    );
}
