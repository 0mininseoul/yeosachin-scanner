'use client';

/* ============================================================================
 * ⚠️ 랜딩 마케팅 카피 = 프론트엔드 소관 (확정 문구). — CLAUDE.md Project Rules #4
 * 히어로 헤드라인/서브·미세문구, 판독 절차 STEP, '왜 AI 판독인가' 신뢰 블록,
 * 신뢰 스트립, 하단 CTA 헤드라인/서브/버튼 등을 백엔드·기능 작업 중에
 * 임의로 수정하거나 순화하지 마세요. 기능(로직·props)만 추가하고 문구는 그대로.
 * 변경이 꼭 필요하면 사용자에게 먼저 확인할 것. (과거 순화 덮어쓰기 사례 있음)
 * ============================================================================ */

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { trackEvent, EVENTS } from '@/lib/services/analytics';
import { useAuth } from '@/hooks/useAuth';
import { LoginModal } from '@/components/login-modal';
import {
  getAnalysisStartIdempotency,
  type AnalysisStartIdempotency,
} from '@/lib/services/analysis/client-idempotency';
import {
  TopBar,
  BrandMark,
  Eyebrow,
  CaseCard,
  ThreatBar,
  RiskTag,
  Stamp,
  PrimaryButton,
} from '@/components/case-ui';

type Grade = 'high_risk' | 'caution' | 'normal';

// NOTE: 데모용 목업. 원형 프로필은 실제 AI 생성 여성 이미지로 교체 예정(현재 플레이스홀더).
const DEMO_SUSPECTS: { rank: string; grade: Grade; name: string }[] = [
  { rank: '01', grade: 'high_risk', name: 'suzy_kim_02' },
  { rank: '02', grade: 'caution', name: 'yuna.daily' },
  { rank: '03', grade: 'normal', name: 'haram_log' },
];

const AVATAR_TINTS = [
  { from: '#4a3136', to: '#241a1c' },
  { from: '#3a3048', to: '#1c1a24' },
  { from: '#48402e', to: '#241f1a' },
];

function DemoAvatar({ i }: { i: number }) {
  const t = AVATAR_TINTS[i % AVATAR_TINTS.length];
  return (
    <div
      className="relative h-10 w-10 shrink-0 overflow-hidden rounded-full border border-line-2"
      style={{ background: `linear-gradient(140deg, ${t.from}, ${t.to})` }}
      aria-hidden="true"
    >
      <svg viewBox="0 0 40 40" className="absolute inset-0 h-full w-full text-fg/30">
        <circle cx="20" cy="15.5" r="6.8" fill="currentColor" />
        <path d="M6.5 40c0-7.7 6-12.5 13.5-12.5S33.5 32.3 33.5 40z" fill="currentColor" />
      </svg>
    </div>
  );
}

const STEPS = [
  {
    n: '01',
    title: '아이디 하나면 충분',
    body: ['남자친구 인스타그램 아이디만 넣으세요.', '나머지는 AI가 알아서 전부 파 드립니다.'],
  },
  {
    n: '02',
    title: '직접 못 찾는 것까지 판독',
    body: ['맞팔 수백 명의 성별을 식별해 이성만 추려내고,', '상호작용·친밀도·프로필 분위기까지 5개 축으로 교차 분석합니다.'],
  },
  {
    n: '03',
    title: '위협 등급 리포트',
    body: ['위장 여사친 후보를 위험도 순으로 정렬하고,', '위장여사친들의 정체를 구체적 근거 기반으로 전부 보여드립니다.'],
  },
];

// 신뢰 블록 — "직접은 불가능, AI만 가능"을 강조 (자극적 톤)
const TRUST = [
  { title: '맞팔 전수조사', body: '수백 명을 일일이 볼 순 없죠. AI가 한 명도 빠짐없이 훑습니다.' },
  { title: '여사친들만 선별', body: '성별을 식별해 위장 여사친 후보만 골라냅니다.' },
  { title: '상호작용 추적', body: '좋아요·댓글·태그·멘션·친밀도까지 정밀 분석합니다.' },
  { title: '상대방은 절대 모름', body: '조회 흔적도, 알림도 남지 않습니다.' },
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

  const inputRef = useRef<HTMLInputElement>(null);
  const idempotencyRef = useRef<AnalysisStartIdempotency | null>(null);
  const [igId, setIgId] = useState('');
  const [starting, setStarting] = useState(false);
  const [heroError, setHeroError] = useState<string | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  const closeLogin = useCallback(() => {
    try {
      sessionStorage.removeItem('pending_ig');
    } catch {
      /* ignore */
    }
    setLoginOpen(false);
  }, []);

  const handleStart = async () => {
    const id = igId.replace(/@/g, '').trim();
    if (!id) {
      setHeroError('남자친구의 인스타그램 아이디를 입력해주세요.');
      inputRef.current?.focus();
      return;
    }
    trackEvent(EVENTS.CLICK_CTA_START);

    if (!user) {
      try {
        sessionStorage.setItem('pending_ig', id);
      } catch {
        /* ignore */
      }
      setLoginOpen(true);
      return;
    }

    setStarting(true);
    setHeroError(null);
    try {
      idempotencyRef.current = getAnalysisStartIdempotency(
        idempotencyRef.current,
        id,
        'male'
      );
      const res = await fetch('/api/analysis/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyRef.current.key,
        },
        body: JSON.stringify({ targetInstagramId: id, targetGender: 'male' }),
      });
      const data = await res.json();
      if (!res.ok) {
        setHeroError(data.error || '판독 시작에 실패했습니다.');
        setStarting(false);
        return;
      }
      trackEvent(EVENTS.ANALYSIS_START);
      router.push(`/progress/${data.requestId}`);
    } catch (err) {
      console.error('Failed to start analysis:', err);
      setHeroError('서버 오류가 발생했습니다.');
      setStarting(false);
    }
  };

  const focusInput = () => {
    inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => inputRef.current?.focus(), 420);
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
                보관함
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
              onClick={() => setLoginOpen(true)}
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
            <div className="mb-5">
              <Eyebrow>국내 유일 위장여사친 판독 서비스</Eyebrow>
            </div>

            <h1 className="text-[26px] font-bold leading-[1.2] tracking-[-0.02em] text-fg sm:text-[34px] sm:leading-[1.14]">
              내 남친이 맞팔 중인 여자들,
              <br />
              <span className="text-blood">누가 제일 위험할까?</span>
            </h1>
            <p className="mt-4 text-[15px] leading-relaxed text-fg-dim">
              &quot;그냥 친구야&quot;라는 말, AI가 팩트 체크해드립니다.
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
                {DEMO_SUSPECTS.map((s, i) => (
                  <motion.li key={s.rank} variants={itemV} className="flex items-center gap-3 px-4 py-3.5">
                    <DemoAvatar i={i} />
                    <div className="min-w-0 flex-1">
                      <div className="mb-2 flex items-center gap-2">
                        <span className="num shrink-0 text-[12px] font-bold tracking-wider text-fg-mute">
                          #{s.rank}
                        </span>
                        <span className="text-[13px] font-bold text-fg-dim">@</span>
                        <span
                          aria-hidden="true"
                          className="min-w-0 flex-1 select-none truncate text-[13px] font-semibold text-fg/90 blur-[5px]"
                        >
                          {s.name}
                        </span>
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

          {/* input + submit */}
          <div className="mt-8 space-y-2.5">
            <label htmlFor="ig-hero" className="block text-[15px] font-bold text-fg">
              지금 바로 위장여사친 판독하기
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim">@</span>
              <input
                id="ig-hero"
                ref={inputRef}
                type="text"
                value={igId}
                onChange={(e) => {
                  setIgId(e.target.value);
                  if (heroError) setHeroError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && !starting && handleStart()}
                placeholder="남자친구 인스타그램 아이디"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-label="남자친구 인스타그램 아이디"
                className="w-full border border-line bg-ink-2 py-4 pl-9 pr-16 text-[15px] text-fg placeholder-fg-mute transition-colors focus:border-blood focus:outline-none"
              />
              <button
                onClick={handleStart}
                disabled={starting}
                aria-label="판독하기"
                className="absolute right-1.5 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center bg-blood text-white transition-colors hover:bg-blood-2 disabled:bg-panel disabled:text-fg-mute"
              >
                {starting ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 12h13M12 5.5 18.5 12 12 18.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            </div>
            {heroError && <p className="px-1 text-[12px] text-blood">{heroError}</p>}
            <p className="text-center text-[12px] text-fg-mute">
              판독 결과는 상대방에게 절대 통보되지 않습니다.
            </p>
          </div>
        </section>

        {/* ---------- assurance strip ---------- */}
        <div className="-mx-5 overflow-hidden border-y border-line bg-ink-2 py-2.5">
          <div className="anim-marquee flex w-max whitespace-nowrap">
            {[0, 1].map((k) => (
              <div key={k} className="flex items-center" aria-hidden={k === 1}>
                {['상대방 통보 없음', '비밀 보장 100%', '아이디 하나면 끝', '5분이면 결과 완료'].map((t) => (
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
                  <p className="mt-1.5 text-[13px] leading-relaxed text-fg-dim">
                    {s.body.map((line, i) => (
                      <span key={i} className="block">
                        {line}
                      </span>
                    ))}
                  </p>
                </div>
              </CaseCard>
            ))}
          </div>
        </section>

        {/* ---------- why AI (trust) ---------- */}
        <section className="pb-16">
          <Eyebrow>왜 AI 판독인가</Eyebrow>
          <h2 className="mt-3 text-[24px] font-extrabold leading-snug tracking-tight text-fg">
            직접 뒤지는 건 <span className="text-blood">불가능</span>합니다
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
            밤새 프로필을 눌러봐도 못 찾는 걸, AI는 5분이면 끝냅니다.
          </p>

          <div className="mt-8 grid grid-cols-2 gap-3">
            {TRUST.map((t, i) => (
              <CaseCard key={i} className="p-4">
                <BrandMark size={16} className="text-blood" />
                <h3 className="mt-3 text-[14px] font-bold text-fg">{t.title}</h3>
                <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">{t.body}</p>
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
          <CaseCard bracket="var(--color-blood)" className="px-5 py-10 text-center">
            <Eyebrow className="justify-center">AI 정밀 판독</Eyebrow>
            <h2 className="mt-4 text-[20px] font-extrabold leading-tight tracking-tight text-fg sm:text-[26px]">
              남자친구가 알려주지 않는 진실
            </h2>
            <p className="mt-3.5 text-[13px] leading-relaxed text-fg-dim">
              불안해하며 시간 낭비하지 마세요.
              <br />
              AI가 5분 안에 진실을 파헤쳐 드립니다.
            </p>
            <div className="mt-7">
              <PrimaryButton onClick={focusInput} size="lg">
                지금 바로 위장 여사친 찾아내기
              </PrimaryButton>
            </div>
          </CaseCard>
        </section>

        {/* ---------- footer ---------- */}
        <footer className="border-t border-line py-9">
          <div className="mb-4">
            <span className="eyebrow">위장여사친 판독기</span>
          </div>
          <p className="text-[12px] leading-relaxed text-fg-mute">
            본 서비스는 AI 기술로 공개된 정보를 분석합니다.
            <br />
            판독 결과는 100% 정확성을 보장하지 않으며, 재미 목적으로만 이용해 주세요.
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

      <LoginModal open={loginOpen} onClose={closeLogin} redirectTo="/analyze" />
    </div>
  );
}
