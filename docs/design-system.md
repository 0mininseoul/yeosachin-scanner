# 디자인 시스템 — "CASE FILE"

AI 위장 여사친 판독기의 디자인 시스템. 컨셉은 **수사 기관의 감시 도감(surveillance dossier)** — 위험도 판독을 위협 등급(THREAT LEVEL) 분류로 표현한다. 다크 포렌식 베이스 + 단색 크림슨 액센트 + 페이퍼로지 타이포. 이모지 장식 대신 코너 브래킷·사건번호·검열/블러·스탬프·타뷸러 수치로 긴장감을 만든다.

- 정의 위치: `app/globals.css` (토큰·유틸·모션), `components/case-ui.tsx` (프리미티브)
- 원칙: **모바일 우선**(카톡 공유 특성), 단색 액센트, 하나의 시그니처(위협 등급 판독 유닛), 나머지는 절제.

---

## 0. 컨테이너 3단계 — 이 시스템의 중심 규칙

한때 `CaseCard` 하나가 절차 스텝, 신뢰 문구, 입력 폼, 에러 상태, 결과 행, 요약 지표를 전부 담고 있었다. 모든 컨테이너가 같은 시각적 무게를 가지면 화면에서 무엇이 중요한지 사라진다. 그래서 컨테이너에 등급을 부여하고 의미를 고정한다.

| 단계 | 형태 | 의미 | 적용처 |
|---|---|---|---|
| **Tier 0 — 플레인** | 컨테이너 없음. 여백 + hairline 1개 | 기본값. 나열되는 정보 | 결과 헤더, 정상/주의 계정 행, 보관함 행, 랜딩 절차·신뢰·후기, 진행 로그, 빈 상태 |
| **Tier 1 — `Panel`** | hairline 테두리만. 브래킷 없음 | 조작 가능한 면 | 분석 입력 폼, 요금제 선택, 탭 바 |
| **Tier 2 — `CaseCard`** | 테두리 + 코너 브래킷 + 액센트 | **구획당 최대 1종. 그 구획의 판결** | 고위험 계정 행, 랜딩 히어로 데모, 최종 CTA, 에러/중단 상태 |

**새 UI를 만들 때 Tier 0부터 시작한다.** 박스가 필요하다고 느끼면 그게 조작면인지(Tier 1) 판결인지(Tier 2) 먼저 답할 것. 둘 다 아니면 여백과 hairline으로 충분하다.

코너 브래킷은 이 브랜드에서 가장 강한 장치다. 전 화면에 뿌리면 신호로 기능하지 못한다. Tier 2 전용으로 묶어야 다시 "여기가 중요하다"로 읽힌다.

### 파생 규칙: 테두리 = 누를 수 있음

결과 행에서 테두리를 가진 요소는 `InstaButton` 하나뿐이다. 등급·최근 맞팔·게이지에서 박스를 걷어낸 이유가 이것이다. 테두리의 의미가 "누를 수 있음"으로 고정되면 사용자가 학습할 게 하나 줄어든다.

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
| `--color-fg-mute` | `#5f564f` | **장식·비활성 전용** (아래 대비 규칙 참고) |
| `--color-paper` | `#ece6db` | 문서톤 표면(구글 버튼 등) |
| `--glow-rgb` | `228 19 42` | 글로우/셀렉션(`rgb(var(--glow-rgb)/α)`) |
| `--ease-settle` | `cubic-bezier(.19,1,.22,1)` | 모든 리빌의 감속 커브 |

**등급 스케일**: 고위험=`blood` · 주의=`amber` · 정상=`jade`. 크림슨이 지배하도록 amber/jade는 채도를 낮춰 둔다.

### 대비 규칙 — 강등은 크기와 굵기로, 대비로 하지 않는다

`fg-mute`(#5f564f)는 `ink`(#0c0a0b) 위에서 **2.75:1**로 WCAG AA(4.5:1)에 미달한다. `fg-dim`(#8c827b)은 5.26:1로 통과한다.

- 의미를 가진 라벨·수치는 **최소 `fg-dim`**
- `fg-mute`는 구분자·비활성 상태·순수 장식에만
- 덜 중요해 보이게 만들 때는 폰트 크기와 굵기를 낮춘다. 대비를 낮추면 안 읽힌다

`result-page-copy-contract.test.ts`가 결과 요약 영역에서 `text-fg-mute` 사용을 금지하고, `fg-mute`가 실제로 AA에 미달한다는 사실 자체도 함께 검증한다.

### 크림슨은 위험을 뜻한다

단일 액센트라서 "강조"와 "위험"이 같은 색이다. **가장 좋은 결과에 크림슨을 쓰면 안 된다** — 고위험 0건이면 숫자와 레일을 `jade`로 전환한다.

---

## 2. 타이포그래피 — Paperlogy

전 화면 **페이퍼로지 단일 패밀리**, 위계는 웨이트로만 준다. `next/font/local`로 셀프호스팅(`app/fonts/paperlogy/`, 300–900 7웨이트). 별도 mono 폰트를 쓰지 않고 수치는 `.num`(`tabular-nums`)으로 데이터 판독감을 낸다.

| 역할 | 웨이트 | 예시 |
|---|---|---|
| 히어로 디스플레이 | 700 (Bold) | 메인 헤드라인 |
| 섹션 헤딩(H2) | 800 (ExtraBold) | "3단계로 끝나는 판독" |
| 카드 제목(H3) | 700 | 스텝 타이틀 |
| 본문 | 400/500 | 설명 문구 |
| 라벨/아이브로 | 700 | `.eyebrow` / `.label-ko` |
| 미세 문구 | 300/400 | 면책·캡션 |

**규칙**: 한글은 `word-break: keep-all`(단어 중간 안 깨짐). 숫자·사건번호·RISK 수치는 `.num`으로 정렬.

### 한글 자간

라틴 기준의 넓은 자간은 한글 음절을 뜯어 놓는다. `.eyebrow`가 `0.26em`이던 시절 "맞팔 계정 분석"이 **"맞 팔 계 정 분 석"**으로 벌어졌다. 이 제품의 아이브로는 사실상 전부 한글이므로 유틸 자체를 한글 안전값으로 낮췄다.

| 유틸 | 값 | 용도 |
|---|---|---|
| `.eyebrow` | 11px / 700 / `letter-spacing .08em` / uppercase / `fg-dim` | 섹션 도입 라벨 |
| `.label-ko` | 11.5px / 700 / `letter-spacing .01em` / `fg-dim` | 블록 **내부** 필드 라벨. 아이브로보다 조용하다 |

대략적 크기 스케일(px): 디스플레이 30–34 · 판결 숫자 56 · H2 24 · 헤드라인 23 · H3 16–17 · 본문 12.5–15 · 캡션 11–12.

---

## 3. 프리미티브 (`components/case-ui.tsx`)

| 컴포넌트 | 설명 |
|---|---|
| `TopBar` | 스티키 상단바(브랜드 마크 + 워드마크 + `right` 슬롯). 화면 공통 헤더 |
| `BrandMark` / `Wordmark` | 조준경(reticle) SVG 글리프 / 로고 락업 |
| `Eyebrow` | 크림슨 틱 + 라벨. 섹션 도입부 |
| `Panel` | **Tier 1.** hairline 테두리만. 조작 가능한 면 |
| `CaseCard` | **Tier 2.** 코너 브래킷 카드. `bracket`(브래킷 색) |
| `RiskTag` | 등급 표시. 45° 회전 정사각 + 텍스트. **박스 없음** |
| `GradeRail` | 행 왼쪽 끝 2px 세로 레일. 등급 색. 스크롤 스캔의 주 신호 |
| `RecentMutualBadge` | `◆ 가장 최근 맞팔한 여자 N번째`. 다이아몬드 + 앰버 텍스트 |
| `DeepRiskAnalysis` | 고위험 총평. 넘버링 없이 줄 간격으로만 분리 |
| `ThreatBar` | 위협 게이지. 2px 연속 트랙(아래 참고) |
| `InstaButton` | `프로필 열기` 라벨 고스트 버튼. `emphasis="high"`면 크림슨 |
| `ProfileFallback` | 프로필 이미지 부재 시 실루엣 플레이스홀더 |
| `SuspectAvatar` | 원형 아바타(랜딩 데모용) |
| `Stamp` | 회전 스탬프 라벨(예: "위장여사친 감지") |
| `Redaction` | 검열 바(단색) |
| `PrimaryButton` / `primaryCls` | 크림슨 CTA. `size="md" \| "lg"` |
| `ghostCls` | 보더형 보조 액션 클래스 |

### 합성 컴포넌트

| 파일 | 설명 |
|---|---|
| `components/suspect-row.tsx` | 계정 행. 결과·공유 페이지 공용. 고위험은 Tier 2로 승격, 그 외는 `GradeRail` |
| `components/result-actions.tsx` | 결과 공유 오버플로 메뉴(카카오/DM/링크 복사) |
| `components/result-feedback.tsx` | `결과가 정확하지 않나요?` 접힘식 피드백 폼 |
| `components/landing-overture.tsx` | 랜딩 첫 진입 오버추어. 세션당 1회 |
| `components/landing-signature-card.tsx` | 랜딩 히어로 데모(Tier 2) |
| `components/landing-reviews.tsx` | 후기 가로 스트립. 자동 흐름 |

인증: `components/auth-buttons.tsx`(카카오/구글, `redirectTo`), `components/login-modal.tsx`(오버레이 로그인).

### `ThreatBar` — 표현은 바뀌어도 계산은 고정

게이지는 2px 연속 트랙이지만 채움은 여전히 `threatMeterFillCount`(10칸)가 결정한다. 표시 점수 `roundedOwnerScore`와 **절대 어긋나지 않도록** 묶여 있고 `owner-view-presentation.test.ts`가 이를 검증한다. 소수점 표기(`3.0/10`)는 이 불변식을 깨므로 쓰지 않는다.

| `fill` | 동작 |
|---|---|
| `static`(기본) | 최종 폭으로 렌더 |
| `pending` | 0으로 대기 |
| `run` | 0에서 최종 폭까지 애니메이션 |

`pending`이 없으면 최종 폭이 한 프레임 보였다가 0으로 튄다.

---

## 4. 모션

`app/globals.css` 키프레임 유틸. CSS는 `prefers-reduced-motion`에서 전역 비활성.

### 앰비언트

| 클래스 | 용도 |
|---|---|
| `.anim-scan` | 시그니처 카드 스캔 라인 |
| `.anim-blink` | LIVE/진행 중 점멸 |
| `.anim-radar` | 진행 화면 레이더 스윕 |
| `.anim-marquee` | 신뢰 스트립 흐름 |
| `.anim-stamp` | 스탬프 등장 |
| `.anim-indeterminate` | 미확정 진행 바 |

### 리빌 (`--ease-settle`)

빠르게 출발해 천천히 안착하는 easeOutExpo. 제품 전체가 하나의 모션 액센트로 정착하도록 이 커브만 쓴다.

| 클래스 | 용도 |
|---|---|
| `.reveal` | 8px 상승 + 페이드 |
| `.reveal-rail` | 세로 레일 그리기(`scaleY`) |
| `.reveal-wipe` | 가로 와이프(`scaleX`) |
| `.reveal-sweep` | 크림슨 스캔 라인 1회 통과 |
| `.meter-fill` | 게이지 충전(`--meter-width` 지정 필요) |
| `.overture-line` / `.overture-out` / `.overture-page-in` | 랜딩 오버추어 |

### 모션이 위계를 가르친다

전부 동시에 페이드하면 장식이다. **읽는 순서대로 공개**해야 모션이 정보 구조를 가르친다. 결과 헤더 시퀀스:

| 지연 | 요소 |
|---|---|
| 0ms | 스캔 라인 통과 |
| 80ms | 프로필 락업 |
| 300ms | 크림슨 레일 + 판결 숫자 카운트업 |
| 700 / 780ms | 등급 라벨, 맥락 문장 |
| 900 / 1120ms | 분포 바 와이프, 범례 |

### JS 모션은 reduced-motion을 스스로 확인해야 한다

CSS의 `prefers-reduced-motion` 블록은 JS로 구동되는 값에 닿지 않는다. `hooks/useCountUp.ts`, 오버추어, 후기 자동 흐름은 각자 `matchMedia`로 확인한다.

### 트리거는 실제로 보이는 시점에

`IntersectionObserver`를 그냥 걸면 키 큰 화면에서 **페이지 로드 시점에 발화**한다(시그니처 카드는 스크롤 0에서 이미 54% 보였다). `rootMargin: '0px 0px -35% 0px'`로 관측 영역을 뷰포트 상단 65%로 좁힌다.

### 오버추어

랜딩 첫 진입 시 헤드라인만 한 화면을 채웠다가 물러난다. 총 약 2.6초.

- `sessionStorage`로 **세션당 1회**. 재방문마다 2.6초를 기다리게 하면 드라마가 아니라 장애물이다
- `prefers-reduced-motion`이면 아예 마운트하지 않는다
- **애니메이션 루트의 형제로 렌더한다.** 조상에 `transform`이 있으면 `position: fixed`의 기준이 뷰포트가 아니라 그 조상이 된다

### 후기 자동 흐름

초당 22px로 가로 이동. 읽는 사람이 잡고 있는 동안만 비켜선다.

- 누르고 있는 동안 정지(`pointerdown`/`touchstart`), 떼면 재개
- 사용자 스크롤이 잦아들 때까지 260ms 대기. 관성 중에 `scrollLeft`를 쓰면 플링이 끊긴다
- **`scroll-snap`과 양립하지 않는다.** 스냅이 걸린 채 조금씩 밀면 매번 되snap 해서 떨림이 된다

---

## 5. 레이아웃 컨벤션

- 콘텐츠 폭: 랜딩/일반 `max-w-[460px]`, 리포트 `max-w-[480px]`, 텍스트 문서 `max-w-[640px]`. 모두 `mx-auto px-5`
- 배경 질감: `body::before`에 상단 크림슨 글로우 + 스캔라인 + 미세 그리드(고정, `z-index:-1`)
- 포커스 링: `:focus-visible` → 크림슨 2px
- 화면 셸: 각 페이지 루트 `min-h-dvh` + `TopBar`

### Tier가 섞인 목록은 콘텐츠 가장자리를 맞춘다

Tier 2 카드가 Tier 0 행 사이에 끼면 좌우 끝이 어긋나 보인다. 양쪽 다 컨테이너에서 16px 안쪽에 놓는다.

- Tier 2: `1px 테두리 + 15px 패딩`
- Tier 0: `2px 레일 + 14px 갭 + pr-4`

### 균등 간격이 위계를 지운다

같은 간격으로 늘어놓으면 전부 같은 등급으로 읽힌다. 묶일 것은 붙이고 분리할 것은 벌린다.

- 게이지와 점수는 한 덩어리(`gap-2.5`), 그 다음 버튼은 `gap-4`
- `Instagram에서 찾기`는 입력창의 각주다. 입력창까지 9px, CTA까지 23px

---

## 6. 사용 예시

```tsx
import { Eyebrow, GradeRail, RiskTag, ThreatBar, InstaButton } from '@/components/case-ui';

// Tier 0 계정 행 — 박스 없음, 등급은 레일이 말한다
<section className="mx-auto max-w-[480px] px-5">
  <Eyebrow>위협 등급 순위</Eyebrow>
  <div className="mt-5">
    <div className="flex gap-3.5 border-b border-line py-4 pr-4">
      <GradeRail grade="caution" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="num text-[11px] text-fg-mute">02</span>
          <span className="truncate text-[15px] font-bold">@account</span>
          <RiskTag grade="caution" className="ml-auto" />
        </div>
        <div className="mt-1 flex items-center gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <ThreatBar grade="caution" score={6} className="flex-1" />
            <span className="num text-[16px] font-extrabold text-amber">
              6<span className="text-[11px] text-fg-dim">/10</span>
            </span>
          </div>
          <InstaButton url="https://instagram.com/account" />
        </div>
      </div>
    </div>
  </div>
</section>
```

---

## 7. 공유 카드

카카오는 **페이지의 OG 태그를 읽지 않는다.** 피드 템플릿의 `content.imageUrl`만 쓴다.

- 결과별 카드: `app/api/share/[token]/opengraph-image` (800×400, 타깃 프로필 + 실명)
- 링크와 썸네일 모두 카카오 개발자콘솔에 등록된 도메인이어야 한다(`yeosachin.com`). localhost는 거부된다
- 카카오는 이미지를 서버에서 캐싱한다. 결과마다 URL이 달라야 섞이지 않는다

### 사용자 제스처를 잃지 말 것

카카오 공유와 인스타 앱 스킴은 **탭을 처리한 그 태스크 안에서** 호출해야 한다. 네트워크 대기를 끼우면 Safari가 팝업/스킴 이동을 막는다. 느린 작업(공유 토큰 발급, SDK 로드)은 **메뉴가 열릴 때** 미리 끝내고, 탭 시점에는 `shareToKakaoNow()` 같은 동기 경로를 쓴다.

---

## 8. 다시 칠할 때(리스킨)

모든 액센트가 `--color-blood` / `--glow-rgb`를 참조하므로, 상위 요소에 스코프를 잡고 이 변수만 오버라이드하면 전체가 리스킨된다. 등급색(amber/jade)까지 함께 조정하면 완전히 다른 무드가 된다.

단, **크림슨 = 위험**이라는 의미 결합은 색을 바꿔도 남는다. 새 액센트가 위험을 뜻하기에 부적절하면 등급 스케일을 액센트에서 분리해야 한다.
