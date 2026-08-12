import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
    PreflightPendingStatus,
    preflightPendingStage,
} from '@/components/preflight-pending-status';

describe('preflight pending status', () => {
    it('advances at the 15 second and 45 second boundaries', () => {
        expect(preflightPendingStage(0)).toBe('initial');
        expect(preflightPendingStage(14_999)).toBe('initial');
        expect(preflightPendingStage(15_000)).toBe('later');
        expect(preflightPendingStage(44_999)).toBe('later');
        expect(preflightPendingStage(45_000)).toBe('delayed');
    });

    it.each([
        [5_000, '프로필과 계정 규모를 확인하고 있습니다.'],
        [20_000, '조금만 더 확인하고 있어요.'],
        [50_000, '평소보다 확인이 오래 걸리고 있습니다.'],
    ])('shows trustworthy copy after %i ms', (elapsedMs, expectedCopy) => {
        const startedAt = 1_000;
        const markup = renderToStaticMarkup(createElement(PreflightPendingStatus, {
            targetInstagramId: 'private_target',
            startedAt,
            now: () => startedAt + elapsedMs,
        }));

        expect(markup).toContain(expectedCopy);
        expect(markup).toContain('anim-indeterminate');
        expect(markup).toContain('data-amp-block');
        expect(markup).not.toMatch(/\d+%|초 남/);
    });
});
