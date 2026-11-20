// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressCandidateMediaV1 } from '@/lib/contracts/analysis-v2';
import { MAX_SCREENED_CANDIDATES, type ActiveCandidateMedia } from '@/lib/services/analysis/progress-faces';

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

import { ProgressFaces, progressRailCopyGeometry } from '../../../../components/progress-faces';

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
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    function render(imageUrl: string) {
        renderSnapshot(root, active(imageUrl), media(imageUrl));
    }

    function loadedImages(copy: Element | null) {
        return [...(copy?.querySelectorAll('[data-progress-image]') ?? [])];
    }

    function loadProbedImages(...sources: string[]) {
        act(() => {
            for (const src of sources) imageLoadHandlers.get(src)?.at(-1)?.();
        });
    }

    it('preserves the decoded survivors when a new active candidate overlaps a full server window', () => {
        const fullHistory = Array.from({ length: MAX_SCREENED_CANDIDATES }, (_, index) => ({
            candidateKey: (index + 1).toString(16).padStart(64, '0'),
            maskedUsername: `candidate-${index}***`,
            imageUrl: `/api/image-proxy?token=candidate-${index}`,
            feedImageUrls: [],
        }));
        act(() => root.render(<ProgressFaces active={null} candidateMedia={fullHistory} />));
        loadProbedImages(...fullHistory.map(candidate => candidate.imageUrl));
        const before = loadedImages(container.querySelector('[data-progress-copy]'));
        expect(before).toHaveLength(MAX_SCREENED_CANDIDATES);

        const nextActive: ActiveCandidateMedia = {
            candidateKey: 'e'.repeat(64),
            maskedUsername: 'next***',
            imageUrl: '/api/image-proxy?token=next-candidate',
        };
        renderSnapshot(root, nextActive, fullHistory);

        const after = loadedImages(container.querySelector('[data-progress-copy]'));
        expect(after).toHaveLength(MAX_SCREENED_CANDIDATES - 1);
        expect(after.every((image, index) => image === before[index + 1])).toBe(true);

        const refreshedWindow = fullHistory.map(candidate => ({ ...candidate, imageUrl: `${candidate.imageUrl}-refreshed` }));
        renderSnapshot(root, nextActive, refreshedWindow);
        const afterRefresh = loadedImages(container.querySelector('[data-progress-copy]'));
        expect(afterRefresh).toHaveLength(MAX_SCREENED_CANDIDATES - 1);
        expect(afterRefresh.every((image, index) => image === after[index])).toBe(true);
        expect(container.querySelector(`[data-progress-retry-image="${refreshedWindow[0]!.imageUrl}"]`)).toBeNull();
    });

    it('packs the decoded photos together while three unavailable photos have one probe each', () => {
        vi.useFakeTimers();
        const [first, pending, broken, slow, last] = ['first', 'pending', 'broken', 'slow', 'last']
            .map(label => `/api/image-proxy?token=${label}`) as [string, string, string, string, string];
        const inBetween = [{
            ...media(first)[0]!,
            feedImageUrls: [pending, broken, slow],
        }, {
            ...media(first)[1]!,
            imageUrl: last,
        }];
        renderSnapshot(root, active(first), inBetween);
        loadProbedImages(first, last);
        act(() => imageErrorHandlers.get(broken)?.at(-1)?.());
        act(() => vi.advanceTimersByTime(1_000));
        act(() => imageErrorHandlers.get(broken)?.at(-1)?.());
        act(() => vi.advanceTimersByTime(2_000));
        act(() => imageErrorHandlers.get(broken)?.at(-1)?.());
        const attempts = imageErrorHandlers.get(broken)?.length;
        act(() => vi.advanceTimersByTime(10_000));
        expect(imageErrorHandlers.get(broken)?.length).toBe(attempts);

        const copies = [...container.querySelectorAll('[data-progress-copy]')];
        expect(copies).toHaveLength(progressRailCopyGeometry(2).copyCount);
        for (const copy of copies) {
            expect(copy.children).toHaveLength(2);
            expect(loadedImages(copy).map(image => image.getAttribute('data-progress-image')))
                .toEqual([first, last]);
        }
        for (const hidden of [pending, slow]) {
            expect(container.querySelectorAll(`[data-progress-retry-image="${hidden}"]`)).toHaveLength(1);
        }
    });

    it.each(['blur', 'visibilitychange'] as const)(
        'resumes drift after %s when the browser never delivers pointerup',
        event => {
            vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
            const scheduleFrame = vi.fn<(callback: FrameRequestCallback) => number>(() => 1);
            vi.stubGlobal('requestAnimationFrame', scheduleFrame);
            const imageUrl = '/api/image-proxy?token=drift';
            render(imageUrl);
            act(() => imageLoadHandlers.get(imageUrl)?.[0]?.());
            const [, second] = container.querySelectorAll<HTMLElement>('[data-progress-copy]');
            const rail = second?.parentElement;
            if (!rail || !second) throw new Error('Expected a decoded two-copy rail.');
            Object.defineProperty(second, 'offsetLeft', { value: 94 });
            const frame = (time: number) => scheduleFrame.mock.lastCall?.[0](time);

            frame(100);
            frame(1_100);
            expect(rail.scrollLeft).toBe(26);
            rail.dispatchEvent(new Event('pointerdown', { bubbles: true }));
            frame(2_100);
            expect(rail.scrollLeft).toBe(26);

            (event === 'blur' ? window : document).dispatchEvent(new Event(event));
            frame(3_100);
            frame(4_100);
            expect(rail.scrollLeft).toBe(52);
        },
    );

    it('keeps a manual drag paused when another photo decodes', () => {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
        const scheduleFrame = vi.fn<(callback: FrameRequestCallback) => number>(() => 1);
        vi.stubGlobal('requestAnimationFrame', scheduleFrame);
        const first = '/api/image-proxy?token=drag-first';
        const second = '/api/image-proxy?token=drag-second';
        renderSnapshot(root, active(first), [{ ...media(first)[0]!, feedImageUrls: [second] }]);
        loadProbedImages(first);
        const [, copy] = container.querySelectorAll<HTMLElement>('[data-progress-copy]');
        const rail = copy?.parentElement;
        if (!rail || !copy) throw new Error('Expected a decoded two-copy rail.');
        Object.defineProperty(copy, 'offsetLeft', { value: 94 });
        const frame = (time: number) => scheduleFrame.mock.lastCall?.[0](time);

        frame(100);
        frame(1_100);
        rail.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        loadProbedImages(second);
        frame(2_100);
        frame(3_100);
        expect(rail.scrollLeft).toBe(26);

        window.dispatchEvent(new Event('pointerup'));
        frame(4_100);
        frame(5_100);
        expect(rail.scrollLeft).toBe(52);
    });

    it('renders only owned Dev avatars when local assets are explicitly enabled', () => {
        const imageUrl = '/demo-avatars/synthetic-blurred-avatar-1-v1.png';
        act(() => root.render(<ProgressFaces active={active(imageUrl)} candidateMedia={media(imageUrl)} allowLocalAssets />));
        expect(imageLoadHandlers.get(imageUrl)?.length).toBeGreaterThan(0);
        act(() => imageLoadHandlers.get(imageUrl)?.[0]?.());
        expect(container.querySelector('[data-progress-image]')?.getAttribute('data-progress-image')).toBe(imageUrl);
    });

    it('keeps local avatars disabled by default and denies remote/proxy/path bypasses in Dev', () => {
        render('/demo-avatars/synthetic-blurred-avatar-1-v1.png');
        expect(container.querySelector('[data-progress-copy]')).toBeNull();
        for (const imageUrl of ['https://example.com/avatar.png', '//example.com/avatar.png', '/api/image-proxy?token=unexpected', '/demo-avatars/%73ynthetic-blurred-avatar-1-v1.png', '/demo-avatars/../avatar.png', '/demo-avatars/synthetic-blurred-avatar-1-v1.png?x=1', '/avatar.png']) {
            act(() => root.render(<ProgressFaces key={imageUrl} active={active(imageUrl)} candidateMedia={media(imageUrl)} allowLocalAssets />));
            expect(container.querySelector('[data-progress-copy]')).toBeNull();
        }
    });

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
        loadProbedImages(imageUrl);

        const copyCount = container.querySelectorAll('[data-progress-copy]').length;
        expect(geometry.copyCount).toBe(6);
        expect(geometry.copyDistance).toBe(94);
        expect(geometry.maxScrollLeft).toBe(134);
        expect(geometry.maxScrollLeft).toBeGreaterThanOrEqual(geometry.copyDistance);
        expect(copyCount).toBe(geometry.copyCount);
    });

    it('renders enough two-tile copies for one full wrap to remain scrollable', () => {
        const imageUrl = '/api/image-proxy?token=two-tile';
        const feedUrl = '/api/image-proxy?token=two-tile-feed';
        const candidateMedia = [{
            candidateKey: CANDIDATE_KEY,
            maskedUsername: 'a***e',
            imageUrl,
            feedImageUrls: [feedUrl],
        }];
        const geometry = progressRailCopyGeometry(2);

        renderSnapshot(root, active(imageUrl), candidateMedia);
        loadProbedImages(imageUrl, feedUrl);

        const copyCount = container.querySelectorAll('[data-progress-copy]').length;
        expect(geometry.copyCount).toBe(4);
        expect(geometry.copyDistance).toBe(188);
        expect(geometry.maxScrollLeft).toBe(322);
        expect(geometry.maxScrollLeft).toBeGreaterThanOrEqual(geometry.copyDistance);
        expect(copyCount).toBe(geometry.copyCount);
    });

    it('keeps three copies for larger histories', () => {
        const imageUrl = '/api/image-proxy?token=larger-history';
        const feeds = [
            '/api/image-proxy?token=larger-history-feed-1',
            '/api/image-proxy?token=larger-history-feed-2',
        ];
        const candidateMedia = [{
            candidateKey: CANDIDATE_KEY,
            maskedUsername: 'a***e',
            imageUrl,
            feedImageUrls: feeds,
        }];

        renderSnapshot(root, active(imageUrl), candidateMedia);
        loadProbedImages(imageUrl, ...feeds);

        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(3);
    });

    it('does not arrange a rail before any collected image has loaded', () => {
        const imageUrl = '/api/image-proxy?token=wait-for-load';
        renderSnapshot(root, active(imageUrl), media(imageUrl));

        expect(container.querySelector('[data-progress-copy]')).toBeNull();
        expect(container.querySelectorAll('[data-progress-retry-image]')).toHaveLength(1);

        loadProbedImages(imageUrl);
        expect(container.querySelector('[data-progress-copy] [data-progress-image]')).toBeTruthy();
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
        const oldVisibleError = imageErrorHandlers.get(firstUrl)?.[
            Number(firstImage.getAttribute('data-progress-error-index'))
        ];
        expect(firstCopy.children).toHaveLength(1);
        expect(firstImage?.getAttribute('data-progress-image')).toContain('token=first');
        expect((firstTile as HTMLElement).style.width).toBe('84px');
        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(6);

        render(firstUrl);
        const repeatedCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        expect(repeatedCopy?.querySelector('[data-progress-image]')?.parentElement).toBe(firstTile);
        expect(repeatedCopy?.children).toHaveLength(1);

        render(refreshedUrl);
        const refreshedCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        expect(refreshedCopy?.querySelector('[data-progress-image]')).toBe(firstImage);
        loadProbedImages(refreshedUrl);
        const refreshedImage = [...(refreshedCopy?.querySelectorAll('[data-progress-image]') ?? [])]
            .find(image => image.getAttribute('data-progress-image')?.includes('token=refreshed'));
        expect(refreshedImage).toBeTruthy();
        expect(refreshedImage?.parentElement).toBe(firstTile);
        expect((refreshedImage?.parentElement as HTMLElement).style.width).toBe('84px');
        expect(refreshedImage?.getAttribute('data-progress-image')).toContain('token=refreshed');
        expect(refreshedCopy?.children).toHaveLength(1);
        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(6);

        act(() => oldVisibleError?.());
        expect(refreshedCopy?.querySelector('[data-progress-image]')).toBe(refreshedImage);
    });

    it('compacts every copy and gives a failed visible source one recovery wave', () => {
        const firstUrl = '/api/image-proxy?token=visible-before-failure';
        const secondUrl = '/api/image-proxy?token=visible-survivor';
        const history = [{ ...media(firstUrl)[0]!, feedImageUrls: [secondUrl] }];
        renderSnapshot(root, active(firstUrl), history);
        loadProbedImages(firstUrl, secondUrl);

        const firstCopy = container.querySelector('[data-progress-copy]');
        const firstImage = loadedImages(firstCopy)[0];
        const errorHandler = imageErrorHandlers.get(firstUrl)?.[
            Number(firstImage?.getAttribute('data-progress-error-index'))
        ];
        expect(errorHandler).toBeDefined();
        act(() => errorHandler?.());

        const copies = [...container.querySelectorAll('[data-progress-copy]')];
        expect(copies).toHaveLength(progressRailCopyGeometry(1).copyCount);
        for (const copy of copies) {
            expect(copy.children).toHaveLength(1);
            expect(loadedImages(copy)[0]?.getAttribute('data-progress-image')).toBe(secondUrl);
        }
        expect(container.querySelectorAll(`[data-progress-retry-image="${firstUrl}"]`)).toHaveLength(1);

        loadProbedImages(firstUrl);
        const recoveredImage = loadedImages(firstCopy)[0];
        expect(recoveredImage?.getAttribute('data-progress-image')).toBe(firstUrl);
        const repeatedError = imageErrorHandlers.get(firstUrl)?.[
            Number(recoveredImage?.getAttribute('data-progress-error-index'))
        ];
        expect(repeatedError).toBeDefined();
        act(() => repeatedError?.());
        expect(container.querySelector(`[data-progress-retry-image="${firstUrl}"]`)).toBeNull();
        expect(loadedImages(firstCopy)[0]?.getAttribute('data-progress-image')).toBe(secondUrl);
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
        expect(container.querySelector(`[data-progress-retry-image="${freshServerUrl}"]`)).toBeTruthy();
        loadProbedImages(freshServerUrl, activeOnlyUrl);
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

    it('keeps retained media through an explicit publication-lag reset', () => {
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

        expect(container.querySelector('[data-progress-image]')).toBeTruthy();
        expect(container.querySelector('[data-progress-copy]')).toBeTruthy();
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
