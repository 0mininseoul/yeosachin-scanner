import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ insert: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: db.from } }));
vi.mock('@/lib/services/admin/operator-route', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/services/admin/operator-route')>()),
    requireConsoleOperator: async () => ({ ok: true }),
}));

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
    });

    it.each([['bf', '남친'], ['crush', '짝남']] as const)('keeps the %s ad focused on its audience', (variant, target) => {
        const html = renderCherryLanding(landing, { variant, pixelId: null });
        expect(html).toContain(`<html lang="ko" data-variant="${variant}">`);
        expect(html).toContain(`<title>체리 | 인스타 ${target}맞팔알리미</title>`);
        expect(html).toContain(`${target}의 맞팔을 어떻게 확인하는지`);
        expect(html).toContain('다른 사람의 계정도 등록할 수 있나요?');
    });

    it.each(['', '?v=bf&utm_source=meta', '?v=crush', '?utm_source=chatgpt.com'])(
        'serves an indexable canonical with the service and answers in the initial HTML: %s',
        async (query) => {
            const { GET } = await import('@/app/cherry/route');
            const url = 'https://yeosachin.com/cherry';
            const html = await (await GET(new NextRequest(url + query))).text();

            expect(html).not.toMatch(/noindex/i);
            expect(html).toContain(`<link rel="canonical" href="${url}">`);
            const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1] ?? '');
            expect(schema.mainEntity).toMatchObject({ '@type': 'Service', name: '체리', url });
            expect(html).toContain('체리는 매일 팔로워와 팔로잉 수를 확인해요.');
            if (query === '') {
                expect(html).toContain('체리 | 인스타 남친맞팔알리미·짝남맞팔알리미');
                expect(html).toContain('짝남맞팔알리미로도 쓸 수 있나요?');
            }
        },
    );

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

describe('cherry 3d scenes', () => {
    const source = (name: string) => readFileSync(path.join(process.cwd(), 'design/namchin-demand/three', name), 'utf8');

    it('3d sources take the target word from the variant', () => {
        for (const name of ['hero.js', 'trust.js']) expect(source(name), name).not.toMatch(/남친|남자친구/);
        expect(source('shared.js')).toContain("'짝남'");
        expect(source('shared.js')).toContain("'남자친구'");
        const bundleDir = path.join(process.cwd(), 'public/cherry/3d');
        const bundles = readdirSync(bundleDir).map((name) => readFileSync(path.join(bundleDir, name), 'utf8')).join('\n');
        expect(bundles.includes('짝남') || bundles.includes('\\uC9DD\\uB0A8')).toBe(true);
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

describe('cherry admin roster before the variant migration', () => {
    // A PostgREST builder stand-in: resolves to an undefined-column error whenever the query touches `variant`.
    const builder = (columns: string) => {
        let touchesVariant = columns.includes('variant');
        const result = () => touchesVariant
            ? { data: null, count: null, error: { code: '42703' } }
            : { data: [{ email: 'a@b.co', phone: '+821012345678', consented_at: '2026-11-24T00:00:00Z' }], count: 1, error: null };
        const query: Record<string, unknown> = {
            eq: (column: string) => { touchesVariant ||= column === 'variant'; return query; },
            is: (column: string) => { touchesVariant ||= column === 'variant'; return query; },
            or: () => query, ilike: () => query, order: () => query, range: () => query,
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve),
        };
        return query;
    };

    it('still lists reservations when the variant column is missing', async () => {
        db.from.mockReset().mockReturnValue({ select: (columns: string) => builder(columns) });
        const { POST } = await import('@/app/api/admin/namchin/reservations/route');
        const response = await POST(new Request('https://yeosachin.com/api/admin/cherry/reservations', {
            method: 'POST',
            headers: { origin: 'https://yeosachin.com', 'content-type': 'application/json' },
            body: JSON.stringify({ query: '', page: 1 }),
        }));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            rows: [{ email: 'a@b.co', phone: '+821012345678', consentedAt: '2026-11-24T00:00:00Z', variant: null }],
            count: 1,
            hasNext: false,
            variantCounts: null,
        });
    });
});
