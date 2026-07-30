'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { ProfileFallback } from '@/components/case-ui';
import {
    appendScreenedFace,
    MIN_SCREENED_FACES_TO_SHOW,
    type ScreenedFace,
} from '@/lib/services/analysis/progress-faces';
import { safeResultImageUrl } from '@/lib/services/result-local-image';

const TILE_PX = 84;

// Slow enough to read a face, fast enough that the row is never still.
const DRIFT_PX_PER_SECOND = 26;

function FaceTile({ face, current }: { face: ScreenedFace; current: boolean }) {
    const [failed, setFailed] = useState(false);
    const src = safeResultImageUrl(face.imageUrl);
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
                    className="h-full w-full object-cover"
                    onError={() => setFailed(true)}
                />
            ) : (
                <ProfileFallback variant="person" />
            )}
        </div>
    );
}

/* Drifts the row sideways forever by wrapping through a doubled copy of itself.
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

            // The rail holds two copies, so one copy's width is the wrap point.
            const half = el.scrollWidth / 2;
            if (half <= 0) return;
            const next = el.scrollLeft + whole;
            el.scrollLeft = next >= half ? next - half : next;
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
 * The snapshot names only the profile being read right now, so the history is
 * kept here rather than asked for. That also bounds it: the page can forget, the
 * server never has to remember.
 *
 * These are profile pictures. Feed images are not in the progress snapshot at
 * all, so carrying them would need the server to send them; nothing here assumes
 * which of the two an entry holds.
 */
export function ProgressFaces({
    active,
}: {
    active: { maskedUsername: string; imageUrl: string | null } | null;
}) {
    const [faces, setFaces] = useState<readonly ScreenedFace[]>([]);
    const [lastSeen, setLastSeen] = useState<string | null>(null);

    /* Adjusted during render rather than in an effect: the list is derived from
       a prop that changes over time, and an effect would paint the old row once
       before correcting it. The same profile is reported by every poll while it
       is being read, so the guard is on the username. */
    if (active?.imageUrl && active.maskedUsername !== lastSeen) {
        setLastSeen(active.maskedUsername);
        setFaces(current => appendScreenedFace(current, active));
    }

    const railRef = useFaceDrift(faces.length);

    if (faces.length < MIN_SCREENED_FACES_TO_SHOW) return null;

    const newest = faces.at(-1)?.username;

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
                {/* Doubled so the drift can wrap without a seam. */}
                {[...faces, ...faces].map((face, index) => (
                    <FaceTile
                        key={`${face.username}-${index}`}
                        face={face}
                        current={face.username === newest}
                    />
                ))}
            </div>
        </div>
    );
}
