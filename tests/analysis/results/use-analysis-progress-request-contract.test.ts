import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ captureExceptionSafely: vi.fn() }));
vi.mock('@/lib/observability/sentry-capture', () => ({
    captureExceptionSafely: mocks.captureExceptionSafely,
}));

import {
    disposeAnalysisProgressChannel,
} from '@/hooks/useAnalysisProgress';

const source = readFileSync(join(process.cwd(), 'hooks/useAnalysisProgress.ts'), 'utf8');

describe('analysis progress request identity and single-flight contract', () => {
    it('routes queued refetches through the latest request-bound callback', () => {
        expect(source).toContain('const fetchDataRef = useRef<() => Promise<void>>');
        expect(source).toContain('fetchDataRef.current = fetchData;');
        expect(source).toContain('if (shouldRefetch && activeRequestIdRef.current === requestId)');
        expect(source).toContain('void fetchDataRef.current();');
    });

    it('does not render an old request while the next request is loading', () => {
        expect(source).toContain('const currentData = data?.id === requestId ? data : null;');
        expect(source).toContain('const currentOutcome = outcome.requestId === requestId ? outcome : null;');
        expect(source).toContain('loading: currentOutcome?.settled !== true');
    });
});

describe('analysis progress realtime teardown', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
    });

    it('does not capture or leak an expected rejected AbortError during teardown', async () => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            disposeAnalysisProgressChannel(() => Promise.reject(
                new DOMException('The operation was aborted.', 'AbortError'),
            ));
            await new Promise(resolve => setImmediate(resolve));

            expect(report).not.toHaveBeenCalled();
            expect(mocks.captureExceptionSafely).not.toHaveBeenCalled();
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('captures and reports a rejected non-cancellation teardown failure without leaking it globally', async () => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unhandled = vi.fn();
        const failure = new Error('realtime disconnect failed');
        process.on('unhandledRejection', unhandled);
        try {
            disposeAnalysisProgressChannel(() => Promise.reject(failure));
            await new Promise(resolve => setImmediate(resolve));

            expect(report).toHaveBeenCalledWith(
                'Failed to remove analysis progress channel:',
                failure,
            );
            expect(mocks.captureExceptionSafely).toHaveBeenCalledWith(failure);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('captures and reports a synchronous teardown throw without leaking it globally', async () => {
        const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const unhandled = vi.fn();
        const failure = new Error('realtime teardown threw');
        process.on('unhandledRejection', unhandled);
        try {
            disposeAnalysisProgressChannel(() => { throw failure; });
            await new Promise(resolve => setImmediate(resolve));

            expect(report).toHaveBeenCalledWith(
                'Failed to remove analysis progress channel:',
                failure,
            );
            expect(mocks.captureExceptionSafely).toHaveBeenCalledWith(failure);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.off('unhandledRejection', unhandled);
        }
    });

    it('routes the effect cleanup through the observed channel disposer', () => {
        expect(source).toContain(
            'disposeAnalysisProgressChannel(() => supabase.removeChannel(channel));',
        );
    });
});
