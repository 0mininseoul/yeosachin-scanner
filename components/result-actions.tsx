'use client';

import { useEffect, useRef, useState } from 'react';

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
  copyUrl,
}: {
  onKakaoShare: () => void;
  kakaoBusy: boolean;
  kakaoAvailable: boolean;
  copyUrl: string;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyUrl);
      setCopied(true);
      // Let the confirmation register before the menu disappears.
      window.setTimeout(() => {
        setOpen(false);
        setCopied(false);
      }, 900);
    } catch {
      setOpen(false);
      alert('링크 복사에 실패했습니다.');
    }
  };

  /* Instagram exposes no way to prefill a DM or to choose a recipient from the
     outside — `direct-inbox` only opens the inbox. So the link goes to the
     clipboard first and the user pastes it into whichever chat they pick. */
  const shareToInstagramDm = async () => {
    let copiedToClipboard = false;
    try {
      await navigator.clipboard.writeText(copyUrl);
      copiedToClipboard = true;
    } catch {
      copiedToClipboard = false;
    }
    setOpen(false);
    if (copiedToClipboard) {
      alert('링크를 복사했어요. 인스타그램 DM 창에 붙여넣어 주세요.');
    }

    // The app scheme silently does nothing on desktop, so fall back to the web
    // inbox if we are still here a moment later.
    const openedAt = Date.now();
    const fallback = window.setTimeout(() => {
      if (document.visibilityState === 'visible' && Date.now() - openedAt < 2500) {
        window.open(INSTAGRAM_DM_WEB_URL, '_blank', 'noopener,noreferrer');
      }
    }, 1200);
    const clearFallback = () => window.clearTimeout(fallback);
    document.addEventListener('visibilitychange', clearFallback, { once: true });
    window.location.href = INSTAGRAM_DM_APP_URL;
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(value => !value)}
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
            disabled={kakaoBusy}
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
