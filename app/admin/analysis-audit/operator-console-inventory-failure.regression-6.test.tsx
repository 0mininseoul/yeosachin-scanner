/** @vitest-environment jsdom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisAuditWorkbench } from './workbench';

function errorResponse(): Response {
    return new Response(JSON.stringify({ error: 'synthetic failure' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
    });
}

async function settle(): Promise<void> {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
    });
}

let container: HTMLDivElement | undefined;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    vi.restoreAllMocks();
    container?.remove();
    container = undefined;
    document.body.innerHTML = '';
});

describe('operator console inventory failure state', () => {
    // Regression: ISSUE-006 — a failed inventory request rendered absent accounts as blocked snapshots.
    // Found by /qa on 2026-09-08
    // Report: reports/admin-console-verification-20260908/report.md
    it('does not synthesize account status from unavailable inventory', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errorResponse()));

        container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        act(() => root.render(createElement(AnalysisAuditWorkbench, { initialRequestId: '' })));
        await settle();
        await settle();

        const paid = container.querySelector('[aria-labelledby="paid-title"]');
        const free = container.querySelector('[aria-labelledby="free-title"]');
        expect(paid?.textContent).toContain('계정 상태를 확인할 수 없습니다');
        expect(free?.textContent).toContain('계정 상태를 확인할 수 없습니다');
        expect(paid?.querySelector('.oc-chip--blocked')).toBeNull();
        expect(free?.querySelector('.oc-chip--blocked')).toBeNull();
        expect(free?.querySelector('table')).toBeNull();
        expect(container.textContent).not.toContain('스냅샷이 없습니다');
    });
});
