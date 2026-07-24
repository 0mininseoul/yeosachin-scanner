'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import {
  CaseCard,
  RecentMutualBadge,
  RiskTag,
  Stamp,
  SuspectAvatar,
  ThreatBar,
} from '@/components/case-ui';
import {
  revealVerdicts,
  totalVerdictChars,
  type VerdictRowReveal,
} from '@/lib/services/landing/verdict-reveal';

type Grade = 'high_risk' | 'caution' | 'normal';

interface Suspect {
  rank: string;
  grade: Grade;
  name: string;
  avatar: string;
  score: number;
  recentMutualRank?: 1 | 2 | 3 | 4 | 5;
  verdict: string[];
  capturedComments?: string[];
}

// NOTE: 랜딩 데모용 목업. 총평 근거는 실제 서비스가 트래킹하는 신호(좋아요 방향·댓글
// 친밀도·맞팔·프로필 스타일)로만 구성한다. 좋아요 타이밍/스토리 반응은 서비스가
// 트래킹하지 않으므로 카피에서 암시하지 않는다.
const SUSPECTS: Suspect[] = [
  {
    rank: '01',
    grade: 'high_risk',
    name: 'suzy_kim_02',
    avatar: '/demo/suspect-01.jpg',
    score: 9,
    recentMutualRank: 1,
    verdict: [
      '셀카 위주 피드에 감성 카페·전시 태그가 반복되는, 취향 뚜렷한 계정이에요.',
      '맞팔 여성 187명 중 상호작용 1위 — 게시물마다 서로 좋아요가 오갔고, 댓글 친밀도도 ‘그냥 친구’ 선을 넘었습니다.',
    ],
    capturedComments: ['오빠 나 안보고시푸 ?', '😘😘😘'],
  },
  {
    rank: '02',
    grade: 'caution',
    name: 'yuna.daily',
    avatar: '/demo/suspect-02.jpg',
    score: 6,
    verdict: ['데일리룩 위주 계정인데, 남친이 이 피드에 꾸준히 좋아요를 남긴 흔적이 잡혔어요.'],
  },
  {
    rank: '03',
    grade: 'caution',
    name: 'haram_log',
    avatar: '/demo/suspect-03.jpg',
    score: 5,
    verdict: ['취미 모임에서 자주 엮이는 계정인데, 최근 댓글 주고받는 빈도가 눈에 띄게 늘었어요.'],
  },
];

const CHAR_INTERVAL_MS = 26;

// Advances a single "revealed characters" budget once the card scrolls into view,
// then maps it onto per-row visible substrings. Honors reduced-motion by showing
// the finished state immediately.
function useSequentialVerdicts(active: boolean): {
  reveals: VerdictRowReveal[];
  caret: { row: number; line: number } | null;
} {
  const reduce = useReducedMotion();
  const total = totalVerdictChars(SUSPECTS.map((s) => ({ lines: s.verdict })));
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    // reduced-motion shows the finished text directly in render (below), so the
    // effect only drives the animated case.
    if (!active || reduce) return;
    let count = 0;
    const id = window.setInterval(() => {
      count += 1;
      setRevealed(count);
      if (count >= total) window.clearInterval(id);
    }, CHAR_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [active, reduce, total]);

  const reveals = revealVerdicts(
    SUSPECTS.map((s) => ({ lines: s.verdict })),
    reduce && active ? total : revealed,
  );

  let caret: { row: number; line: number } | null = null;
  if (active && !reduce) {
    outer: for (let r = 0; r < reveals.length; r += 1) {
      for (let l = 0; l < reveals[r].lines.length; l += 1) {
        if (reveals[r].lines[l].length < SUSPECTS[r].verdict[l].length) {
          caret = { row: r, line: l };
          break outer;
        }
      }
    }
  }

  return { reveals, caret };
}

const listV: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.14, delayChildren: 0.3 } },
};
const rowV: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.2, 0.8, 0.2, 1] } },
};

export function LandingSignatureCard() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  const { reveals, caret } = useSequentialVerdicts(inView);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      const timer = window.setTimeout(() => setInView(true), 0);
      return () => window.clearTimeout(timer);
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref}>
      <CaseCard bracket="var(--color-blood)" className="overflow-hidden">
        {/* scanning line — sweeps the full card height even as it grows */}
        <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
          <div className="anim-scan absolute left-0 h-16 w-full bg-gradient-to-b from-transparent via-blood/25 to-transparent" />
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
        <motion.ul
          variants={listV}
          initial={reduce ? false : 'hidden'}
          animate="show"
          className="divide-y divide-line/70"
        >
          {SUSPECTS.map((s, i) => {
            const reveal = reveals[i];
            const rowDone = reveal.complete;
            return (
              <motion.li key={s.rank} variants={rowV} className="px-4 py-4">
                {/* meta */}
                <div className="flex items-center gap-3">
                  <SuspectAvatar src={s.avatar} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
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
                      <RiskTag grade={s.grade} className="ml-auto shrink-0" />
                    </div>
                  </div>
                </div>

                {s.recentMutualRank && (
                  <div className="mt-2.5">
                    <RecentMutualBadge rank={s.recentMutualRank} />
                  </div>
                )}

                {/* threat meter + score */}
                <div className="mt-3 flex items-center gap-3">
                  <ThreatBar grade={s.grade} score={s.score} className="flex-1" />
                  <span className="num shrink-0 text-[12px] font-bold text-fg">{s.score}/10</span>
                </div>

                {/* streaming verdict */}
                <div className="mt-3 space-y-1">
                  {reveal.lines.map((text, li) => (
                    <p key={li} className="text-[12px] leading-[1.7] text-fg-dim">
                      {text}
                      {caret && caret.row === i && caret.line === li && (
                        <span className="anim-blink ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[0.15em] bg-blood" />
                      )}
                    </p>
                  ))}
                </div>

                {/* captured comments (revealed once the verdict finishes) */}
                {s.capturedComments && s.capturedComments.length > 0 && (
                  <motion.div
                    initial={false}
                    animate={{ opacity: rowDone ? 1 : 0, y: rowDone ? 0 : 4 }}
                    transition={{ duration: 0.35, ease: 'easeOut' }}
                    className="mt-2.5"
                    aria-hidden={!rowDone}
                  >
                    <div className="border border-blood/25 bg-blood/[0.06] px-3 py-2.5">
                      <span className="eyebrow text-blood">포착된 댓글</span>
                      <div className="mt-1.5 space-y-1">
                        {s.capturedComments.map((comment, ci) => (
                          <p key={ci} className="text-[12.5px] leading-relaxed text-fg">
                            “{comment}”
                          </p>
                        ))}
                      </div>
                      <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-fg-mute">
                        <span aria-hidden="true">—</span>
                        <span aria-hidden="true" className="select-none blur-[4px]">
                          @{s.name}
                        </span>
                      </p>
                    </div>
                  </motion.div>
                )}
              </motion.li>
            );
          })}
        </motion.ul>

        <div className="flex items-center justify-between border-t border-line px-4 py-3">
          <span className="text-[12px] text-fg-mute">3명 판독 완료</span>
          <Stamp className="-rotate-3">고위험 감지</Stamp>
        </div>
      </CaseCard>
    </div>
  );
}
