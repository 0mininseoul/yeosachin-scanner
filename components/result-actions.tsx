'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/* Kakao's speech-bubble mark in its brand yellow. Inside the menu it identifies
   the channel; on the closed trigger it would be the only saturated colour above
   the headline, which is what made the old inline buttons win the first look. */
function KakaoMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 3C6.9 3 2.8 6.2 2.8 10.2c0 2.55 1.66 4.79 4.19 6.11-.19.68-.68 2.47-.78 2.85-.12.48.18.47.37.35.15-.1 2.4-1.63 3.38-2.3.66.1 1.34.15 2.04.15 5.1 0 9.2-3.2 9.2-7.16C21.2 6.2 17.1 3 12 3z" />
    </svg>
  );
}

function InstagramMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z" />
    </svg>
  );
}

const itemCls =
  'flex w-full items-center gap-2.5 whitespace-nowrap px-3 py-2.5 text-left text-[12.5px] font-semibold text-fg transition-colors hover:bg-panel disabled:opacity-50';

const INSTAGRAM_DM_APP_URL = 'instagram://direct-inbox';
const INSTAGRAM_DM_WEB_URL = 'https://www.instagram.com/direct/inbox/';

interface Notice {
    text: string;
    /** Carries its own gesture, for when a delayed navigation was refused. */
    action?: { label: string; run: () => void };
}

function isPhone(): boolean {
  return /iphone|ipad|ipod|android/i.test(navigator.userAgent);
}

/* Last-resort copy for browsers without the async clipboard API.
 *
 * Not the first choice: on iOS `execCommand('copy')` reports success and copies
 * nothing, which is worse than failing — it produced a "링크를 복사했어요"
 * notice over an empty clipboard. Only reachable when `navigator.clipboard` is
 * missing entirely, where a wrong answer beats no attempt.
 *
 * iOS ignores `select()` on a readonly field, hence the explicit Range. */
function copyTextSync(text: string): boolean {
  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.contentEditable = 'true';
    field.readOnly = false;
    // Off-screen but still focusable; `display:none` would break the selection.
    field.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
    document.body.appendChild(field);

    const range = document.createRange();
    range.selectNodeContents(field);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    field.setSelectionRange(0, text.length);

    const copied = document.execCommand('copy');
    selection?.removeAllRanges();
    field.remove();
    return copied;
  } catch {
    return false;
  }
}

/* Overflow menu for the report's secondary actions.
 *
 * These sit above the headline, where anything with a border and a label wins the
 * first fixation. Collapsing them behind a single glyph puts the subject first —
 * and matches Instagram's own post menu, which this audience already knows.
 */
export function ResultActions({
  onKakaoShare,
  kakaoBusy,
  kakaoAvailable,
  shareUrl,
  onPrepare,
  onShare,
}: {
  onKakaoShare: () => void;
  kakaoBusy: boolean;
  kakaoAvailable: boolean;
  /** This result's share link; null while it is still being minted. */
  shareUrl: string | null;
  /** Fired on intent, so the slow work is done before the tap. */
  onPrepare?: () => void;
  /** Fired only after a clipboard-backed share action has confirmed success. */
  onShare?: (channel: 'clipboard' | 'instagram_dm') => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // The notice has to survive the trip into Instagram and still be there on the
  // way back, so its countdown only runs while this tab is actually on screen.
  useEffect(() => {
    if (!notice) return;
    // One that offers a way out stays until it is used or dismissed; timing it
    // out would take the escape hatch away exactly when it is needed.
    if (notice.action) return;
    let timer = 0;
    const arm = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== 'visible') return;
      timer = window.setTimeout(() => setNotice(null), 5000);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [notice]);

  const linkToShare = shareUrl;

  const copy = async () => {
    if (!linkToShare) {
      setOpen(false);
      setNotice({ text: '결과 공유 링크를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    let ok = false;
    if (navigator.clipboard?.writeText) {
      // A rejection here is the real answer; copyTextSync would only paper over
      // it with a success it cannot deliver.
      ok = await navigator.clipboard.writeText(linkToShare).then(() => true, () => false);
    } else {
      ok = copyTextSync(linkToShare);
    }
    if (!ok) {
      setOpen(false);
      setNotice({ text: '링크 복사에 실패했습니다.' });
      return;
    }
    setCopied(true);
    onShare?.('clipboard');
    // Let the confirmation register before the menu disappears.
    window.setTimeout(() => {
      setOpen(false);
      setCopied(false);
    }, 900);
  };

  /* Instagram exposes no way to prefill a DM or to choose a recipient from the
     outside — `direct-inbox` only opens the inbox. So the link goes to the
     clipboard first and the user pastes it into whichever chat they pick.

     On a phone only the app scheme runs. An earlier timer-based web fallback
     fired even when the app had opened, leaving instagram.com in a tab behind
     the browser; there is no reliable signal that a scheme hand-off succeeded,
     so the platform decides instead of a guess. */
  const shareToInstagramDm = () => {
    if (!linkToShare) {
      setOpen(false);
      setNotice({ text: '결과 공유 링크를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    /* The clipboard write must not be awaited — it is *started* inside the
       gesture and left to settle on its own, so nothing delays what follows. */
    const write = navigator.clipboard?.writeText(linkToShare);
    setOpen(false);
    const failed = () => setNotice({ text: '링크를 복사하지 못했어요. 결과 페이지에서 다시 시도해 주세요.' });
    let copied = false;
    let destinationReady = false;
    const reportIfReady = () => {
      if (copied && destinationReady) onShare?.('instagram_dm');
    };
    const markCopied = () => {
      copied = true;
      reportIfReady();
    };
    if (write) {
      write.then(markCopied, failed);
    } else if (!copyTextSync(linkToShare)) {
      failed();
    } else {
      markCopied();
    }

    if (!isPhone()) {
      let opened: Window | null = null;
      try {
        opened = window.open(INSTAGRAM_DM_WEB_URL, '_blank', 'noopener,noreferrer');
      } catch {
        // Treat a browser popup exception like a blocked hand-off.
      }
      if (opened) {
        destinationReady = true;
        setNotice({ text: '링크를 복사했어요. DM 입력창에 붙여넣어 주세요.' });
        reportIfReady();
      } else {
        setNotice({
          text: '링크를 복사했어요. 인스타그램을 열어 DM 입력창에 붙여넣어 주세요.',
          action: {
            label: '인스타그램 열기',
            run: () => {
              let retry: Window | null = null;
              try {
                retry = window.open(INSTAGRAM_DM_WEB_URL, '_blank', 'noopener,noreferrer');
              } catch {
                // Keep the notice open; no share event is emitted on failure.
              }
              if (retry) {
                destinationReady = true;
                reportIfReady();
              }
            },
          },
        });
      }
      return;
    }

    /* The hand-off waits for its own tap rather than firing on a timer.
       A delayed scheme navigation has drifted out of the tap that caused it, so
       the browser stops and asks whether this site may open another app — and
       that dialog is a worse thing to meet than one more button. Opening from
       the button keeps the navigation inside a real gesture, and the notice
       gets read on the way past instead of being raced. */
    setNotice({
      text: '링크를 복사했어요. DM 입력창에 붙여넣어 주세요.',
      action: {
        label: '인스타그램 열기',
        run: () => { window.location.href = INSTAGRAM_DM_APP_URL; },
      },
    });
    destinationReady = true;
    reportIfReady();
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      {/* Portalled to the body: a `position: fixed` toast resolves against the
          nearest transformed ancestor, and this page animates its blocks, so
          in place it would land wherever that transform put it. */}
      {notice && typeof document !== 'undefined'
        && createPortal(
          <div
            role="status"
            className="toast-rise fixed inset-x-0 bottom-0 z-50 border-t-2 border-blood bg-ink-2 px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4 shadow-[0_-18px_44px_-12px_rgba(0,0,0,0.9)]"
          >
            <div className="mx-auto flex max-w-[480px] flex-col">
              <span className="text-[15px] font-bold leading-snug tracking-tight text-fg">
                {notice.text}
              </span>
              {notice.action && (
                /* Instagram's own gradient and mark rather than the app's
                   crimson: crimson means danger everywhere else in this report,
                   and the button is only saying where it goes next. */
                <button
                  type="button"
                  onClick={notice.action.run}
                  className="mt-3.5 flex w-full items-center justify-center gap-2 py-3 text-[14px] font-bold text-white transition-opacity hover:opacity-90"
                  style={{
                    background:
                      'linear-gradient(95deg, #F58529 0%, #DD2A7B 45%, #8134AF 75%, #515BD4 100%)',
                  }}
                >
                  <InstagramMark className="h-4 w-4 shrink-0" />
                  {notice.action.label}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
      <button
        ref={triggerRef}
        type="button"
        // On press rather than on click: the token round trip is the slowest
        // link in the chain, and this buys it the whole press-to-release span.
        onPointerDown={() => { if (!open) onPrepare?.(); }}
        onClick={() => {
          setOpen(value => {
            if (!value) onPrepare?.();
            return !value;
          });
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="판독 결과 공유하기"
        className={`-mr-1.5 inline-flex h-8 w-8 items-center justify-center text-fg-dim transition-colors hover:text-fg ${
          open ? 'text-fg' : ''
        }`}
      >
        <svg className="h-[17px] w-[17px]" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 3v12M12 3 7.5 7.5M12 3l4.5 4.5M4.5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-5.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="square"
          />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          // Sized to its longest label instead of a fixed width, which left ~60px
          // of dead space to the right of every item.
          className="absolute right-0 top-full z-30 mt-1 w-max border border-line-2 bg-ink-2 py-1 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.8)]"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onKakaoShare();
            }}
            /* Kakao opens its sheet from inside the tap, so the link has to
               exist before the finger lands. Staying disabled for the extra
               moment is what keeps this off the OS share sheet. */
            disabled={kakaoBusy || (kakaoAvailable && !shareUrl)}
            className={itemCls}
          >
            {kakaoAvailable ? (
              <KakaoMark className="h-3.5 w-3.5 shrink-0 text-[#FEE500]" />
            ) : (
              <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 3v12M12 3 7.5 7.5M12 3l4.5 4.5M4.5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-5.5"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="square"
                />
              </svg>
            )}
            {kakaoAvailable ? '카카오톡 공유' : '공유'}
          </button>
          <button type="button" role="menuitem" onClick={shareToInstagramDm} className={itemCls}>
            <InstagramMark className="h-3.5 w-3.5 shrink-0" />
            DM 공유
          </button>
          <button type="button" role="menuitem" onClick={copy} className={itemCls}>
            {copied ? (
              <svg className="h-3.5 w-3.5 shrink-0 text-jade" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="m4.5 12.5 5 5 10-11" stroke="currentColor" strokeWidth="2.2" strokeLinecap="square" />
              </svg>
            ) : (
              <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1-1"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            )}
            {copied ? '복사됨' : '링크 복사'}
          </button>
        </div>
      )}
    </div>
  );
}
