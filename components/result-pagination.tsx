'use client';

import type { ResultPaginationView } from '@/lib/services/analysis/owner-view-presentation';

const baseButton =
  'min-w-[38px] border px-2.5 py-2 text-[13px] font-bold tabular-nums transition-colors disabled:cursor-not-allowed';
const stepButton =
  `${baseButton} border-line-2 text-fg hover:bg-panel disabled:text-fg-mute disabled:hover:bg-transparent`;
const pageButton =
  `${baseButton} border-line-2 text-fg hover:bg-panel disabled:text-fg-mute disabled:hover:bg-transparent`;
const currentButton = `${baseButton} border-blood bg-blood text-white`;

// Cursor-safe numbered pager. `view` already limits the page numbers to visited
// pages plus one frontier page; this component only renders and delegates clicks.
export function ResultPagination({
  view,
  busy,
  failed,
  label,
  onGoto,
}: {
  view: ResultPaginationView | null;
  busy: boolean;
  failed: boolean;
  label: string;
  onGoto: (pageIndex: number) => void;
}) {
  if (!view) return null;

  const current = view.items.find(
    (item): item is Extract<typeof item, { type: 'page' }> => item.type === 'page' && item.current,
  );
  const currentIndex = current?.pageIndex ?? 0;

  return (
    <nav className="mt-6" aria-label={`${label} 페이지`}>
      <div className="flex items-center justify-center gap-1.5">
        <button
          type="button"
          onClick={() => onGoto(currentIndex - 1)}
          disabled={busy || !view.hasPrevious}
          aria-label="이전 페이지"
          className={stepButton}
        >
          이전
        </button>

        {view.items.map((item) =>
          item.type === 'ellipsis' ? (
            <span key={item.key} aria-hidden="true" className="px-1 text-[13px] text-fg-mute">
              …
            </span>
          ) : (
            <button
              key={item.pageIndex}
              type="button"
              onClick={() => onGoto(item.pageIndex)}
              disabled={busy || item.current}
              aria-current={item.current ? 'page' : undefined}
              aria-label={`${item.label} 페이지`}
              className={item.current ? currentButton : pageButton}
            >
              {item.label}
            </button>
          ),
        )}

        <button
          type="button"
          onClick={() => onGoto(currentIndex + 1)}
          disabled={busy || !view.hasNext}
          aria-label="다음 페이지"
          className={stepButton}
        >
          다음
        </button>
      </div>

      {busy && (
        <p className="mt-2 text-center text-[11px] text-fg-mute" role="status">
          불러오는 중…
        </p>
      )}
      {failed && !busy && (
        <p className="mt-2 text-center text-[11px] text-blood" role="alert">
          {label}을 불러오지 못했습니다. 다시 시도해 주세요.
        </p>
      )}
    </nav>
  );
}
