// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderCherryLanding } from '@/lib/services/cherry/landing-variant';

const landing = readFileSync('public/cherry/landing.html', 'utf8');
const fetchReservation = vi.fn<typeof fetch>();
const pixel = vi.fn();
const openTime = Date.parse('2026-11-25T12:00:00+09:00');

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(Date, 'now').mockReturnValue(openTime);
    vi.stubGlobal('fetch', fetchReservation);
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('IntersectionObserver', undefined);
    Reflect.deleteProperty(window, 'IntersectionObserver');
    pixel.mockClear();
    vi.stubGlobal('fbq', pixel);
    fetchReservation.mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function openPage(query: string, status = 'open', referrer = '') {
    window.history.replaceState(null, '', `/cherry${query}`);
    vi.spyOn(document, 'referrer', 'get').mockReturnValue(referrer);
    const html = renderCherryLanding(landing, {
        variant: null,
        pixelId: null,
        concept: query.includes('concept=crush') ? 'crush' : null,
    });
    const page = new DOMParser().parseFromString(html, 'text/html');
    for (const attribute of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attribute.name);
    for (const attribute of [...page.documentElement.attributes]) document.documentElement.setAttribute(attribute.name, attribute.value);
    document.body.innerHTML = page.body.innerHTML;
    for (const element of document.querySelectorAll<HTMLElement>('*')) {
        element.getAnimations = () => [];
    }
    Object.defineProperty(document, 'timeline', { configurable: true, value: { currentTime: 0 } });
    fetchReservation.mockImplementation(async (_input, init) => init?.method === 'POST'
        ? Response.json({ received: true })
        : Response.json({ status, serverTime: openTime }));
    vi.resetModules();
    await import('../../public/cherry/landing.js');
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('#submit')?.disabled).toBe(
        status === 'closed' || !document.querySelector<HTMLElement>('#form-success')?.hidden,
    ));
}

function submitForm() {
    const form = document.querySelector<HTMLFormElement>('#interest-form')!;
    form.querySelector<HTMLInputElement>('#email')!.value = 'fake@example.com';
    form.querySelector<HTMLInputElement>('#phone')!.value = '010-1234-5678';
    form.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach(input => { input.checked = true; });
    form.dispatchEvent(new Event('submit', { cancelable: true }));
}

it('keeps the tagged source after navigating to a clean link in the same tab', async () => {
    await openPage('?utm_source=threads', 'open', 'https://x.com/');
    await openPage('?concept=crush');
    submitForm();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#form-success')?.hidden).toBe(false));
    const submission = fetchReservation.mock.calls.find(([, init]) => init?.method === 'POST');
    const payload = JSON.parse(String(submission?.[1]?.body));
    expect(payload.source).toBe('threads');
    expect(payload.variant).toBeUndefined();
});

it('restores success on another concept after closing without another lead or storing contacts', async () => {
    await openPage('');
    submitForm();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#form-success')?.hidden).toBe(false));
    expect(JSON.stringify(localStorage)).not.toMatch(/example\.com|1234|5678/);
    expect(pixel).toHaveBeenCalledTimes(1);
    await openPage('?concept=crush', 'closed');
    expect(document.querySelector<HTMLElement>('#form-success')?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('#reservation-closed')?.hidden).toBe(true);
    expect(fetchReservation.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(pixel).toHaveBeenCalledTimes(1);
});

it('does not remember completion after a failed submission', async () => {
    await openPage('?utm_source=everytime');
    fetchReservation.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    submitForm();
    await vi.waitFor(() => expect(document.querySelector<HTMLElement>('#form-error')?.hidden).toBe(false));
    await openPage('?utm_source=everytime');
    expect(document.querySelector<HTMLElement>('#form-success')?.hidden).toBe(true);
});
