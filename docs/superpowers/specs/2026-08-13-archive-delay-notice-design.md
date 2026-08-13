# 유료 사용자 보관함 지연 안내 팝업 — 설계안 (승인 대기)

작성일: 2026-08-13
상태: **DESIGN ONLY · 승인 게이트.** 프로덕션 배선 없음. 커밋/PR/푸시/배포 없음.

---

## 1. 요구사항

권위 있는 `is_paid_user`가 TRUE인 사용자가 보관함(`/mypage`)에 들어오면, 이용량 급증으로 분석 전달이
지연되고 있으며 **최대 2일 이내**에 결과를 제공한다는 사려 깊은 안내 팝업을 띄운다.
관리자·미결제 사용자의 동작도 명시적으로 정의한다.

---

## 2. 현행 코드 조사 결과

### 2.1 보관함 화면
- `app/mypage/page.tsx` — 서버 컴포넌트. 인증 → `requireActiveAccountSession(user)` →
  `load_analysis_owner_history_v1` RPC → `listAwaitingEarlybirdDeliveries(user.id)` →
  `buildArchiveEntries(...)` → `<AnalysisList>`.
- `app/mypage/analysis-list.tsx` — 행(row) 기반 목록. 상태는 좌측 2px 레일 색으로 표현
  (앰버=대기/진행, 제이드=완료). `awaiting_delivery` 엔트리는 "결과 대기 중"으로 표시.
- 컨테이너 폭 `max-w-[480px]` — 모바일 우선.

### 2.2 `is_paid_user`의 권위 소스
- 스키마: `lib/services/identity/account-principal-store.ts`의 `accountPrincipalRowSchema`가
  `is_paid_user: z.boolean()`을 포함. 접근자는 **`loadAccountPrincipal(userId)`**
  (service-role RPC, `supabaseAdmin`).
- **주의:** 보관함이 이미 호출하는 `requireActiveAccountSession()`은 분류값
  (`accountClass` / `trafficClass` / `lifecycle` / `classificationVersion`)만 반환하며
  **`is_paid_user`를 포함하지 않는다.** 따라서 서버 컴포넌트에 `loadAccountPrincipal` 호출 1건이 추가된다.
- `/api/user/me`는 브라우저 세션 부트스트랩 경로. 팝업 게이팅에 쓰지 않는다
  (클라이언트 왕복 → 깜빡임, 그리고 신뢰 경계를 클라이언트로 내리는 문제).

### 2.3 관리자/내부 트래픽 판별
- `trafficClass`: `external` | `operator` | `e2e_test` | `internal_tester`
- `accountClass`: `production` | `e2e_test`
- **기존 선례:** `app/mypage/page.tsx`는 계정 삭제 패널을
  `accountClass === 'production' && trafficClass === 'external'`일 때만 노출한다.

### 2.4 모달 프리미티브
- `components/profile-preview-dialog.tsx` — 포커스 트랩, Escape, 포커스 복원,
  `role="dialog"` / `aria-modal` / `aria-labelledby`. **스크롤 잠금 없음.**
- `components/login-modal.tsx` — Escape, **body 스크롤 잠금**, 스크림 클릭 닫기, 닫기 X 버튼.
- 공통 프리미티브는 없다. 두 파일의 **합집합**이 이 팝업이 필요로 하는 동작이다.

### 2.5 디자인 시스템
`app/globals.css` — "CASE FILE" 다크 포렌식 도시에, 단일 크림슨 액센트, Paperlogy.
- 배경 `ink #0c0a0b` / `ink-2 #121010` / `panel #17120f`, 라인 `line #2a2220` / `line-2 #3b302c`
- 액센트 `blood #e4132a`, 분류 스케일 `amber #e0a32e`(대기) / `jade #46a08a`(완료)
- 텍스트 `fg #f3efea` / `fg-dim #8c827b` / `fg-mute #5f564f`
- 모서리 라운딩 없음. 포커스 링 `2px solid blood`. 이징 `--ease-settle`(easeOutExpo).

`components/case-ui.tsx`의 **컨테이너 3단계 원칙**:
| Tier | 컴포넌트 | 용법 |
|---|---|---|
| 0 | 없음 | 여백 + 헤어라인 하나 |
| 1 | `Panel` | 헤어라인 보더 — 조작 가능한 면 |
| 2 | `CaseCard` | 보더 + 코너 브래킷 — "화면의 판결", 화면당 1회 |

> 코너 브래킷은 브랜드에서 가장 강한 장치다. 드물게 쓰일 때만 신호로 읽힌다.

### 2.6 애널리틱스
`lib/services/analytics.ts`의 `trackEvent()`는 **닫힌 레지스트리**다:
`APPROVED_EVENTS.has(eventName)` 통과 + `validateProperties(eventName, properties)`의
이벤트별 스키마 검증을 모두 통과해야 전송된다. 새 이벤트는 등록이 필요하다.

### 2.7 기존 지연 문구 선례
`app/earlybird/earlybird-status.tsx`:
> 판독 결과가 완성되면 2일 이내에 가입하신 이메일로 결과 링크를 보내드릴게요.

**이 문장과 모순되지 않아야 한다.** 팝업 ETA 문구는 이 구문을 그대로 재사용한다.

---

## 3. 노출 규칙 (관리자·미결제 포함)

```
노출 = accountClass === 'production'
     && trafficClass  === 'external'
     && principal.is_paid_user === true
     && 보관함에 미전달 건 존재 (awaiting_delivery | status ∈ {pending, processing})
```

| 대상 | 동작 | 근거 |
|---|---|---|
| 유료 + 미전달 건 있음 | **노출** | 지연 사과의 실제 대상 |
| 미결제 사용자 | 노출 안 함 | 지연은 결제 건에 대한 약속. 무관한 불안만 유발 |
| 운영자 (`operator`) | 노출 안 함 | 보관함 실제 상태를 그대로 봐야 함 |
| 내부 테스터 (`internal_tester`) | 노출 안 함 | 동일 |
| E2E (`e2e_test`) | 노출 안 함 | 테스트 트래픽이 지표·스냅샷을 오염시키지 않도록 |
| 유료 + 미전달 건 없음 | 노출 안 함 | 이미 다 받은 사람에게 사과하면 혼란만 준다 |

`accountClass === 'production' && trafficClass === 'external'`는 계정 삭제 패널이 이미 쓰는
조건이다. 같은 선례를 따르면 관리자·테스트 트래픽이 자동 제외되고, 판별 규칙이 화면 안에서 하나로 유지된다.

---

## 4. 카피 (권장안)

| 슬롯 | 문구 |
|---|---|
| Eyebrow | 판독 지연 안내 |
| 원인 | 최근 이용자가 크게 늘면서 판독 대기열이 길어졌습니다. |
| 안심 | 결제하신 판독은 정상적으로 접수되어 순서대로 진행 중이에요. |
| ETA | 늦어도 2일 이내에 가입하신 이메일로 결과 링크를 보내드릴게요. |
| 사과 | 기다리게 해서 죄송합니다. |
| CTA | 확인했어요 |

헤드라인은 시안별로 다르다: A "결과 전달이 조금 늦어지고 있어요" / B "판독 대기열이 길어졌습니다" /
C "조금만 더 기다려 주세요".

카피 원칙: ① 설명보다 인정을 먼저 ② 변명이 아닌 원인 ③ 결제 건은 안전하다고 명시
④ 기다림에 구체적 상한 ⑤ 사과는 한 번, 담백하게 (이모지 없음).

---

## 5. 시안 3종

| | 컨테이너 | 정보 밀도 | 제시 방식 | 성격 |
|---|---|---|---|---|
| **A · 차분한 안내** | Tier 1 `Panel` | 최소 | 중앙 모달 | 가장 보수적. 앰버 헤어라인 1개가 유일한 액센트 |
| **B · 케이스 브리핑** | Tier 2 `CaseCard` | 최대 (3단계 타임라인) | 중앙 모달 | 브랜드 최강 장치 사용. 내 주문 위치를 보여줌 |
| **C · 바텀시트 하이브리드** | Tier 1 | 중간 | 모바일 시트 / ≥640px 모달 | 모바일 네이티브. "다시 보지 않기" 보유 |

**트레이드오프:** B는 `case-ui.tsx`가 "화면당 1회"로 아껴둔 Tier 2를 쓴다. 최초 1회성 서비스
사과가 그 자격이 되는지가 이 시안의 판단 지점이다. C는 유일하게 영구 해제 수단을 준다.

스크린샷: `docs/superpowers/specs/assets/2026-08-13-archive-delay-notice/`

---

## 6. 접근성

세 시안 공통 (`app/dev/delay-popup-samples/dialog-a11y.ts`):
- `role="dialog"` + `aria-modal="true"` + `aria-labelledby`(h2) + `aria-describedby`(본문)
- 포커스 트랩 (Tab / Shift+Tab 순환), 열릴 때 CTA에 초기 포커스, 닫을 때 이전 요소로 복원
- Escape 닫기, body 스크롤 잠금 및 복원, 스크림 클릭 닫기
- `prefers-reduced-motion: reduce`에서 진입 애니메이션 제거

검증 완료: Escape로 닫힘 → `[role=dialog]` 제거 + `body.style.overflow` 복원 확인.
`aria-labelledby` → h2 텍스트 해석 확인.

---

## 7. 구현 시 필요한 작업 (미착수)

1. **서버 게이팅** — `app/mypage/page.tsx`에 `loadAccountPrincipal(user.id)` 호출 추가,
   위 4개 조건 계산 후 클라이언트 컴포넌트에 boolean 하나만 전달.
2. **애널리틱스 등록** — `APPROVED_EVENTS` + 속성 스키마에 추가 필요.
   제안: `archive_delay_notice_shown`, `archive_delay_notice_dismissed`.
3. **재노출 억제** — `localStorage` 기반 (아래 미결정 사항 2번 확정 후).
4. **종료 스위치** — 대기열 정상화 시 배포 없이 끌 수 있는 플래그.
5. **PII** — 팝업에 대상 핸들·이메일·주문번호를 넣지 않으므로 `data-amp-mask` 불필요.

---

## 8. 승인 시 확정할 미결정 사항

1. **미전달 건이 없어도 띄울지** — 권장: 아니오. (§3에 반영됨)
2. **재노출 주기** — 권장: 24시간 1회. 매 방문은 피로하고, 영구 1회는 지연이 길어질 때 안내가 사라진다.
   C안의 "다시 보지 않기"는 영구 해제.
3. **종료 스위치 형태** — 권장: 환경변수/플래그 1개로 전체 OFF.

---

## 9. 승인 결과 및 최종 산출물

2026-08-13 사용자 승인: **시안 C(바텀시트 하이브리드)**, 미결정 사항 1·2·3 모두 권장안대로 확정.

승인 게이트용 샘플 라우트(`app/dev/delay-popup-samples/`)는 목적을 다했고 프로덕션 카피와
중복되어 드리프트 위험이 있으므로 구현과 함께 제거했다. 시각 기록은 §5의 스크린샷으로 남는다.

```
lib/services/analysis/archive-delay-notice.ts       # 노출 규칙 + 재노출 억제 (순수 로직)
lib/services/analysis/archive-delay-notice.test.ts  # 15 tests
components/archive-delay-notice.tsx                 # 시안 C 팝업
components/archive-delay-notice.test.tsx            # 7 tests
app/mypage/page.tsx                                 # 서버 게이팅 (loadAccountPrincipal 추가)
app/globals.css                                     # sheet-rise 키프레임 + .anim-sheet-rise
lib/services/analytics.ts                           # ARCHIVE_NOTICE_EVENTS 등록
.env.example                                        # ARCHIVE_DELAY_NOTICE_ENABLED
```

전역 `prefers-reduced-motion: reduce` 규칙이 이미 모든 애니메이션을 무력화하므로 별도 처리는 없다.
