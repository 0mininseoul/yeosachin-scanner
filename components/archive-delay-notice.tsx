'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Eyebrow, ghostCls, primaryCls } from './case-ui';
import { ARCHIVE_NOTICE_EVENTS, trackEvent } from '@/lib/services/analytics';
import {
    ARCHIVE_DELAY_NOTICE_STORAGE_KEY,
    encodeDelayNoticeDismissal,
    isDelayNoticeSuppressed,
    type DelayNoticeDismissScope,
} from '@/lib/services/analysis/archive-delay-notice';

/**
 * Delay apology for a paying user whose result has not landed yet.
 *
 * Whether this user qualifies at all is decided on the server (see
 * app/mypage/page.tsx); this component only owns the per-browser re-display
 * rule, which cannot be evaluated during SSR without causing a hydration
 * mismatch. It therefore mounts closed and opens in an effect.
 *
 * Presentation is a bottom sheet under 640px and an ordinary centred dialog
 * above it: the archive is a phone-first utility screen, and a sheet keeps the
 * list visible and the actions under the thumb.
 */

function focusableElements(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(element => !element.hasAttribute('hidden'));
}

function readSuppression(): boolean {
    try {
        return isDelayNoticeSuppressed(
            window.localStorage.getItem(ARCHIVE_DELAY_NOTICE_STORAGE_KEY),
            Date.now(),
        );
    } catch {
        // Restricted storage must not cost the user the notice.
        return false;
    }
}

function persistDismissal(scope: DelayNoticeDismissScope) {
    try {
        window.localStorage.setItem(
            ARCHIVE_DELAY_NOTICE_STORAGE_KEY,
            encodeDelayNoticeDismissal(scope, Date.now()),
        );
    } catch {
        // A browser that refuses storage still gets the notice closed for now.
    }
}

/* localStorage cannot be read while rendering on the server, so the first
   client render must still match the server's. This resolves false on the
   server and during hydration, then true, which is the sanctioned two-pass. */
const subscribeToNothing = () => () => {};

export function ArchiveDelayNotice() {
    const hydrated = useSyncExternalStore(subscribeToNothing, () => true, () => false);
    const [suppressedAtMount] = useState(
        () => typeof window !== 'undefined' && readSuppression(),
    );
    const [dismissed, setDismissed] = useState(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const confirmRef = useRef<HTMLButtonElement>(null);

    const open = hydrated && !suppressedAtMount && !dismissed;

    const impressionReported = useRef(false);
    useEffect(() => {
        if (!open || impressionReported.current) return;
        impressionReported.current = true;
        trackEvent(ARCHIVE_NOTICE_EVENTS.DELAY_SHOWN);
    }, [open]);

    const dismiss = useCallback((scope: DelayNoticeDismissScope) => {
        persistDismissal(scope);
        trackEvent(ARCHIVE_NOTICE_EVENTS.DELAY_DISMISSED, { notice_dismiss_scope: scope });
        setDismissed(true);
    }, []);

    /* Scrim and Escape are the same "close for now" the confirm button is, so
       they take the same 24h snooze rather than a separate un-tracked path. */
    const snooze = useCallback(() => dismiss('snoozed'), [dismiss]);

    useEffect(() => {
        if (!open) return;

        const restoreFocusTo = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        confirmRef.current?.focus();

        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                snooze();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const elements = focusableElements(dialogRef.current);
            if (elements.length === 0) {
                event.preventDefault();
                dialogRef.current.focus();
                return;
            }
            const first = elements[0]!;
            const last = elements.at(-1)!;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.body.style.overflow = previousOverflow;
            restoreFocusTo?.focus();
        };
    }, [open, snooze]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-5">
            <div className="absolute inset-0 bg-ink/80 backdrop-blur-sm" onClick={snooze} />

            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="archive-delay-notice-title"
                aria-describedby="archive-delay-notice-body"
                tabIndex={-1}
                className="anim-sheet-rise relative w-full border-t border-line bg-ink-2 shadow-2xl sm:max-w-[380px] sm:border sm:border-line"
            >
                {/* sheet affordance, mobile only */}
                <span aria-hidden="true" className="mx-auto mt-2.5 block h-[3px] w-9 bg-line-2 sm:hidden" />

                <div className="flex gap-3.5 px-5 pb-5 pt-4 sm:px-6 sm:pb-6 sm:pt-5">
                    {/* the amber rail the archive already uses for "결과 대기 중" */}
                    <span aria-hidden="true" className="w-0.5 shrink-0 self-stretch bg-amber" />

                    <div className="min-w-0 flex-1">
                        <Eyebrow>판독 지연 안내</Eyebrow>

                        <h2
                            id="archive-delay-notice-title"
                            className="mt-3 text-[19px] font-extrabold leading-snug tracking-tight text-fg"
                        >
                            조금만 더 기다려 주세요
                        </h2>

                        <div
                            id="archive-delay-notice-body"
                            className="mt-3 space-y-2 text-[13px] leading-relaxed text-fg-dim"
                        >
                            <p>최근 이용자가 크게 늘면서 판독 대기열이 길어졌습니다.</p>
                            <p>결제하신 판독은 정상적으로 접수되어 순서대로 진행 중이에요.</p>
                            <p className="text-fg">
                                늦어도 2일 이내에 가입하신 이메일로 결과 링크를 보내드릴게요.
                            </p>
                        </div>

                        <p className="mt-3.5 text-[12px] text-fg-mute">기다리게 해서 죄송합니다.</p>

                        <div className="mt-5 space-y-3">
                            <button
                                ref={confirmRef}
                                type="button"
                                onClick={snooze}
                                className={primaryCls}
                            >
                                확인했어요
                            </button>
                            <button
                                type="button"
                                onClick={() => dismiss('permanent')}
                                className={ghostCls}
                            >
                                다시 보지 않기
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
