import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

const GUIDE_PATH = '/guide/wijang-yeosachin';
const GUIDE_URL = `https://yeosachin.com${GUIDE_PATH}`;
const GUIDE_TITLE = '위장여사친 구분법 | 위장여사친 판독기';
const GUIDE_DESCRIPTION = '맞팔 관계와 좋아요·댓글·태그·멘션 등 인스타그램 공개 신호로 위장여사친 후보를 구분하는 기준과 AI 판독 방식을 설명합니다.';
const GUIDE_H1 = '위장여사친 구분법: 인스타 공개 신호로 확인하는 기준';
const DIRECT_ANSWER = '위장여사친은 친구라고 소개되지만 공개된 상호작용에서 반복적인 친밀 신호가 나타나는 여사친을 뜻합니다. 한 번의 좋아요나 맞팔만으로 단정하지 않고, 맞팔 관계와 댓글·좋아요·태그·멘션 같은 여러 공개 신호를 함께 비교해야 합니다.';
const SERVICE_DEFINITION = '위장여사친 판독기는 남자친구의 인스타그램 공개 계정을 기준으로 맞팔 관계와 공개 상호작용을 AI로 교차 분석해, 확인이 필요한 후보를 상대적 위험도 순으로 보여주는 서비스입니다.';

function visibleText(markup: string): string {
    return markup
        .replace(/<script[\s\S]*?<\/script>/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function readJsonLd(markup: string): unknown {
    const match = markup.match(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    );
    expect(match).not.toBeNull();
    return JSON.parse(match?.[1] ?? '');
}

describe('definitive disguised-friend guide', () => {
    it('exports unique, indexable metadata with a self canonical', async () => {
        const { metadata } = await import('@/app/guide/wijang-yeosachin/page');

        expect(metadata.title).toBe(GUIDE_TITLE);
        expect(metadata.description).toBe(GUIDE_DESCRIPTION);
        expect(metadata.alternates?.canonical).toBe(GUIDE_PATH);
        expect(metadata.robots).toEqual({ index: true, follow: true });
    });

    it('renders the operational answer, service definition, method, limits, and navigation in static HTML', async () => {
        const { default: GuidePage } = await import(
            '@/app/guide/wijang-yeosachin/page'
        );
        const markup = renderToStaticMarkup(createElement(GuidePage));
        const text = visibleText(markup);

        expect(markup).toContain(`<h1`);
        expect(text).toContain(GUIDE_H1);
        expect(text).toContain(DIRECT_ANSWER);
        expect(text).toContain(SERVICE_DEFINITION);

        for (const section of [
            '위장여사친이란?',
            '구분할 때 함께 보는 공개 신호',
            '수동 확인과 AI 판독의 차이',
            '위장여사친 판독기는 어떻게 분석하나',
            '결과를 읽을 때 주의할 점',
            '자주 묻는 질문',
            '판독 기준과 문서 정보',
        ]) {
            expect(text).toContain(section);
        }

        for (const signal of ['맞팔', '좋아요', '댓글', '태그', '멘션']) {
            expect(text).toContain(signal);
        }
        expect(text).toMatch(/여러|복수/);
        expect(text).toMatch(/5개 축|다섯 축/);
        expect(text).toContain(
            '공개 프로필 → 맞팔 후보 → 공개 상호작용 → 상대 위험도',
        );

        expect(text).toMatch(/비공개 정보.*DM|DM.*비공개 정보/);
        expect(text).toMatch(/상대적 위험도.*사실.*단정|사실.*단정.*상대적 위험도/);
        expect(text).toMatch(/공개 데이터.*부족|공개 정보.*부족/);
        expect(text).toMatch(/바뀔|변경|달라질/);

        for (const question of [
            '좋아요 한 번만 눌러도 위장여사친인가요?',
            '비공개 계정도 판독할 수 있나요?',
            '판독하면 상대방에게 알림이 가나요?',
            '결과는 100% 정확한가요?',
            '직접 확인하는 것과 무엇이 다른가요?',
        ]) {
            expect(text).toContain(question);
        }

        expect(markup).toMatch(/href="\/"/);
        expect(markup).toMatch(/href="\/analyze"/);
        expect(markup).toContain('dateTime="2026-07-29"');
        expect(text).toContain('2026-07-29');
        expect(text).toContain('Ascentum');
    });

    it('publishes only an Article and BreadcrumbList that agree with the visible guide', async () => {
        const { default: GuidePage } = await import(
            '@/app/guide/wijang-yeosachin/page'
        );
        const markup = renderToStaticMarkup(createElement(GuidePage));
        const jsonLd = readJsonLd(markup) as {
            '@context': string;
            '@graph': Array<Record<string, unknown>>;
        };
        const serialized = JSON.stringify(jsonLd);

        expect(jsonLd['@context']).toBe('https://schema.org');
        expect(jsonLd['@graph']).toHaveLength(2);
        expect(jsonLd['@graph'].map((node) => node['@type'])).toEqual([
            'Article',
            'BreadcrumbList',
        ]);
        expect(jsonLd['@graph'][0]).toMatchObject({
            '@id': `${GUIDE_URL}#article`,
            '@type': 'Article',
            url: GUIDE_URL,
            headline: GUIDE_TITLE,
            description: GUIDE_DESCRIPTION,
            datePublished: '2026-07-29',
            dateModified: '2026-07-29',
            inLanguage: 'ko-KR',
            author: { '@type': 'Organization', name: 'Ascentum' },
            publisher: { '@type': 'Organization', name: 'Ascentum' },
        });
        expect(jsonLd['@graph'][1]).toMatchObject({
            '@id': `${GUIDE_URL}#breadcrumb`,
            '@type': 'BreadcrumbList',
            itemListElement: [
                expect.objectContaining({
                    position: 1,
                    name: '위장여사친 판독기',
                    item: 'https://yeosachin.com/',
                }),
                expect.objectContaining({
                    position: 2,
                    name: GUIDE_TITLE,
                    item: GUIDE_URL,
                }),
            ],
        });
        expect(serialized).not.toMatch(
            /FAQPage|HowTo|Review|AggregateRating|sameAs/,
        );
    });
});

describe('landing page guide link and locked copy regression', () => {
    it('adds one guide link without weakening any fixed landing copy group', async () => {
        const source = await readFile(
            new URL('../../../app/page.tsx', import.meta.url),
            'utf8',
        );

        expect(source).toMatch(
            /<Link href="\/guide\/wijang-yeosachin"[^>]*>\s*위장여사친 구분법\s*<\/Link>/,
        );

        for (const fixedCopy of [
            '국내 유일 위장여사친 판독 서비스',
            '내 남친이 맞팔 중인 여자들,',
            '누가 제일 위험할까?',
            '&quot;그냥 친구야&quot;라는 말, AI가 팩트 체크해드립니다.',
            '지금 바로 확인하기',
            '판독 결과는 상대방에게 절대 통보되지 않습니다.',
            '아이디 하나면 충분',
            '남자친구 인스타그램 아이디만 넣으세요.',
            '나머지는 AI가 알아서 전부 파 드립니다.',
            '직접 못 찾는 것까지 판독',
            '맞팔 수백 명의 성별을 식별해 이성만 추려내고,',
            '상호작용·친밀도·프로필 분위기까지 5개 축으로 교차 분석합니다.',
            '위협 등급 리포트',
            '위장 여사친 후보를 위험도 순으로 정렬하고,',
            '위장여사친들의 정체를 구체적 근거 기반으로 전부 보여드립니다.',
            '직접 뒤지는 건 <span className="text-blood">불가능</span>합니다',
            '밤새 프로필을 눌러봐도 못 찾는 걸, AI는 5분이면 끝냅니다.',
            '맞팔 전수조사',
            '수백 명을 일일이 볼 순 없죠. AI가 한 명도 빠짐없이 훑습니다.',
            '여사친들만 선별',
            '성별을 식별해 위장 여사친 후보만 골라냅니다.',
            '상호작용 추적',
            '좋아요·댓글·태그·멘션·친밀도까지 정밀 분석합니다.',
            '상대방은 절대 모름',
            '조회 흔적도, 알림도 남지 않습니다.',
            '상대방 통보 없음',
            '비밀 보장 100%',
            '아이디 하나면 끝',
            '5분이면 결과 완료',
            'AI 정밀 판독',
            '남자친구가 알려주지 않는 진실',
            '불안해하며 시간 낭비하지 마세요.',
            'AI가 5분 안에 진실을 파헤쳐 드립니다.',
            '지금 바로 위장 여사친 확인하기',
        ]) {
            expect(source).toContain(fixedCopy);
        }
    });
});
