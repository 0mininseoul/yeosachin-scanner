'use client';

import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Counts from zero up to `target` once, for the verdict number on the result page.
 *
 * The CSS `prefers-reduced-motion` block cannot reach a JS-driven number, so the
 * check is repeated here. Whether we animate is decided during render rather than
 * by syncing state in an effect, which also avoids flashing the final number for
 * a frame before the count starts.
 */
export function useCountUp(
    target: number,
    options: { durationMs?: number; delayMs?: number; enabled?: boolean } = {},
): number {
    const { durationMs = 800, delayMs = 0, enabled = true } = options;
    const [value, setValue] = useState(0);
    const playedRef = useRef(false);
    // Lazy initializer: evaluated once, on the client, during the first render.
    const [reduced] = useState(prefersReducedMotion);

    const willAnimate = enabled && target > 0 && !reduced;

    useEffect(() => {
        if (!willAnimate || playedRef.current) return;
        playedRef.current = true;

        let frame = 0;
        let startedAt = 0;
        const step = (now: number) => {
            if (startedAt === 0) startedAt = now;
            const progress = Math.min(1, (now - startedAt) / durationMs);
            // easeOutCubic: fast off the mark, settles onto the final number.
            setValue(Math.round(target * (1 - (1 - progress) ** 3)));
            if (progress < 1) frame = requestAnimationFrame(step);
        };

        const timer = window.setTimeout(() => {
            frame = requestAnimationFrame(step);
        }, delayMs);

        return () => {
            window.clearTimeout(timer);
            if (frame) cancelAnimationFrame(frame);
        };
    }, [willAnimate, target, durationMs, delayMs]);

    return willAnimate ? value : target;
}
