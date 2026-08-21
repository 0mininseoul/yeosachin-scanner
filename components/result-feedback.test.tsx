// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultFeedback } from './result-feedback';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

const analyticsMocks = vi.hoisted(() => ({
    EVENTS: { RESULT_FEEDBACK_SUBMITTED: 'result_feedback_submitted' },
    trackEvent: vi.fn(),
}));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/analytics', () => analyticsMocks);

const requestId = '223e4567-e89b-42d3-a456-426614174000';

let container: HTMLDivElement;
let root: Root;

function render() {
    act(() => {
        root.render(createElement(ResultFeedback, { requestId }));
    });
}

function buttonByText(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll('button')]
        .find(button => button.textContent?.trim() === text);
    if (!found) throw new Error(`button not found: ${text}`);
    return found;
}

async function submit(body: string) {
    render();
    act(() => buttonByText('결과가 정확하지 않나요?').click());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('feedback textarea not found');
    const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
    )?.set;
    valueSetter?.call(textarea, body);
    act(() => textarea.dispatchEvent(new Event('input', { bubbles: true })));
    await act(async () => {
        buttonByText('의견 보내기').click();
        await Promise.resolve();
    });
}

beforeEach(() => {
    analyticsMocks.trackEvent.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
});

describe('ResultFeedback analytics', () => {
    it('tracks only after the feedback API succeeds and strips the body', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 201 }));
        await submit('사적인 의견은 이벤트에 포함되면 안 됩니다');

        expect(analyticsMocks.trackEvent).toHaveBeenCalledWith(
            'result_feedback_submitted',
            { request_id: requestId },
        );
        expect(JSON.stringify(analyticsMocks.trackEvent.mock.calls))
            .not.toContain('사적인 의견');
    });

    it('does not track when feedback persistence fails', async () => {
        fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'failed' }), { status: 500 }));
        await submit('저장 실패 의견');

        expect(analyticsMocks.trackEvent).not.toHaveBeenCalled();
    });
});
