# 디자인 시스템 — "CASE FILE"

AI 위장 여사친 판독기의 디자인 시스템. 컨셉은 **수사 기관의 감시 도감(surveillance dossier)** — 위험도 판독을 위협 등급(THREAT LEVEL) 분류로 표현한다. 다크 포렌식 베이스 + 단색 크림슨 액센트 + 페이퍼로지 타이포. 이모지 장식 대신 코너 브래킷·사건번호·검열/블러·스탬프·타뷸러 수치로 긴장감을 만든다.

- 정의 위치: `app/globals.css` (토큰·유틸·모션), `components/case-ui.tsx` (프리미티브)
- 원칙: **모바일 우선**(카톡 공유 특성), 단색 액센트, 하나의 시그니처(위협 등급 판독 유닛), 나머지는 절제.

---

## 1. 컬러 토큰

Tailwind v4 `@theme`로 정의되어 `bg-*` / `text-*` / `border-*` 유틸로 바로 사용. 유틸은 내부적으로 `var(--color-*)`를 참조하므로 변수 오버라이드로 리스킨 가능.

| 토큰 | 값 | 용도 |
|---|---|---|
| `--color-ink` | `#0c0a0b` | 페이지 배경(웜 near-black) |
| `--color-ink-2` | `#121010` | 살짝 떠 있는 표면 |
| `--color-panel` / `panel-2` | `#17120f` / `#1e1815` | 카드/입력 표면 |
| `--color-line` / `line-2` | `#2a2220` / `#3b302c` | 헤어라인/보더 |
| `--color-blood` | `#e4132a` | **메인 크림슨** — 브랜드·CTA·고위험·LIVE |
| `--color-blood-2` | `#ff3444` | hover 강조 |
| `--color-blood-dim` | `#7d1420` | 저채도 크림슨 |
| `--color-amber` | `#e0a32e` | 등급: 주의 |
| `--color-jade` | `#46a08a` | 등급: 정상/완료 |
| `--color-fg` | `#f3efea` | 본문 텍스트(웜 화이트) |
| `--color-fg-dim` | `#8c827b` | 보조 텍스트 |
| `--color-fg-mute` | `#5f564f` | 미세 텍스트/캡션 |
| `--color-paper` | `#ece6db` | 문서톤 표면(구글 버튼 등) |
| `--glow-rgb` | `228 19 42` | 글로우/셀렉션(`rgb(var(--glow-rgb)/α)`) |

**등급 스케일**: 고위험=`blood` · 주의=`amber` · 정상=`jade`. 크림슨이 지배하도록 amber/jade는 채도를 낮춰 둔다.

---

## 2. 타이포그래피 — Paperlogy

전 화면 **페이퍼로지 단일 패밀리**, 위계는 웨이트로만 준다. `next/font/local`로 셀프호스팅(`app/fonts/paperlogy/`, 300–900 7웨이트). 별도 mono 폰트를 쓰지 않고 수치는 `.num`(`tabular-nums`)으로 데이터 판독감을 낸다.

| 역할 | 웨이트 | 예시 |
|---|---|---|
| 히어로 디스플레이 | 700 (Bold) | 메인 헤드라인 |
| 섹션 헤딩(H2) | 800 (ExtraBold) | "3단계로 끝나는 판독" |
| 카드 제목(H3) | 700 | 스텝 타이틀 |
| 본문 | 400/500 | 설명 문구 |
| 라벨/아이브로 | 600 + 와이드 자간 | `.eyebrow` |
| 미세 문구 | 300/400 | 면책·캡션 |

**규칙**: 한글은 `word-break: keep-all`(단어 중간 안 깨짐). 숫자·사건번호·RISK 수치는 `.num`으로 정렬. 아이브로는 `.eyebrow`(11px, `letter-spacing .26em`, 대문자, `fg-dim`).

대략적 크기 스케일(px): 디스플레이 34 · H2 24 · H3 16 · 본문 13–15 · 캡션 11–12.

---

## 3. 프리미티브 (`components/case-ui.tsx`)

| 컴포넌트 | 설명 |
|---|---|
| `TopBar` | 스티키 상단바(브랜드 마크 + 워드마크 + `right` 슬롯). 화면 공통 헤더. |
| `BrandMark` | 조준경(reticle) SVG 브랜드 글리프. `size`, `className`. |
| `Eyebrow` | 크림슨 틱 + 와이드 자간 라벨. 섹션 도입부. |
| `CaseCard` | 코너 브래킷 카드. `bracket`(브래킷 색), `className`. |
| `ThreatBar` | 세그먼트형 위협 게이지. `grade`로 색/채움(고12·주의8·정상4 / 14칸). |
| `RiskTag` | 등급 태그 칩(고위험/주의/정상). |
| `Stamp` | 회전 스탬프 라벨(예: "고위험 감지"). |
| `Redaction` | 검열 바(단색). 실제 블러가 필요하면 `blur-[5px] select-none`으로 텍스트를 블러 처리. |
| `PrimaryButton` / `primaryCls` | 크림슨 CTA. `size="md" | "lg"`. |
| `ghostCls` | 보더형 보조 액션 클래스. |

인증: `components/auth-buttons.tsx`(카카오/구글, `redirectTo`), `components/login-modal.tsx`(오버레이 로그인). `/login` 페이지와 랜딩 히어로 모달이 이 둘을 공유한다.

---

## 4. 모션

`app/globals.css` 키프레임 유틸. `prefers-reduced-motion`에서 전역으로 비활성.

| 클래스 | 용도 |
|---|---|
| `.anim-scan` | 히어로 도시에 스캔 라인 |
| `.anim-blink` | LIVE/현재 단계 점멸 |
| `.anim-radar` | 진행 화면 레이더 스윕 |
| `.anim-marquee` | 신뢰 스트립 흐름 |
| `.anim-stamp` | 카드 stamp-in |

랜딩 히어로의 순차 등장은 framer-motion(`useReducedMotion` 가드) 사용.

---

## 5. 레이아웃 컨벤션

- 콘텐츠 폭: 랜딩/일반 `max-w-[460px]`, 리포트 `max-w-[480px]`, 텍스트 문서 `max-w-[640px]`. 모두 `mx-auto px-5`.
- 배경 질감: `body::before`에 상단 크림슨 글로우 + 스캔라인 + 미세 그리드(고정, `z-index:-1`).
- 포커스 링: `:focus-visible` → 크림슨 2px.
- 화면 셸: 각 페이지 루트 `min-h-dvh` + `TopBar`.

---

## 6. 사용 예시

```tsx
import { CaseCard, Eyebrow, ThreatBar, RiskTag, PrimaryButton } from '@/components/case-ui';

<section className="mx-auto max-w-[460px] px-5">
  <Eyebrow>위협 등급 순위</Eyebrow>
  <CaseCard bracket="var(--color-blood)" className="mt-4 p-4">
    <div className="flex items-center justify-between">
      <span className="num text-fg">#01 @account</span>
      <RiskTag grade="high_risk" />
    </div>
    <ThreatBar grade="high_risk" className="mt-3" />
  </CaseCard>
  <PrimaryButton size="lg" className="mt-6">지금 바로 판독하기</PrimaryButton>
</section>
```

---

## 7. 다시 칠할 때(리스킨)

모든 액센트가 `--color-blood` / `--glow-rgb`를 참조하므로, 상위 요소에 스코프를 잡고 이 변수만 오버라이드하면 전체가 리스킨된다. (예: 민트 방향 A/B를 `:root[data-theme="mint"]`로 실험했었다.) 등급색(amber/jade)까지 함께 조정하면 완전히 다른 무드가 된다.
