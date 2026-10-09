# 분석 중 화면 1안 구현 계획

**목표:** 사용자가 선택한 큰 원형 진행률 1안과 공통 오류·가독성 개선을 구현하고 Dev 검증 후 PR로 main에 반영한다.

**승인:** 2026-10-09 사용자가 공통 요구를 포함한 선택 질문에 `1`로 답했다. 이어 수집 계정 이미지의 기존 슬라이딩을 유지하는 방향을 명시했다. 따라서 생성 시안의 단일 사진 부분은 기존 `ProgressFaces` 슬라이딩으로 대체한다. 결과 페이지는 유지한다.

**구조:** 기존 진행 페이지·hook·표현 helper만 변경한다. 진행 계산, API/DTO, 실행·결제·provider·DB는 유지한다. 조회 오류는 확정 미존재/접근 불가와 일시 장애를 구분하며 다시 조회는 기존 GET refetch만 실행한다.

**모바일 검수 승인:** Aside가 실제 viewport 변경을 지원하지 않아 사용자가 별도 격리 Playwright 검증을 승인했다. 실제 Dev 데스크톱은 Aside로, 390×844 모바일·좁은 화면·통제된 오류는 동일 실제 컴포넌트와 합성 응답의 격리 렌더링으로 확인한다. 기존 로그인 쿠키는 이동하지 않는다. 이는 모바일 Dev 인증·서버 E2E 또는 실물 기기 검증과 구분한다.

**기술:** Next.js App Router, React, Tailwind, Vitest/Testing Library, Aside, 기존 Dev Vercel 프로젝트.

## 소유권과 순서

- Root: 이 계획·승인 명세·상태판·검증 보고서, Git/PR/배포, 실제 Aside 검수. canonical main과 보존 파일 관리.
- 구현 agent: `app/progress/[requestId]/page.tsx`, `hooks/useAnalysisProgress.ts`, `lib/services/analysis/owner-view-presentation.ts`와 직접 관련 기존 검사. `ProgressFaces`의 기존 이미지 안전성·슬라이딩·reduced-motion은 유지하고 필요 없는 공유 파일 변경은 피한다.
- 독립 명세 reviewer: 승인 범위·행동·제약을 읽기 전용 검토. 구현자와 다르다.
- 독립 품질 reviewer: 명세 검토 후 race·오류·접근성·회귀를 읽기 전용 검토. Root가 수정 결과를 통합한다.

## 1. 진행 표현과 오류 구현

- [x] 전체 진행률 이름/현재값/0~100 범위를 제공하고 기존 계산을 유지한다.
- [x] 큰 원형, 의미 있는 h1, 기존 슬라이딩, 본문 14~16px, 세 작업의 완료/진행 중/대기를 적용한다. 병렬 작업과 Dev 배너는 유지한다.
- [x] 현재 순번과 대상 개수가 모두 있을 때만 `현재 n번째 / 대상 N개`를 표시한다. track n/100이나 중복 %는 제거한다.
- [x] Dev는 설정된 약 45초 합성 안내, Production은 변동 가능한 처리 시간 안내를 사용한다. 실측 ETA를 만들지 않는다.
- [x] backgroundProcessing 조건을 보존하고 지원되는 경우 /mypage 보관함 CTA를 제공한다.
- [x] 종료 실패/확정404는 새 분석 시작하기, 일시 조회 장애는 다시 조회를 제공한다. 기존 snapshot은 일시 장애 동안 유지하며 장애 안내를 숨기지 않는다.
- [x] 조회 중 중복 버튼 입력·요청 전환·낮은 revision·복구·권한 오류를 고려하고 원시 오류를 표시하지 않는다.

## 2. 관련 검사와 독립 검토

- [x] 기존 owner-view-presentation, v2-progress-display, request-contract, ProgressFaces, useAnalysisProgress 및 Dev client-flow 검사를 우선 재사용한다.
- [x] 의미 있는 회귀: 초기/중간503·네트워크 오류→GET 재조회→복구, 확정404, 요청 전환, Dev/Production 시간, 순번 의미와 CTA. 새 분석/provider 호출이 없는지 확인한다.
- [x] 변경 파일 eslint와 `npx tsc --noEmit --pretty false`를 수행한다.
- [x] 독립 명세 리뷰 후 품질 리뷰를 받고 P1/P2를 해결한다. 각 agent는 변경 파일·검사·blocker를 보고한다.

## 3. Dev 실제 검수와 승격

- [x] clean 후보 commit으로 PR을 생성한다. 기존 승인된 tracked-only 임시 archive·Dev vercel.json overlay 절차로 정확한 Dev 프로젝트에 배포한다.
- [x] native READY·후보 identity·cron 비활성/정의0과 source/effective runtime fingerprint를 기록한다.
- [x] Aside 실제 Dev 데스크톱 및 승인된 격리 Playwright의 측정한 모바일 viewport로 초기/중간/병렬/마지막·슬라이딩·재방문·보관함·완료 자동 이동·실패·미존재·키보드 CTA를 확인한다.
- [x] 503/네트워크 주입은 통제된 검사 증거와 실제 브라우저 증거를 구분한다. 전체 접근성·실제 AI/provider 품질·실제 소요시간을 주장하지 않는다.
- [x] 선택 시안과 실제 캡처를 동일 입력에서 비교하고 `design-qa.md`에 크기·밀도·의도된 슬라이딩 차이·판정·남은 한계를 남긴다.
- [ ] 최종 문서 포함 exact-head PR 검사 후 PR 병합, root main fast-forward, main/origin/main 일치와 Production native 배포를 확인한다. 이 체크박스는 문서 commit 시점의 관찰이며 영구 blocker가 아니다. 실제 완료는 [PR #605](https://github.com/0mininseoul/yeosachin-scanner/pull/605)와 Root 종료 검증에서 확인한다.

## 유지하는 경계

Apify·AI·실제 카드 과금은 실행하지 않는다. 결과·랜딩 카피·DB·migration·Production 운영 설정은 바꾸지 않는다. 비밀·사용자 식별자·원시 행을 기록하지 않는다. 보존 경로와 과거 브랜치/stash를 유지한다. 실물 기기·스크린리더·실제 장기 지연·사용자 계정 분석은 합성 UI 검수와 별개다.

## 검증 결과

[구현·검증 보고서](../../operations/2026-10-09-progress-implementation.ko.md)에 코드309e1813·140검사·독립 명세/품질·새 Dev native READY·Aside 실제 흐름·승인된 격리 모바일·오류 주입의 증거와 한계를 기록했다.
