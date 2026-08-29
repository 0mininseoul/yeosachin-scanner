// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressCandidateMediaV1 } from '@/lib/contracts/analysis-v2';
import type { ActiveCandidateMedia } from '@/lib/services/analysis/progress-faces';

const { imageErrorHandlers, imageLoadHandlers } = vi.hoisted(() => ({
    imageErrorHandlers: new Map<string, Array<() => void>>(),
    imageLoadHandlers: new Map<string, Array<() => void>>(),
}));

vi.mock('next/image', () => ({
    default: ({
        unoptimized,
        src,
        onError,
        onLoad,
        'data-progress-retry': dataProgressRetry,
    }: {
        unoptimized?: boolean;
        src: string;
        onError?: () => void;
        onLoad?: () => void;
        'data-progress-retry'?: string;
    }) => {
        void unoptimized;
        const errors = imageErrorHandlers.get(src) ?? [];
        const errorIndex = errors.length;
        if (onError) imageErrorHandlers.set(src, [...errors, onError]);
        if (onLoad) imageLoadHandlers.set(src, [
            ...(imageLoadHandlers.get(src) ?? []),
            onLoad,
        ]);
        return dataProgressRetry
            ? <div data-progress-retry-image={src} data-progress-error-index={errorIndex} onError={onError} onLoad={onLoad} />
            : <div data-progress-image={src} data-progress-error-index={errorIndex} onError={onError} onLoad={onLoad} />;
    },
}));
vi.mock('@/lib/services/result-local-image', () => ({
    safeResultImageUrl: (url: string | null | undefined) => url,
}));

import { ProgressFaces, progressRailCopyGeometry } from './progress-faces';

const CANDIDATE_KEY = 'a'.repeat(64);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

function active(imageUrl: string): ActiveCandidateMedia {
    return {
        candidateKey: CANDIDATE_KEY,
        maskedUsername: 'a***e',
        imageUrl,
        feedImageUrls: [],
    };
}

function media(imageUrl: string): ProgressCandidateMediaV1[] {
    return [{
        candidateKey: CANDIDATE_KEY,
        maskedUsername: 'a***e',
        imageUrl,
        feedImageUrls: [],
    }, {
        candidateKey: 'b'.repeat(64),
        maskedUsername: 'b***e',
        imageUrl: null,
        feedImageUrls: [],
    }];
}

function renderSnapshot(
    root: Root,
    activeMedia: ActiveCandidateMedia,
    candidateMedia: readonly ProgressCandidateMediaV1[],
) {
    act(() => {
        root.render(
            <ProgressFaces active={activeMedia} candidateMedia={candidateMedia} />
        );
    });
}

describe('ProgressFaces stable rail identity', () => {
    let root: Root;
    let container: HTMLDivElement;

    beforeEach(() => {
        imageErrorHandlers.clear();
        imageLoadHandlers.clear();
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        vi.unstubAllGlobals();
    });

    function render(imageUrl: string) {
        renderSnapshot(root, active(imageUrl), media(imageUrl));
    }

    it('renders enough one-tile copies for one full wrap to remain scrollable', () => {
        const imageUrl = '/api/image-proxy?token=one-tile';
        const candidateMedia = [{
            candidateKey: CANDIDATE_KEY,
            maskedUsername: 'a***e',
            imageUrl,
            feedImageUrls: [],
        }];
        const geometry = progressRailCopyGeometry(1);

        renderSnapshot(root, active(imageUrl), candidateMedia);

        const copyCount = container.querySelectorAll('[data-progress-copy]').length;
        expect(geometry.copyCount).toBe(6);
        expect(geometry.copyDistance).toBe(94);
        expect(geometry.maxScrollLeft).toBe(134);
        expect(geometry.maxScrollLeft).toBeGreaterThanOrEqual(geometry.copyDistance);
        expect(copyCount).toBe(geometry.copyCount);
    });

    it('renders enough two-tile copies for one full wrap to remain scrollable', () => {
        const imageUrl = '/api/image-proxy?token=two-tile';
        const candidateMedia = [{
            candidateKey: CANDIDATE_KEY,
            maskedUsername: 'a***e',
            imageUrl,
            feedImageUrls: ['/api/image-proxy?token=two-tile-feed'],
        }];
        const geometry = progressRailCopyGeometry(2);

        renderSnapshot(root, active(imageUrl), candidateMedia);

        const copyCount = container.querySelectorAll('[data-progress-copy]').length;
        expect(geometry.copyCount).toBe(4);
        expect(geometry.copyDistance).toBe(188);
        expect(geometry.maxScrollLeft).toBe(322);
        expect(geometry.maxScrollLeft).toBeGreaterThanOrEqual(geometry.copyDistance);
        expect(copyCount).toBe(geometry.copyCount);
    });

    it('keeps three copies for larger histories', () => {
        const imageUrl = '/api/image-proxy?token=larger-history';
        const candidateMedia = [{
            candidateKey: CANDIDATE_KEY,
            maskedUsername: 'a***e',
            imageUrl,
            feedImageUrls: [
                '/api/image-proxy?token=larger-history-feed-1',
                '/api/image-proxy?token=larger-history-feed-2',
            ],
        }];

        renderSnapshot(root, active(imageUrl), candidateMedia);

        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(3);
    });

    it('does not paint a bordered tile before a collected image has loaded', () => {
        const imageUrl = '/api/image-proxy?token=wait-for-load';
        renderSnapshot(root, active(imageUrl), media(imageUrl));

        const firstCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        const tile = firstCopy?.firstElementChild as HTMLElement | null;
        expect(firstCopy?.querySelector('[data-progress-image]')).toBeNull();
        expect(tile?.className).toContain('border-transparent');
        expect(tile?.className).not.toContain('border-line-2');

        act(() => {
            imageLoadHandlers.get(imageUrl)?.[0]?.();
        });
        expect(firstCopy?.querySelector('[data-progress-image]')).toBeTruthy();
    });

    it('keeps collected media and tile nodes stable across signed URL refreshes', () => {
        const firstUrl = '/api/image-proxy?token=first';
        const refreshedUrl = '/api/image-proxy?token=refreshed';

        render(firstUrl);
        act(() => {
            imageLoadHandlers.get(firstUrl)?.[0]?.();
        });
        const firstCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        if (!firstCopy) throw new Error('progress copy not rendered');
        const firstImage = firstCopy.querySelector('[data-progress-image]');
        const firstTile = firstImage?.parentElement;
        if (!firstTile || !firstImage) {
            throw new Error('expected collected image tile');
        }
        expect(firstCopy.children).toHaveLength(1);
        expect(firstImage?.getAttribute('data-progress-image')).toContain('token=first');
        expect((firstTile as HTMLElement).style.width).toBe('84px');
        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(6);

        render(firstUrl);
        const repeatedCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        expect(repeatedCopy?.querySelector('[data-progress-image]')?.parentElement).toBe(firstTile);
        expect(repeatedCopy?.children).toHaveLength(1);

        act(() => {
            const errorIndex = Number(firstCopy.querySelector('[data-progress-image]')
                ?.getAttribute('data-progress-error-index'));
            imageErrorHandlers.get(firstUrl)?.[errorIndex]?.();
        });
        expect(firstCopy.querySelector('[data-progress-image]')).toBeNull();
        expect(firstTile.className).toContain('border-transparent');
        expect((firstTile as HTMLElement).style.width).toBe('84px');

        render(refreshedUrl);
        const refreshedCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        expect(refreshedCopy?.querySelector('[data-progress-image]')).toBeNull();
        act(() => {
            imageLoadHandlers.get(refreshedUrl)?.[0]?.();
        });
        const refreshedImage = [...(refreshedCopy?.querySelectorAll('[data-progress-image]') ?? [])]
            .find(image => image.getAttribute('data-progress-image')?.includes('token=refreshed'));
        expect(refreshedImage).toBeTruthy();
        expect(refreshedImage?.parentElement).toBe(firstTile);
        expect((refreshedImage?.parentElement as HTMLElement).style.width).toBe('84px');
        expect(refreshedImage?.getAttribute('data-progress-image')).toContain('token=refreshed');
        expect(refreshedCopy?.children).toHaveLength(1);
        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(6);
    });

    it('prefers equal-richness re-signed server history over a stale active URL', () => {
        const staleActiveUrl = '/api/image-proxy?token=stale-active';
        const freshServerUrl = '/api/image-proxy?token=fresh-server';
        const activeOnlyUrl = '/api/image-proxy?token=active-only';

        render(staleActiveUrl);
        act(() => {
            imageLoadHandlers.get(staleActiveUrl)?.[0]?.();
        });
        const firstCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        if (!firstCopy) throw new Error('progress copy not rendered');

        expect(firstCopy.querySelector('[data-progress-image]')?.getAttribute('data-progress-image'))
            .toContain('token=stale-active');

        act(() => {
            root.render(
                <ProgressFaces
                    active={{
                        candidateKey: 'b'.repeat(64),
                        maskedUsername: 'b***e',
                        imageUrl: activeOnlyUrl,
                        feedImageUrls: [],
                    }}
                    candidateMedia={[{
                        candidateKey: CANDIDATE_KEY,
                        maskedUsername: 'a***e',
                        imageUrl: freshServerUrl,
                        feedImageUrls: [],
                    }]}
                />
            );
        });

        const refreshedCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        const retainedImage = refreshedCopy?.querySelector('[data-progress-image]');
        expect(retainedImage?.getAttribute('data-progress-image')).toContain('token=stale-active');
        const refreshedProbe = refreshedCopy?.querySelector('[data-progress-retry-image]');
        expect(refreshedProbe?.getAttribute('data-progress-retry-image')).toContain('token=fresh-server');
        act(() => {
            imageLoadHandlers.get(freshServerUrl)?.[0]?.();
            imageLoadHandlers.get(activeOnlyUrl)?.[0]?.();
        });
        const refreshedImage = refreshedCopy?.querySelector('[data-progress-image]');
        expect(refreshedImage?.getAttribute('data-progress-image')).toContain('token=fresh-server');
        expect(refreshedCopy?.children).toHaveLength(2);
        expect([...refreshedCopy!.querySelectorAll('[data-progress-image]')]
            .some(image => image.getAttribute('data-progress-image')?.includes('token=active-only')))
            .toBe(true);
        expect([...refreshedCopy!.children].every(child => (
            (child as HTMLElement).style.width === '84px'
        ))).toBe(true);
    });

    it('clears retained media only for an explicit publication-lag reset', () => {
        const imageUrl = '/api/image-proxy?token=before-reset';
        render(imageUrl);
        act(() => {
            imageLoadHandlers.get(imageUrl)?.[0]?.();
        });
        expect(container.querySelector('[data-progress-image]')).toBeTruthy();

        act(() => {
            root.render(
                <ProgressFaces
                    active={null}
                    candidateMedia={[]}
                    publicationLagReset
                />
            );
        });

        expect(container.querySelector('[data-progress-image]')).toBeNull();
        expect(container.querySelector('[data-progress-copy]')).toBeNull();
    });

    it('keeps the last-good image visible when a refreshed proxy source errors', () => {
        const firstUrl = '/api/image-proxy?token=last-good';
        const refreshedUrl = '/api/image-proxy?token=transient-error';

        render(firstUrl);
        act(() => {
            imageLoadHandlers.get(firstUrl)?.[0]?.();
        });
        render(refreshedUrl);

        act(() => {
            imageErrorHandlers.get(refreshedUrl)?.[0]?.();
        });

        const image = container.querySelector('[data-progress-image]');
        expect(image?.getAttribute('data-progress-image')).toContain('token=last-good');
        expect(container.querySelector('[data-progress-fallback]')).toBeNull();
    });

    it('retries a failed proxy source with a bounded timer instead of flashing fallback art', () => {
        vi.useFakeTimers();
        const imageUrl = '/api/image-proxy?token=recoverable';

        render(imageUrl);
        act(() => {
            imageErrorHandlers.get(imageUrl)?.[0]?.();
        });
        const handlersBeforeRetry = imageErrorHandlers.get(imageUrl)?.length ?? 0;
        expect(handlersBeforeRetry).toBeGreaterThan(0);

        act(() => vi.advanceTimersByTime(1_000));
        expect(imageErrorHandlers.get(imageUrl)?.length).toBeGreaterThan(handlersBeforeRetry);
        expect(container.querySelector('[data-progress-fallback]')).toBeNull();
    });
});
