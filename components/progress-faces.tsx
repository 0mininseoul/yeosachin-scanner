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

function FaceTile({ face, current }: { face: ScreenedFace; current: boolean }) {
    const [failed, setFailed] = useState(false);
    const src = safeResultImageUrl(face.imageUrl);
    return (
        <div
            className={`relative h-[58px] w-[58px] shrink-0 overflow-hidden border bg-panel transition-colors ${
                current
                    ? 'border-blood shadow-[0_0_14px_rgba(228,19,42,0.4)]'
                    : 'border-line-2'
            }`}
        >
            {src && !failed ? (
                <Image
                    src={src}
                    alt=""
                    width={58}
                    height={58}
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

/* The accounts already screened, newest at the right.
 *
 * The snapshot only ever names the one profile being read right now, so the
 * history is kept here rather than asked for. That also bounds it: the page can
 * forget, the server never has to remember.
 *
 * Motion is tied to arrivals instead of running on a timer. A strip that drifts
 * on its own is decoration; one that moves when a new face lands is telling the
 * reader something happened.
 */
export function ProgressFaces({
    active,
}: {
    active: { maskedUsername: string; imageUrl: string | null } | null;
}) {
    const [faces, setFaces] = useState<readonly ScreenedFace[]>([]);
    const [lastSeen, setLastSeen] = useState<string | null>(null);
    const railRef = useRef<HTMLDivElement>(null);

    /* Adjusted during render rather than in an effect: the list is derived from
       a prop that changes over time, and an effect would paint the old row once
       before correcting it. The same profile is reported by every poll while it
       is being read, so the guard is on the username. */
    if (active?.imageUrl && active.maskedUsername !== lastSeen) {
        setLastSeen(active.maskedUsername);
        setFaces(current => appendScreenedFace(current, active));
    }

    useEffect(() => {
        const rail = railRef.current;
        if (!rail || faces.length === 0) return;
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        rail.scrollTo({
            left: rail.scrollWidth,
            behavior: reduce ? 'auto' : 'smooth',
        });
    }, [faces.length]);

    if (faces.length < MIN_SCREENED_FACES_TO_SHOW) return null;

    return (
        /* Faded at both edges so the row reads as a window onto something longer
           rather than as a list that happens to be cut off. */
        <div
            className="relative -mx-5 mt-5"
            style={{
                maskImage: 'linear-gradient(90deg, transparent, #000 34px, #000 calc(100% - 34px), transparent)',
                WebkitMaskImage: 'linear-gradient(90deg, transparent, #000 34px, #000 calc(100% - 34px), transparent)',
            }}
        >
            <div
                ref={railRef}
                aria-hidden="true"
                className="flex gap-2.5 overflow-x-hidden px-5"
            >
                {faces.map((face, index) => (
                    <FaceTile
                        key={`${face.username}-${index}`}
                        face={face}
                        current={index === faces.length - 1}
                    />
                ))}
            </div>
        </div>
    );
}
