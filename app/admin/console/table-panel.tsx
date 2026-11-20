'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ErrorNotice } from './console-ui';

export type ActiveFilter = { key: string; label: string; onClear: () => void };

function SearchIcon() {
    return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>;
}

function FilterIcon() {
    return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8.5V19l-4 2v-7.5z" /></svg>;
}

/**
 * Compact table toolbar: a summary on the left, search and filter tucked
 * behind icon buttons on the right. Active filters stay visible as chips
 * while the filter row is closed.
 */
export function TableTools({ summary, search, filters, activeFilters = [], actions }: {
    summary: ReactNode;
    search?: { value: string; placeholder: string; label: string; onChange: (value: string) => void };
    filters?: ReactNode;
    activeFilters?: readonly ActiveFilter[];
    actions?: ReactNode;
}) {
    const [searchOpen, setSearchOpen] = useState(() => Boolean(search?.value));
    const [filtersOpen, setFiltersOpen] = useState(false);
    const searchRef = useRef<HTMLInputElement>(null);
    const filterId = useId();
    const searchId = useId();
    const showSearch = Boolean(search) && (searchOpen || Boolean(search?.value));

    useEffect(() => {
        if (searchOpen) searchRef.current?.focus();
    }, [searchOpen]);

    return <div className="ac-tools">
        <div className="ac-tools-bar">
            <div className="ac-tools-summary">{summary}</div>
            {activeFilters.length > 0 && !filtersOpen ? <div className="ac-filter-chips">
                {activeFilters.map(filter => <button key={filter.key} type="button" className="ac-filter-chip" onClick={filter.onClear} aria-label={`${filter.label} 필터 해제`}>
                    {filter.label}<span aria-hidden="true">×</span>
                </button>)}
            </div> : null}
            <span className="ac-spacer" />
            {showSearch && search ? <div className="ac-tools-search">
                <SearchIcon />
                <label className="ac-sr" htmlFor={searchId}>{search.label}</label>
                <input
                    id={searchId}
                    ref={searchRef}
                    type="search"
                    value={search.value}
                    placeholder={search.placeholder}
                    onChange={event => search.onChange(event.target.value)}
                    onKeyDown={event => {
                        if (event.key === 'Escape') { search.onChange(''); setSearchOpen(false); }
                    }}
                    onBlur={() => { if (!search.value) setSearchOpen(false); }}
                />
            </div> : null}
            {search && !showSearch ? <button type="button" className="ac-icon-btn" aria-label={search.label} title={search.label} onClick={() => setSearchOpen(true)}>
                <SearchIcon /><span>검색</span>
            </button> : null}
            {filters ? <button
                type="button"
                className={`ac-icon-btn${filtersOpen ? ' is-on' : ''}`}
                aria-expanded={filtersOpen}
                aria-controls={filterId}
                onClick={() => setFiltersOpen(open => !open)}
            >
                <FilterIcon /><span>필터</span>{activeFilters.length > 0 ? <em>{activeFilters.length}</em> : null}
            </button> : null}
            {actions}
        </div>
        {filters && filtersOpen ? <div className="ac-tools-filters" id={filterId}>
            {filters}
            {activeFilters.length > 0 ? <button type="button" className="ac-link ac-tools-reset" onClick={() => activeFilters.forEach(filter => filter.onClear())}>필터 모두 해제</button> : null}
        </div> : null}
    </div>;
}

function noopSubscribe() { return () => {}; }

/**
 * A table that scrolls inside its own panel (sticky header) and loads the
 * next page when the operator scrolls near the bottom. Browsers without
 * IntersectionObserver get a plain "더 불러오기" button instead.
 */
export function TablePanel({ tools, error, onRetry, loading, loadedLabel, hasNext, onLoadMore, children }: {
    tools: ReactNode;
    error: string | null;
    onRetry: () => void;
    loading: boolean;
    loadedLabel: string;
    hasNext: boolean;
    onLoadMore: () => void;
    children: ReactNode;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const loadMoreRef = useRef(onLoadMore);
    const observerSupported = useSyncExternalStore(
        noopSubscribe,
        () => 'IntersectionObserver' in window,
        () => true,
    );

    useEffect(() => { loadMoreRef.current = onLoadMore; }, [onLoadMore]);

    useEffect(() => {
        if (!observerSupported || !hasNext || loading || error) return;
        const root = scrollRef.current;
        const sentinel = sentinelRef.current;
        if (!root || !sentinel) return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) loadMoreRef.current();
        }, { root, rootMargin: '0px 0px 320px 0px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [error, hasNext, loading, observerSupported]);

    return <section className="ac-card ac-tpanel">
        {tools}
        <ErrorNotice message={error} onRetry={onRetry} />
        <div className="ac-tscroll" ref={scrollRef} tabIndex={0} aria-label="테이블 스크롤 영역">
            {children}
            <div ref={sentinelRef} className="ac-sentinel" aria-hidden="true" />
        </div>
        <footer className="ac-tfoot" aria-live="polite">
            <span>{loadedLabel}</span>
            <span className="ac-tfoot-state">
                {loading
                    ? '불러오는 중…'
                    : hasNext
                        ? observerSupported
                            ? '아래로 스크롤하면 더 불러옵니다'
                            : <button type="button" className="ac-btn ac-btn--sm" onClick={onLoadMore}>더 불러오기</button>
                        : '마지막 행까지 불러왔습니다'}
            </span>
        </footer>
    </section>;
}
