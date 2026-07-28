'use client';

import { useEffect, useState } from 'react';

const SEEN_KEY = 'yeosachin:overture-seen:v1';

/* The overture withdraws after ~2.6s. Unmounting a beat later keeps a stray
   fixed layer from sitting over the page once it is invisible. */
const TEARDOWN_MS = 2900;

function alreadySeen(): boolean {
    try {
        return window.sessionStorage.getItem(SEEN_KEY) === '1';
    } catch {
        // Private mode or blocked storage: treat as seen so nobody is trapped
        // behind a curtain that replays on every navigation.
        return true;
    }
}

function markSeen(): void {
    try {
        window.sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
        /* nothing to do — the guard above already fails closed */
    }
}

/* Starts false on both the server and the first client render, so hydration
   matches and repeat visitors never see a frame of the curtain. The decision is
   made in an effect and applied on the next frame. */
export function useOverture(): boolean {
    const [playing, setPlaying] = useState(false);

    useEffect(() => {
        const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
        if (reduced || alreadySeen()) return;

        // The session is marked inside the frame callback, not here: React runs
        // effects twice in development, and marking up front let the cancelled
        // first pass consume the one-shot so the overture never played at all.
        let cancelled = false;
        let timer = 0;
        const frame = requestAnimationFrame(() => {
            if (cancelled) return;
            markSeen();
            setPlaying(true);
            timer = window.setTimeout(() => setPlaying(false), TEARDOWN_MS);
        });

        return () => {
            cancelled = true;
            cancelAnimationFrame(frame);
            if (timer) window.clearTimeout(timer);
        };
    }, []);

    return playing;
}

/* Full-bleed opening statement, shown once per session.
 *
 * It repeats the hero headline rather than introducing new copy: the point is to
 * land the same sentence with weight, then hand over to the page that can act on
 * it. Anything the visitor needs to *do* lives underneath and arrives 1.7s in. */
export function LandingOverture() {
    return (
        <div
            aria-hidden="true"
            className="overture-out fixed inset-0 z-[60] flex flex-col justify-center overflow-hidden bg-ink px-6"
        >
            <span
                className="reveal-sweep pointer-events-none absolute inset-x-0 h-24"
                style={{
                    background:
                        'linear-gradient(180deg, transparent, rgb(var(--glow-rgb) / 0.18), transparent)',
                }}
            />
            <div className="mx-auto w-full max-w-[480px]">
                <div className="overflow-hidden">
                    <p
                        className="overture-line text-[32px] font-extrabold leading-[1.16] tracking-[-0.03em] text-fg sm:text-[38px]"
                        style={{ animationDelay: '100ms' }}
                    >
                        내 남친이 맞팔 중인 여자들,
                    </p>
                </div>
                <div className="overflow-hidden">
                    <p
                        className="overture-line text-[32px] font-extrabold leading-[1.16] tracking-[-0.03em] text-blood sm:text-[38px]"
                        style={{ animationDelay: '260ms' }}
                    >
                        누가 제일 위험할까?
                    </p>
                </div>
                <div className="mt-5 overflow-hidden">
                    <p
                        className="overture-line text-[18px] font-medium leading-snug text-fg-dim sm:text-[20px]"
                        style={{ animationDelay: '640ms' }}
                    >
                        지금 바로 확인해 보세요.
                    </p>
                </div>
            </div>
        </div>
    );
}
