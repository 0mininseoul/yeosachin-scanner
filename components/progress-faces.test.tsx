// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressCandidateMediaV1 } from '@/lib/contracts/analysis-v2';
import type { ActiveCandidateMedia } from '@/lib/services/analysis/progress-faces';

const { imageErrorHandlers } = vi.hoisted(() => ({
    imageErrorHandlers: new Map<string, Array<() => void>>(),
}));

vi.mock('next/image', () => ({
    default: ({ unoptimized, src, onError }: {
        unoptimized?: boolean;
        src: string;
        onError?: () => void;
    }) => {
        void unoptimized;
        if (onError) imageErrorHandlers.set(src, [
            ...(imageErrorHandlers.get(src) ?? []),
            onError,
        ]);
        return <div data-progress-image={src} onError={onError} />;
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

    it('keeps repeated history occurrences, fallback width, and tile nodes stable across signed URL refreshes', () => {
        const firstUrl = '/api/image-proxy?token=first';
        const refreshedUrl = '/api/image-proxy?token=refreshed';

        render(firstUrl);
        const firstCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        if (!firstCopy) throw new Error('progress copy not rendered');
        const firstImage = firstCopy.querySelector('[data-progress-image]');
        const firstTile = firstImage?.parentElement;
        const fallbackTile = [...firstCopy.children]
            .find(child => !child.querySelector('[data-progress-image]'));
        if (!firstTile || !firstImage || !fallbackTile) {
            throw new Error('expected image and fallback tiles');
        }
        expect(firstCopy.children).toHaveLength(2);
        expect(firstImage?.getAttribute('data-progress-image')).toContain('token=first');
        expect((fallbackTile as HTMLElement).style.width).toBe('84px');
        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(4);

        render(firstUrl);
        const repeatedCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        expect(repeatedCopy?.querySelector('[data-progress-image]')?.parentElement).toBe(firstTile);
        expect([...repeatedCopy!.children].find(child => !child.querySelector('[data-progress-image]')))
            .toBe(fallbackTile);
        expect(repeatedCopy?.children).toHaveLength(2);

        act(() => {
            imageErrorHandlers.get(firstUrl)?.[0]?.();
        });
        expect(firstCopy.querySelector('[data-progress-image]')).toBeNull();
        expect((firstTile as HTMLElement).style.width).toBe('84px');

        render(refreshedUrl);
        const refreshedCopy = container.querySelector<HTMLElement>('[data-progress-copy]');
        const refreshedImage = refreshedCopy?.querySelector('[data-progress-image]');
        expect(refreshedImage).toBeTruthy();
        expect(refreshedCopy?.querySelector('[data-progress-image]')?.parentElement).toBe(firstTile);
        expect((refreshedCopy?.querySelector('[data-progress-image]')?.parentElement as HTMLElement)
            .style.width).toBe('84px');
        expect(refreshedCopy?.querySelector('[data-progress-image]')?.parentElement).toBe(firstTile);
        expect(refreshedImage).not.toBe(firstImage);
        expect(refreshedImage?.getAttribute('data-progress-image')).toContain('token=refreshed');
        expect(refreshedCopy?.children).toHaveLength(2);
        expect(container.querySelectorAll('[data-progress-copy]')).toHaveLength(4);
    });

    it('prefers equal-richness re-signed server history over a stale active URL', () => {
        const staleActiveUrl = '/api/image-proxy?token=stale-active';
        const freshServerUrl = '/api/image-proxy?token=fresh-server';

        render(staleActiveUrl);
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
                        imageUrl: '/api/image-proxy?token=active-only',
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
        const refreshedImage = refreshedCopy?.querySelector('[data-progress-image]');
        expect(refreshedImage?.getAttribute('data-progress-image')).toContain('token=fresh-server');
        expect(refreshedCopy?.children).toHaveLength(2);
        expect(refreshedCopy?.querySelectorAll('[data-progress-image]')[1]
            ?.getAttribute('data-progress-image')).toContain('token=active-only');
        expect([...refreshedCopy!.children].every(child => (
            (child as HTMLElement).style.width === '84px'
        ))).toBe(true);
    });

    it('clears retained media only for an explicit publication-lag reset', () => {
        render('/api/image-proxy?token=before-reset');
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
});
