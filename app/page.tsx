'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import { useAuth } from '@/hooks/useAuth';
import {
  TopBar,
  Eyebrow,
  CaseCard,
  ThreatBar,
  RiskTag,
  Stamp,
  Redaction,
  PrimaryButton,
} from '@/components/case-ui';

type Grade = 'high_risk' | 'caution' | 'normal';

const DEMO_SUSPECTS: { rank: string; grade: Grade; w: string }[] = [
  { rank: '01', grade: 'high_risk', w: '58%' },
  { rank: '02', grade: 'caution', w: '44%' },
  { rank: '03', grade: 'normal', w: '66%' },
];

const STEPS = [
  {
    n: '01',
    title: '대상 지정',
    body: '남자친구의 인스타그램 아이디만 입력하세요. 비밀번호는 절대 묻지 않습니다.',
  },
  {
    n: '02',
    title: 'AI 정밀 판독',
    body: '맞팔 목록을 스캔해 성별을 식별하고, 계정 분위기·태그·상호작용을 교차 분석합니다.',
  },
  {
    n: '03',
    title: '판독 리포트',
    body: "위협 등급이 높은 '위장 여사친' 후보를 순위별로 정리해 보여드립니다.",
  },
];

const REVIEWS = [
  {
    grade: 'high_risk' as Grade,
    body: '그냥 아는 동생이라던 계정이 고위험 1위로 떴어요. 혹시나 해서 봤더니… 진짜 소름.',
    who: '23세 · 대학생',
    when: '어제',
  },
  {
    grade: 'caution' as Grade,
    body: '비공개 계정까지 리스트로 쫙 뽑아줘서 좋았어요. 내가 모르던 계정이 이렇게 많을 줄이야.',
    who: '26세 · 직장인',
    when: '2일 전',
  },
];

export default function LandingPage() {
  const router = useRouter();
  const { user } = useAuth();
  const reduce = useReducedMotion();

  const handleStart = () => {
    trackEvent(EVENTS.CLICK_CTA_START);
    router.push(user ? '/analyze' : '/login');
  };

  const EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1];
  const listV: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: reduce ? 0 : 0.12, delayChildren: reduce ? 0 : 0.55 } },
  };
  const itemV: Variants = {
    hidden: reduce ? { opacity: 1 } : { opacity: 0, y: 8 },
    show: reduce ? { opacity: 1 } : { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } },
  };

  return (
    <div className="min-h-dvh">
      <TopBar
        right={
          user ? (
            <>
              <button
                onClick={() => router.push('/mypage')}
                className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
              >
                기록실
              </button>
              <button
                onClick={() => router.push('/analyze')}
                className="border border-blood bg-blood px-3.5 py-1.5 text-[13px] font-bold text-white transition-colors hover:bg-blood-2"
              >
                판독 시작
              </button>
            </>
          ) : (
            <button
              onClick={() => router.push('/login')}
              className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
            >
              로그인
            </button>
          )
        }
      />

      <main className="mx-auto max-w-[460px] px-5">
        {/* ---------- HERO ---------- */}
        <section className="pb-14 pt-12">
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
          >
            <div className="mb-5 flex items-center justify-between">
              <Eyebrow>CASE FILE · 판독 의뢰</Eyebrow>
              <span className="num text-[11px] tracking-[0.2em] text-fg-mute">NO. 0421-KR</span>
            </div>

            <h1 className="text-[34px] font-bold leading-[1.14] tracking-[-0.02em] text-fg">
              내 남친이 맞팔 중인 여자들,
              <br />
              <span className="text-blood">누가 제일 위험할까?</span>
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-fg-dim">
              &quot;그냥 친구야&quot;라는 말,
              <br />
              AI가 팩트 체크해드립니다.
            </p>
          </motion.div>

          {/* signature: live dossier readout */}
          <motion.div
            initial={reduce ? false : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: reduce ? 0 : 0.25, duration: 0.5, ease: EASE }}
            className="mt-8"
          >
            <CaseCard bracket="var(--color-blood)" className="overflow-hidden">
              {/* scanning line */}
              <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
                <div className="anim-scan h-16 w-full bg-gradient-to-b from-transparent via-blood/25 to-transparent" />
              </div>

              {/* header */}
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <span className="eyebrow">위협 등급 판독</span>
                <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-blood">
                  <span className="anim-blink h-1.5 w-1.5 bg-blood" />
                  LIVE
                </span>
              </div>

              {/* suspect rows */}
              <motion.ul variants={listV} initial="hidden" animate="show" className="divide-y divide-line/70">
                {DEMO_SUSPECTS.map((s) => (
                  <motion.li key={s.rank} variants={itemV} className="flex items-center gap-3 px-4 py-3.5">
                    <span className="num shrink-0 whitespace-nowrap text-[13px] font-bold tracking-wider text-fg-mute">
                      #{s.rank}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="text-[13px] font-bold text-fg-dim">@</span>
                        <Redaction style={{ width: s.w }} />
                        <RiskTag grade={s.grade} className="ml-auto" />
                      </div>
                      <ThreatBar grade={s.grade} />
                    </div>
                  </motion.li>
                ))}
              </motion.ul>

              <div className="flex items-center justify-between border-t border-line px-4 py-3">
                <span className="text-[12px] text-fg-mute">3명 판독 완료</span>
                <Stamp className="-rotate-3">고위험 감지</Stamp>
              </div>
            </CaseCard>
          </motion.div>

          <div className="mt-8">
            <PrimaryButton onClick={handleStart} size="lg">
              지금 바로 판독하기
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </PrimaryButton>
            <p className="mt-3 text-center text-[12px] text-fg-mute">
              판독 결과는 상대방에게 절대 통보되지 않습니다.
            </p>
          </div>
        </section>

        {/* ---------- assurance strip ---------- */}
        <div className="-mx-5 overflow-hidden border-y border-line bg-ink-2 py-2.5">
          <div className="anim-marquee flex w-max whitespace-nowrap">
            {[0, 1].map((k) => (
              <div key={k} className="flex items-center" aria-hidden={k === 1}>
                {['비밀 보장 100%', '상대방 통보 없음', '공개 정보 기반 분석', '비밀번호 요구 없음'].map((t) => (
                  <span key={t} className="flex items-center px-6 text-[12px] font-medium tracking-[0.08em] text-fg-dim">
                    <span className="mr-6 h-1 w-1 bg-blood" />
                    {t}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* ---------- process ---------- */}
        <section className="py-16">
          <Eyebrow>판독 절차</Eyebrow>
          <h2 className="mt-3 text-[24px] font-extrabold tracking-tight text-fg">3단계로 끝나는 판독</h2>

          <div className="mt-8 space-y-3">
            {STEPS.map((s) => (
              <CaseCard key={s.n} className="flex items-start gap-4 p-4">
                <span className="num text-[26px] font-black leading-none text-blood/85">{s.n}</span>
                <div className="pt-0.5">
                  <h3 className="text-[16px] font-bold text-fg">{s.title}</h3>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg-dim">{s.body}</p>
                </div>
              </CaseCard>
            ))}
          </div>
        </section>

        {/* ---------- reviews ---------- */}
        <section className="pb-16">
          <Eyebrow>열람 후기</Eyebrow>
          <h2 className="mt-3 text-[24px] font-extrabold tracking-tight text-fg">이미 많은 분들이 확인했어요</h2>

          <div className="mt-8 space-y-3">
            {REVIEWS.map((r, i) => (
              <CaseCard key={i} className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <RiskTag grade={r.grade} />
                  <span className="num text-[11px] tracking-[0.14em] text-fg-mute">{r.when}</span>
                </div>
                <p className="text-[14px] leading-relaxed text-fg">&ldquo;{r.body}&rdquo;</p>
                <p className="mt-3 border-t border-line pt-3 text-[12px] text-fg-dim">{r.who}</p>
              </CaseCard>
            ))}
          </div>
        </section>

        {/* ---------- bottom CTA ---------- */}
        <section className="pb-16">
          <CaseCard bracket="var(--color-blood)" className="px-6 py-9 text-center">
            <Eyebrow className="justify-center">무료 판독</Eyebrow>
            <h2 className="mt-4 text-[19px] font-extrabold leading-snug tracking-tight text-fg">
              더 늦기 전에, 지금 확인하세요
            </h2>
            <p className="mt-3 text-[13px] leading-relaxed text-fg-dim">
              불안해하며 시간 낭비하지 마세요.
              <br />
              AI가 3분 만에 사실을 정리해 드립니다.
            </p>
            <div className="mt-7">
              <PrimaryButton onClick={handleStart} size="lg">
                지금 바로 위장 여사친 찾아내기
              </PrimaryButton>
            </div>
          </CaseCard>
        </section>

        {/* ---------- footer ---------- */}
        <footer className="border-t border-line py-9">
          <div className="mb-4">
            <span className="eyebrow">AI 위장 여사친 판독기</span>
          </div>
          <p className="text-[12px] leading-relaxed text-fg-mute">
            본 서비스는 AI 기술로 공개된 정보를 분석합니다. 판독 결과는 100% 정확성을 보장하지 않으며, 재미 목적으로만 이용해 주세요.
          </p>
          <div className="mt-5 flex gap-5 text-[12px] text-fg-dim">
            <Link href="/terms" className="transition-colors hover:text-fg">
              이용약관
            </Link>
            <Link href="/privacy" className="transition-colors hover:text-fg">
              개인정보처리방침
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
