'use client';

import Image from 'next/image';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
    ProgressPhotoVisits,
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
    photoKey: string;
    status: 'ready' | 'recovering' | 'recovered' | 'unavailable';
}

// One copy is enough while the same photo could appear at both edges.
export function progressRailCopyGeometry(tileCount: number, viewportWidth = PROGRESS_RAIL_MAX_WIDTH_PX) {
    const stride = TILE_PX + RAIL_GAP_PX;
    const copyDistance = Math.max(1, tileCount) * stride;
    const copyCount = copyDistance >= viewportWidth + TILE_PX ? DEFAULT_PROGRESS_COPY_COUNT : 1;
    const maxScrollLeft = Math.max(0, copyDistance * copyCount - RAIL_GAP_PX + RAIL_HORIZONTAL_PADDING_PX - viewportWidth);
    return { copyCount, copyDistance, maxScrollLeft };
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
function useFaceDrift(copyCount: number, bounceDistance: number) {
    const ref = useRef<HTMLDivElement>(null);
    const pressed = useRef(false);

    useEffect(() => {
        const el = ref.current;
        if (!el || (copyCount === 1 && bounceDistance === 0)) return;
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
        const copyElements = el.querySelectorAll<HTMLElement>('[data-progress-copy]');
        let direction = 1;

        let frame = 0;
        let last = 0;
        let carry = 0;

        const onPressStart = () => { pressed.current = true; };
        const onPressEnd = () => {
            pressed.current = false;
            last = 0;
            carry = 0;
        };

        const tick = (now: number) => {
            frame = requestAnimationFrame(tick);
            if (pressed.current || document.visibilityState !== 'visible') {
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

            if (copyCount > 1) {
                const distance = progressCopyDistance(copyElements[0].offsetLeft, copyElements[1].offsetLeft);
                el.scrollLeft = nextDriftOffset(el.scrollLeft, whole, distance);
            } else {
                if (el.scrollLeft >= bounceDistance - 0.5) direction = -1;
                if (el.scrollLeft <= 0.5) direction = 1;
                el.scrollLeft = Math.max(0, Math.min(bounceDistance, el.scrollLeft + direction * whole));
            }
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
    }, [copyCount, bounceDistance]);

    return ref;
}

function useBalancedRail(keys: readonly string[]) {
    const [preferred, setPreferred] = useState<readonly string[]>([]);
    const [width, setWidth] = useState(PROGRESS_RAIL_MAX_WIDTH_PX);
    const visits = useRef(new ProgressPhotoVisits());
    const previousOrder = useRef<readonly string[]>([]);
    const ordered = useMemo(() => {
        const available = new Set(keys);
        const kept = preferred.filter(key => available.delete(key));
        return [...kept, ...available];
    }, [keys, preferred]);
    const { copyCount, maxScrollLeft } = progressRailCopyGeometry(keys.length, width);
    const railRef = useFaceDrift(copyCount, copyCount === 1 ? maxScrollLeft : 0);
    const hasImages = keys.length > 0;

    useLayoutEffect(() => {
        const rail = railRef.current;
        if (!rail) return;
        const resize = () => { if (rail.clientWidth) setWidth(rail.clientWidth); };
        resize();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
        observer?.observe(rail);
        return () => observer?.disconnect();
    }, [railRef, hasImages]);

    useLayoutEffect(() => {
        const rail = railRef.current;
        if (!rail || ordered.length === 0) return;
        const step = TILE_PX + RAIL_GAP_PX;
        const prior = previousOrder.current;
        previousOrder.current = ordered;
        const available = new Set(ordered);
        // At the wrap, appending a newly decoded tile between the last and first
        // photos would move the user's visible strip even during a held drag.
        // Rebase on the leading photo before paint, retaining its pixel offset.
        if (prior.length > 0 && rail.scrollLeft >= step
            && (prior.length !== ordered.length || prior.some(key => !available.has(key)))) {
            const lead = Math.floor((rail.scrollLeft - RAIL_HORIZONTAL_PADDING_PX / 2) / step);
            const index = lead % prior.length;
            const kept = [...prior.slice(index), ...prior.slice(0, index)].filter(key => available.delete(key));
            const rebased = [...kept, ...available];
            rail.scrollLeft -= lead * step;
            if (rebased.some((key, i) => key !== ordered[i])) {
                previousOrder.current = rebased;
                setPreferred(rebased);
                return;
            }
        }
        let priorWindow = '';
        let onscreen = typeof IntersectionObserver !== 'function';
        const update = () => {
            if (!onscreen || document.visibilityState !== 'visible') return;
            const left = rail.scrollLeft - RAIL_HORIZONTAL_PADDING_PX / 2;
            const right = left + (rail.clientWidth || width);
            const startIndex = Math.max(0, Math.floor((left - TILE_PX) / step) + 1);
            const end = Math.min(ordered.length * copyCount, Math.ceil(right / step));
            const windowKey = [startIndex, end, Math.ceil((left - TILE_PX / 2) / step),
                Math.ceil((right - TILE_PX / 2) / step)].join(':');
            if (windowKey === priorWindow) return;
            priorWindow = windowKey;
            const visible: number[] = [];
            const centered: number[] = [];
            for (let i = startIndex; i < end; i++) {
                const start = i * step;
                const position = i % ordered.length;
                visible.push(position);
                const center = start + TILE_PX / 2;
                if (center >= left && center < right) centered.push(position);
            }
            const next = visits.current.arrange(ordered, visible, centered);
            if (next !== ordered) setPreferred(next);
        };
        const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver(([entry]) => {
            onscreen = entry?.isIntersecting === true;
            update();
        }) : null;
        observer?.observe(rail);
        update();
        rail.addEventListener('scroll', update, { passive: true });
        document.addEventListener('visibilitychange', update);
        return () => {
            observer?.disconnect();
            rail.removeEventListener('scroll', update);
            document.removeEventListener('visibilitychange', update);
        };
    }, [railRef, ordered, width, copyCount]);
    return { ordered, railRef, copyCount };
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
    const identities = useRef(new Map<string, string>());
    const lastSource = useRef(new Map<string, string>());
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
            .flatMap((imageUrl, mediaIndex) => safeProgressImageUrl(imageUrl ?? undefined, true)
                ? [{ candidateKey, username, occurrence, mediaIndex, imageUrl }] : [])) : flattenScreenedCandidateMedia(candidates);
        return pool.flatMap(tile => {
            const src = safeProgressImageUrl(tile.imageUrl ?? undefined, allowLocalAssets);
            return src ? [{ ...tile, src, key: `${tile.candidateKey ?? tile.occurrence}:${tile.mediaIndex}` }] : [];
        });
    }, [allowLocalAssets, candidates]);
    const tileKeys = useMemo(() => new Set(mediaTiles.map(tile => tile.key)), [mediaTiles]);
    const displayedTiles = useMemo(() => {
        const sources = new Set<string>();
        return mediaTiles.flatMap(tile => {
            const image = imageStates.get(tile.key);
            const displaySrc = image?.status === 'ready' || image?.status === 'recovered'
                ? safeProgressImageUrl(image.src, allowLocalAssets)
                : undefined;
            if (!displaySrc || !image || sources.has(image.photoKey)) return [];
            sources.add(image.photoKey);
            return [{ ...tile, displaySrc, photoKey: image.photoKey }];
        });
    }, [mediaTiles, imageStates, allowLocalAssets]);
    // A source uses its last successfully decoded image while a new signature
    // is loading. All copies share that image and omit pending or failed tiles.
    const hasVisibleRail = displayedTiles.length >= MIN_SCREENED_CANDIDATES_TO_SHOW;
    const keys = useMemo(() => displayedTiles.map(tile => tile.photoKey), [displayedTiles]);
    const { ordered, railRef, copyCount } = useBalancedRail(keys);
    const byKey = new Map(displayedTiles.map(tile => [tile.photoKey, tile]));
    const orderedTiles = ordered.map(key => byKey.get(key)!);
    const newestOccurrence = candidates.at(-1)?.occurrence;

    function recordImageState(key: string, src: string, loaded: boolean) {
        let photoKey = identities.current.get(src);
        if (loaded) {
            if (!photoKey) {
                const prior = lastSource.current.get(key);
                const expires = (url: string) => new URLSearchParams(url.split('?')[1]).get('expires');
                // The proxy token is deterministic within its signing window. A
                // different token in that window identifies genuinely new media.
                const rotated = prior && (expires(src) === null || expires(src) !== expires(prior));
                photoKey = (rotated ? identities.current.get(prior) : undefined) ?? src;
                identities.current.set(src, photoKey);
            }
            lastSource.current.set(key, src);
        }
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
            return new Map([...current].filter(([key]) => tileKeys.has(key))).set(key, { src, status, photoKey: photoKey ?? src });
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
                            {orderedTiles.map(tile => (
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
