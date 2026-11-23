import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
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

    it('ships the crush share image', () => {
        expect(readFileSync(path.join(process.cwd(), 'public/cherry/og-crush.jpg')).length).toBeGreaterThan(10_000);
    });
});
