import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RUNBOOK_URL = new URL(
    '../../../docs/seo-geo-search-console-runbook.md',
    import.meta.url,
);

function readRunbook(): string {
    expect(
        existsSync(RUNBOOK_URL),
        'Search Console 운영 런북이 있어야 합니다.',
    ).toBe(true);
    return readFileSync(RUNBOOK_URL, 'utf8');
}

describe('SEO/GEO Search Console operations runbook', () => {
    it('documents deployment verification and Domain property ownership', () => {
        const runbook = readRunbook();

        expect(runbook).toMatch(/yeosachin\.com[\s\S]{0,100}Domain property/i);
        expect(runbook).toMatch(/DNS[\s\S]{0,80}TXT[\s\S]{0,100}(소유권|ownership)/i);
        expect(runbook).toMatch(/배포 전[\s\S]{0,1000}배포 후/);

        for (const url of [
            'https://yeosachin.com/robots.txt',
            'https://yeosachin.com/sitemap.xml',
            'https://yeosachin.com/',
            'https://yeosachin.com/guide/wijang-yeosachin',
        ]) {
            expect(runbook).toContain(url);
        }
        expect(runbook).toMatch(/robots\.txt[^\n]*200/i);
        expect(runbook).toMatch(/sitemap\.xml[^\n]*200/i);
        expect(runbook).toMatch(/https:\/\/yeosachin\.com\/[^\n]*200[^\n]*canonical/i);
        expect(runbook).toMatch(
            /https:\/\/yeosachin\.com\/guide\/wijang-yeosachin[^\n]*200[^\n]*canonical/i,
        );
    });

    it('documents Search generative AI inclusion and its rollout caveats', () => {
        const runbook = readRunbook();

        expect(runbook).toContain('설정 → Search generative AI');
        expect(runbook).toMatch(
            /(포함|include)[^\n]*(선택|설정|유지)|사이트를 Google의 생성형 AI 기능에 포함/i,
        );
        expect(runbook).toMatch(/기본[^\n]*(포함|include)/i);
        expect(runbook).toMatch(/(일부|subset|순차|rollout|출시)[^\n]*(제공|노출|계정|속성)/i);
    });

    it('documents sitemap, live URL inspection, indexing, and canonical checks', () => {
        const runbook = readRunbook();

        expect(runbook).toMatch(
            /https:\/\/yeosachin\.com\/sitemap\.xml[\s\S]{0,300}(제출|submit)[\s\S]{0,200}(성공|success)/i,
        );
        for (const url of [
            'https://yeosachin.com/',
            'https://yeosachin.com/guide/wijang-yeosachin',
        ]) {
            const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            expect(runbook).toMatch(
                new RegExp(`${escaped}[\\s\\S]{0,500}(실시간 URL 테스트|live URL test)[\\s\\S]{0,300}(색인 생성 요청|request indexing)`, 'i'),
            );
        }
        expect(runbook).toMatch(/사용자 선언 표준 URL|user-declared canonical/i);
        expect(runbook).toMatch(/Google 선택 표준 URL|Google-selected canonical/i);
    });

    it('documents Search, generative AI, and safe ChatGPT referral measurement', () => {
        const runbook = readRunbook();

        for (const query of [
            '위장여사친 판독기',
            '위장여사친 구분법',
        ]) {
            expect(runbook).toContain(query);
        }
        expect(runbook).toMatch(/띄어쓰기[^\n]*(변형|variant)/i);
        expect(runbook).toMatch(
            /(Generative AI performance|생성형 AI 성과)[\s\S]{0,300}(AI Overviews|AI 개요)[\s\S]{0,200}AI Mode/i,
        );
        expect(runbook).toMatch(
            /(보고서|report)[^\n]*(없|미제공|unavailable|노출되지)[^\n]*(출시|rollout|노출|impression|데이터)/i,
        );
        expect(runbook).toContain('source=chatgpt');
        expect(runbook).toContain('medium=referral');
        expect(runbook).toMatch(/utm_source=chatgpt\.com[\s\S]{0,200}(OpenAI|ChatGPT)/i);
    });

    it('documents observation cadence, troubleshooting, non-guarantees, and official sources', () => {
        const runbook = readRunbook();

        expect(runbook).toContain('7/28/90일');
        for (const cadence of ['### 7일', '### 28일', '### 90일']) {
            expect(runbook).toContain(cadence);
        }
        expect(runbook).toMatch(/보고서[^\n]*(없|미제공|노출되지)/);
        expect(runbook).toMatch(/색인[^\n]*(되지 않|미등록)/);
        expect(runbook).toMatch(/canonical[^\n]*(불일치|mismatch)/i);
        expect(runbook).toMatch(
            /(sitemap|사이트맵)[\s\S]{0,200}(색인 생성 요청|indexing request)[\s\S]{0,300}(힌트|hint)/i,
        );
        for (const nonGuarantee of [
            /색인[^\n]*(보장하지|보장할 수 없)/,
            /1위[^\n]*(보장하지|보장할 수 없)/,
            /AI[^\n]*(인용|citation)[^\n]*(보장하지|보장할 수 없)/i,
            /ChatGPT[^\n]*(추천|recommendation)[^\n]*(보장하지|보장할 수 없)/i,
        ]) {
            expect(runbook).toMatch(nonGuarantee);
        }

        for (const officialOrigin of [
            'https://support.google.com/webmasters/',
            'https://developers.google.com/search/docs/',
            'https://platform.openai.com/docs/bots',
            'https://help.openai.com/en/articles/12627856-publishers-and-developers-faq',
        ]) {
            expect(runbook).toContain(officialOrigin);
        }
    });
});
