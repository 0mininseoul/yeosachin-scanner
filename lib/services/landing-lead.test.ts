import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportLandingLead } from './landing-lead';

describe('reportLandingLead', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
        vi.stubGlobal('document', { referrer: 'https://ref.example' });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('POSTs id, raw input, attribution and referrer as JSON', () => {
        reportLandingLead({ instagramId: 'suzy', rawInput: '@Suzy', search: '?utm_source=instagram' });
        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
        expect(url).toBe('/api/leads');
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.instagramId).toBe('suzy');
        expect(body.rawInput).toBe('@Suzy');
        expect(body.referrer).toBe('https://ref.example');
        expect(body.attribution.source).toBe('instagram');
    });

    it('never throws even if fetch rejects', () => {
        (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('offline'));
        expect(() => reportLandingLead({ instagramId: 'suzy', rawInput: 'suzy', search: '' }))
            .not.toThrow();
    });
});
