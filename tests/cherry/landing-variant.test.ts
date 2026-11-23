import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ insert: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: db.from } }));

import { CRUSH_REPLACEMENTS, parseCherryVariant, renderCherryLanding } from '@/lib/services/cherry/landing-variant';

const landing = readFileSync(path.join(process.cwd(), 'public/cherry/landing.html'), 'utf8');

describe('cherry landing variant', () => {
    it('parses only the two exact variant values', () => {
        expect(parseCherryVariant('bf')).toBe('bf');
        expect(parseCherryVariant('crush')).toBe('crush');
        for (const value of [null, '', 'CRUSH', 'crush ', 'x']) expect(parseCherryVariant(value)).toBeNull();
    });

    it('every replacement source exists in the landing page', () => {
        for (const [from] of CRUSH_REPLACEMENTS) expect(landing.includes(from), from).toBe(true);
    });

    it('crush output has no boyfriend wording', () => {
        const html = renderCherryLanding(landing, { variant: 'crush', pixelId: null });
        expect(html.replace('남자친구, 썸남', '')).not.toMatch(/남친|남자친구/);
        for (const text of [
            '<html lang="ko" data-variant="crush">',
            '내 짝남은 내가 모르는 사이',
            '인스타 아이디 하나면 돼요',
            '짝남에게는 비밀로 할게요.',
            '/cherry/og-crush.jpg',
            'class="fallback-count">짝남 팔로잉',
        ]) expect(html).toContain(text);
    });

    it('default output is untouched', () => {
        expect(renderCherryLanding(landing, { variant: null, pixelId: null })).toBe(landing);
        expect(renderCherryLanding(landing, { variant: 'bf', pixelId: null }))
            .toBe(landing.replace('<html lang="ko">', '<html lang="ko" data-variant="bf">'));
    });

    it('keeps crush with ad params', async () => {
        const { GET } = await import('@/app/cherry/route');
        const response = await GET(new NextRequest('https://yeosachin.com/cherry?v=crush&utm_source=meta&fbclid=abc'));
        const html = await response.text();
        expect(html).toContain('data-variant="crush"');
        expect(html).toContain('<span>내 짝남은 내가 모르는 사이</span>');
        expect(response.headers.get('Cache-Control')).toBe('public, s-maxage=300, stale-while-revalidate=3600');
        expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    });

    it('injects pixel with autoConfig off', () => {
        const html = renderCherryLanding(landing, { variant: null, pixelId: '1234567890' });
        expect(html).toContain('connect.facebook.net/en_US/fbevents.js');
        const autoConfig = html.indexOf("fbq('set','autoConfig',false,'1234567890')");
        expect(autoConfig).toBeGreaterThan(-1);
        expect(autoConfig).toBeLessThan(html.indexOf("fbq('init','1234567890')"));
        expect(html).toContain("fbq('track','PageView')");
        expect(html.indexOf('fbevents.js')).toBeLessThan(html.indexOf('<title>'));
    });

    it('ignores unsafe pixel ids', () => {
        for (const pixelId of ['123 456', "1');alert(1);//", '', '12ab', '1234']) {
            expect(renderCherryLanding(landing, { variant: 'crush', pixelId })).not.toContain('fbevents');
        }
    });

    it('ships the crush share image', () => {
        expect(readFileSync(path.join(process.cwd(), 'public/cherry/og-crush.jpg')).length).toBeGreaterThan(10_000);
    });
});

describe('cherry reservation variant', () => {
    beforeEach(() => {
        db.insert.mockReset();
        db.from.mockReset().mockReturnValue({ insert: db.insert });
        vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T12:00:00+09:00'));
    });
    afterEach(() => vi.restoreAllMocks());

    const reserve = async (extra: Record<string, unknown>) => {
        const { POST } = await import('@/app/api/namchin/reservations/route');
        return POST(new Request('https://yeosachin.com/api/cherry/reservations', {
            method: 'POST',
            headers: { origin: 'https://yeosachin.com', 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'Me@Example.com', phone: '010-1234-5678', consent: true, privateAck: true, ...extra }),
        }));
    };

    it('stores the variant', async () => {
        db.insert.mockResolvedValue({ error: null });
        const response = await reserve({ variant: 'crush' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ received: true });
        expect(db.insert).toHaveBeenCalledWith({ email: 'me@example.com', phone: '+821012345678', variant: 'crush' });
    });

    it('omits variant when absent', async () => {
        db.insert.mockResolvedValue({ error: null });
        expect((await reserve({})).status).toBe(200);
        expect(db.insert).toHaveBeenCalledWith({ email: 'me@example.com', phone: '+821012345678' });
    });

    it('rejects unknown variant', async () => {
        expect((await reserve({ variant: 'x' })).status).toBe(400);
        expect(db.insert).not.toHaveBeenCalled();
    });

    it('retries without variant when the column is missing', async () => {
        db.insert.mockResolvedValueOnce({ error: { code: 'PGRST204' } }).mockResolvedValueOnce({ error: null });
        const response = await reserve({ variant: 'bf' });
        expect(response.status).toBe(200);
        expect(db.insert).toHaveBeenCalledTimes(2);
        expect(db.insert).toHaveBeenLastCalledWith({ email: 'me@example.com', phone: '+821012345678' });
    });

    it('keeps the first reservation on duplicate', async () => {
        db.insert.mockResolvedValue({ error: { code: '23505' } });
        const response = await reserve({ variant: 'crush' });
        expect(response.status).toBe(200);
        expect(db.insert).toHaveBeenCalledTimes(1);
    });
});
