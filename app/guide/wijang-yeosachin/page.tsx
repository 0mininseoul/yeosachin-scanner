import type { Metadata } from 'next';
import Link from 'next/link';
import { CaseCard, Eyebrow, TopBar } from '@/components/case-ui';
import { JsonLd } from '@/components/seo/json-ld';
import {
    GUIDE_DESCRIPTION,
    GUIDE_H1,
    GUIDE_JSON_LD,
    GUIDE_MODIFIED_DATE,
    GUIDE_PATH,
    GUIDE_PUBLISHED_DATE,
    GUIDE_PUBLISHER,
    GUIDE_TITLE,
    GUIDE_URL,
} from '@/lib/services/seo/discovery';

export const metadata: Metadata = {
    title: GUIDE_TITLE,
    description: GUIDE_DESCRIPTION,
    alternates: {
        canonical: GUIDE_PATH,
    },
    robots: {
        index: true,
        follow: true,
    },
    openGraph: {
        type: 'article',
        url: GUIDE_URL,
        title: GUIDE_TITLE,
        description: GUIDE_DESCRIPTION,
        locale: 'ko_KR',
        siteName: '위장여사친 판독기',
        publishedTime: GUIDE_PUBLISHED_DATE,
        modifiedTime: GUIDE_MODIFIED_DATE,
        images: [
            {
                url: '/og.png',
                width: 1200,
                height: 630,
                alt: GUIDE_H1,
            },
        ],
    },
    twitter: {
        card: 'summary_large_image',
        title: GUIDE_TITLE,
        description: GUIDE_DESCRIPTION,
        images: ['/og.png'],
    },
};

const SIGNALS = [
    {
        term: '맞팔',
        detail: '서로 팔로우하는 관계인지 확인해 공개 상호작용을 비교할 후보군을 구성합니다.',
    },
    {
        term: '좋아요',
        detail: '특정 계정의 게시물에 좋아요가 반복되는지 다른 신호와 함께 살펴봅니다.',
    },
    {
        term: '댓글',
        detail: '공개 댓글의 빈도와 표현에서 반복적인 친밀 신호가 나타나는지 비교합니다.',
    },
    {
        term: '태그',
        detail: '공개 게시물이나 사진에 서로 태그된 기록이 있는지 확인합니다.',
    },
    {
        term: '멘션',
        detail: '공개 캡션과 댓글에서 서로를 언급하는 패턴이 반복되는지 살펴봅니다.',
    },
] as const;

const FAQS = [
    {
        question: '좋아요 한 번만 눌러도 위장여사친인가요?',
        answer: '아닙니다. 한 번의 좋아요만으로 단정하지 않고 맞팔, 댓글, 태그, 멘션 등 여러 공개 신호가 함께 반복되는지 비교합니다.',
    },
    {
        question: '비공개 계정도 판독할 수 있나요?',
        answer: '비공개 게시물이나 비공개 정보에는 접근하지 않습니다. 공개된 프로필과 관계, 상호작용이 부족하면 판독 근거도 제한될 수 있습니다.',
    },
    {
        question: '판독하면 상대방에게 알림이 가나요?',
        answer: '서비스가 공개 정보를 분석하는 과정에서 대상 계정에 별도의 판독 알림을 보내지 않습니다.',
    },
    {
        question: '결과는 100% 정확한가요?',
        answer: '아닙니다. 결과는 공개 신호를 비교한 상대적 위험도이며 실제 감정이나 관계, 바람 여부를 사실로 확정하지 않습니다.',
    },
    {
        question: '직접 확인하는 것과 무엇이 다른가요?',
        answer: '수동 확인은 계정을 하나씩 살펴봐야 하지만, AI 판독은 맞팔 후보들의 공개 신호를 같은 기준으로 교차 비교해 상대적 위험도 순으로 정리합니다.',
    },
] as const;

export default function GuidePage() {
    return (
        <>
            <JsonLd data={GUIDE_JSON_LD} />
            <div className="min-h-dvh">
                <TopBar
                    right={
                        <Link
                            href="/analyze"
                            className="border border-blood bg-blood px-3.5 py-1.5 text-[13px] font-bold text-white transition-colors hover:bg-blood-2"
                        >
                            판독 시작
                        </Link>
                    }
                />

                <main className="mx-auto max-w-[680px] px-5 pb-16">
                    <article>
                        <nav
                            aria-label="현재 위치"
                            className="flex items-center gap-2 border-b border-line py-4 text-[12px] text-fg-mute"
                        >
                            <Link href="/" className="transition-colors hover:text-fg">
                                홈
                            </Link>
                            <span aria-hidden="true">/</span>
                            <span aria-current="page">위장여사친 구분법</span>
                        </nav>

                        <header className="pb-10 pt-10">
                            <Eyebrow>공개 신호 판독 가이드</Eyebrow>
                            <h1 className="mt-4 text-[30px] font-extrabold leading-[1.25] tracking-[-0.025em] text-fg sm:text-[36px]">
                                {GUIDE_H1}
                            </h1>
                            <p className="mt-5 text-[16px] leading-[1.8] text-fg">
                                위장여사친은 친구라고 소개되지만 공개된 상호작용에서 반복적인 친밀 신호가 나타나는 여사친을 뜻합니다. 한 번의 좋아요나 맞팔만으로 단정하지 않고, 맞팔 관계와 댓글·좋아요·태그·멘션 같은 여러 공개 신호를 함께 비교해야 합니다.
                            </p>
                            <p className="mt-4 text-[14px] leading-[1.75] text-fg-dim">
                                위장여사친 판독기는 남자친구의 인스타그램 공개 계정을 기준으로 맞팔 관계와 공개 상호작용을 AI로 교차 분석해, 확인이 필요한 후보를 상대적 위험도 순으로 보여주는 서비스입니다.
                            </p>
                        </header>

                        <div className="space-y-14">
                            <section aria-labelledby="meaning">
                                <h2 id="meaning" className="text-[23px] font-extrabold text-fg">
                                    위장여사친이란?
                                </h2>
                                <p className="mt-4 text-[14px] leading-[1.8] text-fg-dim">
                                    이 가이드에서 위장여사친은 공개 관계와 상호작용을 확인할 필요가 있는 여사친 후보를 가리킵니다. 맞팔 여부 하나나 단발성 반응이 아니라, 여러 시점에 걸쳐 나타나는 공개 신호를 함께 봐야 합니다.
                                </p>
                            </section>

                            <section aria-labelledby="signals">
                                <h2 id="signals" className="text-[23px] font-extrabold text-fg">
                                    구분할 때 함께 보는 공개 신호
                                </h2>
                                <p className="mt-4 text-[14px] leading-[1.8] text-fg-dim">
                                    맞팔·좋아요·댓글·태그·멘션의 5개 축을 복수로 비교합니다. 어느 한 축만으로 결론 내리지 않고, 여러 신호의 반복과 조합을 살펴보는 기준입니다.
                                </p>
                                <dl className="mt-6 grid gap-3 sm:grid-cols-2">
                                    {SIGNALS.map((signal) => (
                                        <div key={signal.term} className="border-t border-line py-4">
                                            <dt className="text-[15px] font-bold text-fg">{signal.term}</dt>
                                            <dd className="mt-2 text-[13px] leading-[1.7] text-fg-dim">
                                                {signal.detail}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </section>

                            <section aria-labelledby="comparison">
                                <h2 id="comparison" className="text-[23px] font-extrabold text-fg">
                                    수동 확인과 AI 판독의 차이
                                </h2>
                                <div className="mt-5 grid gap-4 sm:grid-cols-2">
                                    <div className="border-t border-line pt-4">
                                        <h3 className="text-[15px] font-bold text-fg">수동 확인</h3>
                                        <p className="mt-2 text-[13px] leading-[1.7] text-fg-dim">
                                            맞팔 계정을 하나씩 열어 공개 반응을 살펴보고, 후보마다 같은 기준으로 다시 비교해야 합니다.
                                        </p>
                                    </div>
                                    <div className="border-t border-line pt-4">
                                        <h3 className="text-[15px] font-bold text-fg">AI 판독</h3>
                                        <p className="mt-2 text-[13px] leading-[1.7] text-fg-dim">
                                            맞팔 후보와 공개 상호작용을 같은 기준으로 교차 분석해 확인 순서를 상대적 위험도로 정리합니다.
                                        </p>
                                    </div>
                                </div>
                            </section>

                            <section aria-labelledby="pipeline">
                                <h2 id="pipeline" className="text-[23px] font-extrabold text-fg">
                                    위장여사친 판독기는 어떻게 분석하나
                                </h2>
                                <CaseCard className="mt-5 px-5 py-6">
                                    <p className="text-center text-[14px] font-bold leading-[1.8] text-fg">
                                        공개 프로필 → 맞팔 후보 → 공개 상호작용 → 상대 위험도
                                    </p>
                                </CaseCard>
                                <ol className="mt-5 space-y-3 text-[13px] leading-[1.7] text-fg-dim">
                                    <li>1. 공개 프로필과 팔로워·팔로잉 관계를 수집합니다.</li>
                                    <li>2. 서로 팔로우하는 관계에서 비교할 맞팔 후보를 추립니다.</li>
                                    <li>3. 공개된 좋아요, 댓글, 태그, 멘션을 후보별로 교차 분석합니다.</li>
                                    <li>4. 확인이 필요한 후보를 상대적 위험도 순으로 보여줍니다.</li>
                                </ol>
                            </section>

                            <section aria-labelledby="limits">
                                <h2 id="limits" className="text-[23px] font-extrabold text-fg">
                                    결과를 읽을 때 주의할 점
                                </h2>
                                <ul className="mt-5 space-y-3 text-[14px] leading-[1.75] text-fg-dim">
                                    <li>비공개 정보나 DM, 비공개 게시물에는 접근하지 않습니다.</li>
                                    <li>표시된 값은 공개 신호를 비교한 상대적 위험도이며, 실제 관계나 감정을 사실로 단정하는 결과가 아닙니다.</li>
                                    <li>공개 데이터가 부족할 수 있고 계정 상태나 상호작용은 시간이 지나며 바뀔 수 있습니다.</li>
                                </ul>
                            </section>

                            <section aria-labelledby="faq">
                                <h2 id="faq" className="text-[23px] font-extrabold text-fg">
                                    자주 묻는 질문
                                </h2>
                                <dl className="mt-5 divide-y divide-line border-y border-line">
                                    {FAQS.map((faq) => (
                                        <div key={faq.question} className="py-5">
                                            <dt className="text-[15px] font-bold text-fg">{faq.question}</dt>
                                            <dd className="mt-2 text-[13px] leading-[1.75] text-fg-dim">
                                                {faq.answer}
                                            </dd>
                                        </div>
                                    ))}
                                </dl>
                            </section>

                            <section aria-labelledby="method">
                                <h2 id="method" className="text-[23px] font-extrabold text-fg">
                                    판독 기준과 문서 정보
                                </h2>
                                <p className="mt-4 text-[13px] leading-[1.75] text-fg-dim">
                                    이 문서는 위장여사친 판독기의 실제 분석 범위인 공개 인스타그램 프로필, 맞팔 관계, 좋아요·댓글·태그·멘션, AI 교차 분석과 상대적 위험도 정렬을 기준으로 작성했습니다.
                                </p>
                                <dl className="mt-5 grid gap-3 border-t border-line pt-4 text-[12px] text-fg-mute sm:grid-cols-3">
                                    <div>
                                        <dt>게시일</dt>
                                        <dd className="mt-1 text-fg-dim">
                                            <time dateTime={GUIDE_PUBLISHED_DATE}>{GUIDE_PUBLISHED_DATE}</time>
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>수정일</dt>
                                        <dd className="mt-1 text-fg-dim">
                                            <time dateTime={GUIDE_MODIFIED_DATE}>{GUIDE_MODIFIED_DATE}</time>
                                        </dd>
                                    </div>
                                    <div>
                                        <dt>발행</dt>
                                        <dd className="mt-1 text-fg-dim">{GUIDE_PUBLISHER}</dd>
                                    </div>
                                </dl>
                            </section>

                            <section aria-labelledby="guide-cta">
                                <CaseCard bracket="var(--color-blood)" className="px-5 py-9 text-center">
                                    <Eyebrow className="justify-center">AI 공개 신호 판독</Eyebrow>
                                    <h2 id="guide-cta" className="mt-4 text-[22px] font-extrabold text-fg">
                                        공개 신호를 후보별로 비교해 보세요
                                    </h2>
                                    <p className="mt-3 text-[13px] leading-[1.7] text-fg-dim">
                                        남자친구의 공개 인스타그램 계정을 기준으로 판독을 시작합니다.
                                    </p>
                                    <Link
                                        href="/analyze"
                                        className="mt-6 inline-flex min-h-11 items-center justify-center border border-blood bg-blood px-6 text-[14px] font-bold text-white transition-colors hover:bg-blood-2"
                                    >
                                        위장여사친 판독 시작하기
                                    </Link>
                                </CaseCard>
                            </section>
                        </div>
                    </article>
                </main>
            </div>
        </>
    );
}
