// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    PRECHECKOUT_BLITE_SCHEMA_VERSION,
    precheckoutBliteV1Schema,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';
import { BliteResultScreen } from './blite-result';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every fixture is parsed through the real schema before it is rendered, so a test can never
 * prove the screen against a DTO the API could not actually produce.
 */
function parsed(dto: unknown): PrecheckoutBliteV1 {
    return precheckoutBliteV1Schema.parse(dto);
}

/** An ordinary target: posts, a profile picture, four signals across all three bands. */
function richDto(): PrecheckoutBliteV1 {
    return parsed({
        schemaVersion: PRECHECKOUT_BLITE_SCHEMA_VERSION,
        persona: {
            headline: '러닝 크루와 브랜드 협업을 함께 굴리는 기록형 기획자',
            summary: '회차마다 코스와 페이스를 정리해 올리고, 함께한 사람을 문장 안에서 먼저 호명하는 패턴이 반복돼요.',
        },
        signals: [
            { claim: '회차마다 코스와 참여 인원을 캐러셀로 정리해 올려요.', category: '정보 아카이빙 성향', confidence: 0.94, band: 'high' },
            { claim: '정기 모임을 직접 굴리며 운영 부담을 반복해서 감당해요.', category: '커뮤니티 운영력', confidence: 0.91, band: 'high' },
            { claim: '보정 톤과 캡션 문체가 회차마다 달라요.', category: '자기표현 일관성', confidence: 0.58, band: 'medium' },
            { claim: '함께한 사람에게 공을 돌리는 문장이 반복돼요.', category: '관계 및 협업 지향성', confidence: 0.42, band: 'low' },
        ],
        candidateRange: { min: 28, max: 64 },
        genderRead: {
            likelyFemale: false,
            confidence: 0.62,
            reasons: [
                '프로필과 공개 피드 신호가 한쪽으로 뚜렷하지 않아요.',
                '태그된 계정 구성이 한쪽으로 치우치지 않았어요.',
                '게시물 주제가 다양한 편이에요.',
            ],
        },
        postCount: 47,
        evidenceFields: ['post.caption', 'post.hashtags', 'profile.profilePicUrl'],
    });
}

/**
 * A real preflight target can have no posts and no profile picture. The contract still
 * guarantees persona, four signals, and a candidate range, so the screen must be complete
 * from text and numbers alone — with nothing on it that would render as an empty frame.
 * The wide four-digit range doubles as the overflow fixture.
 */
function mediaFreeDto(): PrecheckoutBliteV1 {
    return parsed({
        schemaVersion: PRECHECKOUT_BLITE_SCHEMA_VERSION,
        persona: {
            headline: '공개된 흔적이 거의 없는 최소 노출 계정',
            summary: '공개된 게시물이 없어 계정 자체의 구성만으로 읽어낸 1차 추론이에요.',
        },
        signals: [
            { claim: '공개된 게시물이 없어 활동 흔적을 거의 남기지 않아요.', category: '노출 최소화', confidence: 0.71, band: 'high' },
            { claim: '계정 구성이 단순하게 유지되고 있어요.', category: '계정 운영 방식', confidence: 0.55, band: 'medium' },
            { claim: '공개 신호만으로는 관계 성향을 좁히기 어려워요.', category: '관계 신호 밀도', confidence: 0.31, band: 'low' },
            { claim: '드러난 관심사 축이 한쪽으로 모이지 않아요.', category: '관심사 분산도', confidence: 0.24, band: 'low' },
        ],
        candidateRange: { min: 4, max: 1200 },
        genderRead: {
            likelyFemale: false,
            confidence: 0.31,
            reasons: [
                '공개된 게시물이 없어 판단 근거가 부족해요.',
                '프로필 문구에서 방향을 좁힐 단서가 없어요.',
                '태그된 계정이 확인되지 않아요.',
            ],
        },
        postCount: 0,
        evidenceFields: ['post.caption'],
    });
}

describe('BliteResultScreen', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    function render(props: {
        targetUsername?: string | null;
        dto?: PrecheckoutBliteV1;
        onContinue?: () => void;
    } = {}) {
        act(() => {
            root.render(createElement(BliteResultScreen, {
                // `?? ` would swallow the explicit null the fallback test needs to pass in.
                targetUsername: 'targetUsername' in props ? props.targetUsername ?? null : 'n__yuha',
                dto: props.dto ?? richDto(),
                onContinue: props.onContinue ?? (() => {}),
            }));
        });
    }

    function clickButton(label: string) {
        const button = [...container.querySelectorAll('button')]
            .find(candidate => candidate.textContent?.trim() === label);
        if (!button) throw new Error(`button not found: ${label}`);
        act(() => button.click());
    }

    /* ---- what the screen must carry ---- */

    it('renders the target handle, the persona, and every signal claim and category', () => {
        const dto = richDto();
        render({ dto });

        expect(container.textContent).toContain('@n__yuha');
        expect(container.textContent).toContain(dto.persona.headline);
        expect(container.textContent).toContain(dto.persona.summary);
        for (const signal of dto.signals) {
            expect(container.textContent).toContain(signal.claim);
            expect(container.textContent).toContain(signal.category);
        }
    });

    it('renders every signal confidence as a two-decimal number', () => {
        render();

        for (const value of ['0.94', '0.91', '0.58', '0.42']) {
            expect(container.textContent).toContain(value);
        }
    });

    it('renders the candidate range as a tilde reading with a visible interval', () => {
        render();

        expect(container.textContent).toContain('28~64명');
        expect(container.textContent).not.toContain('28-64명');
        expect(container.textContent).not.toContain('28 – 64명');
        expect(container.textContent).toContain('분석 후보 예상 범위');
        expect(container.textContent).toContain('전체 판독에서 후보별 관계 신호를 확인할 수 있어요.');
    });

    it('falls back to a neutral subject label when no target username is supplied', () => {
        render({ targetUsername: null });
        expect(container.textContent).toContain('판독 대상');

        render({ targetUsername: '   ' });
        expect(container.textContent).toContain('판독 대상');
    });

    it('calls onContinue exactly once when the CTA is clicked', () => {
        const onContinue = vi.fn();
        render({ onContinue });

        expect(onContinue).not.toHaveBeenCalled();
        clickButton('상세 분석 보기');
        expect(onContinue).toHaveBeenCalledOnce();
    });

    it('blocks the persona and every claim from session replay', () => {
        const dto = richDto();
        render({ dto });

        const blocked = [...container.querySelectorAll('[data-amp-block]')]
            .map(node => node.textContent ?? '');
        const isBlocked = (text: string) => blocked.some(entry => entry.includes(text));

        expect(isBlocked(dto.persona.headline)).toBe(true);
        expect(isBlocked(dto.persona.summary)).toBe(true);
        for (const signal of dto.signals) {
            expect(isBlocked(signal.claim)).toBe(true);
        }
    });

    /* ---- the four rejections ---- */

    it('renders no case-file metadata line', () => {
        render();
        const text = container.textContent ?? '';

        expect(text).not.toMatch(/CASE/i);
        expect(text).not.toMatch(/YS-\d{2}-/);
        expect(text).not.toContain('표본');
        expect(text).not.toContain('1차 판독');
        // postCount is 47 in the fixture and must reach the screen in no form.
        expect(text).not.toContain('47건');
        expect(text).not.toContain('47개');
    });

    it('renders no qualitative confidence label', () => {
        render();
        const text = container.textContent ?? '';

        expect(text).not.toContain('신뢰도 높음');
        expect(text).not.toContain('신뢰도 보통');
        expect(text).not.toContain('신뢰도 낮음');
        expect(text).not.toContain('표본 부족');
        expect(text).not.toContain('고신뢰');
    });

    it('spends the eyebrow budget once and drops the decorative signal header', () => {
        render();
        const text = container.textContent ?? '';

        expect(container.querySelectorAll('.eyebrow')).toHaveLength(1);
        expect(container.querySelector('.eyebrow')?.textContent).toBe('관계 판독 범위');
        expect(text).not.toContain('공개 피드 신호');
        expect(text).not.toContain('AI 1차 페르소나');
        expect(text).not.toContain('최근 게시물들에서 확인한 패턴');
        // The page heading's own eyebrow is withdrawn for this state; the sheet must never
        // reintroduce it either.
        expect(text).not.toContain('판독 의뢰서');
    });

    it('draws no shared axis, spectrum, or derived summary statistic', () => {
        render();
        const text = container.textContent ?? '';

        // A shared axis prints its scale; a spectrum prints its high-confidence band.
        expect(text).not.toContain('0.50');
        expect(text).not.toContain('1.00');
        expect(text).not.toContain('0.00');
        expect(text).not.toContain('0.70');
        expect(text).not.toContain('평균');
        expect(text).not.toMatch(/\b3\s*\/\s*4\b/);
    });

    /* ---- structure and the media-free target ---- */

    it('spends the bracket budget once, on the verdict block', () => {
        render();

        expect(container.querySelector('[data-precheckout-result]')).not.toBeNull();
        expect(container.querySelectorAll('[data-precheckout-result-card]')).toHaveLength(1);
    });

    it('renders a complete screen for a DTO with no post- or picture-backed data', () => {
        const dto = mediaFreeDto();
        render({ dto });
        const text = container.textContent ?? '';

        expect(text).toContain(dto.persona.headline);
        expect(text).toContain(dto.persona.summary);
        for (const signal of dto.signals) {
            expect(text).toContain(signal.claim);
            expect(text).toContain(signal.category);
        }
        expect(text).toContain('4~1200명');
        expect(container.querySelectorAll('button')).toHaveLength(1);
        expect(text).toContain('상세 분석 보기');
        // postCount is 0 here: no count, and no "0" standing in for missing evidence.
        expect(text).not.toContain('0건');
        expect(text).not.toContain('0개');
    });

    it('renders no media element and no empty visualization shell', () => {
        for (const dto of [richDto(), mediaFreeDto()]) {
            render({ dto });

            expect(container.querySelectorAll('img, picture, video, canvas, svg, figure'))
                .toHaveLength(0);
            // Every measure that exists is bound to a real confidence, so no zero-width or
            // unbound track can be left on the page as an empty frame.
            const measures = [...container.querySelectorAll('[data-blite-measure]')];
            expect(measures).toHaveLength(dto.signals.length);
            measures.forEach((measure, index) => {
                expect(measure.getAttribute('data-blite-measure'))
                    .toBe(dto.signals[index].confidence.toFixed(2));
            });
        }
    });

    it('gives the ordered evidence real list semantics with one row per signal', () => {
        const dto = richDto();
        render({ dto });

        const list = container.querySelector('ol');
        expect(list).not.toBeNull();
        expect(list?.querySelectorAll(':scope > li')).toHaveLength(dto.signals.length);
    });
});
