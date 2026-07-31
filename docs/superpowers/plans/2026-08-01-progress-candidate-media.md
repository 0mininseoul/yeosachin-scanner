# 진행 화면 후보 미디어 묶음 — 구현 계획

> 설계: `docs/superpowers/specs/2026-08-01-progress-candidate-media-design.md`
>
> 모든 동작은 RED 테스트를 먼저 확인하고 최소 구현으로 GREEN을 만든다. 추가 provider 호출,
> 워커 이미지 다운로드, heartbeat 호출 증가, 랜딩 카피 변경은 금지한다. 프로덕션 migration과
> 배포는 별도 승인 전까지 실행하지 않는다.

## Task 1 — 순수 후보 미디어 선택과 실행기 전달

### RED

`lib/services/analysis/progress-candidate-media.test.ts`를 추가한다.

- 체크포인트의 프로필 사진을 그대로 선택한다.
- 최신 게시물의 서로 다른 display image를 최대 3개만 선택한다.
- video/reel은 raw video URL 대신 thumbnail/display image를 선택한다.
- 프로필 사진과 같은 URL, 중복 게시물 URL, 잘못된 URL은 제외한다.
- 이미지가 없어도 빈 preview를 반환하며 예외를 던지지 않는다.

`lib/services/analysis/v2-ai-scoring-executors.test.ts`에 다음 회귀를 추가한다.

- `profile_ai`가 이미 로드한 profile을 preview callback에 전달한다.
- provider 호출 횟수와 candidate heartbeat 호출 횟수는 기존과 동일하다.
- preview 생성 실패는 후보 분석을 중단하지 않는다.

### GREEN

- `lib/services/analysis/progress-candidate-media.ts`에 bounded pure selector를 구현한다.
- `AnalysisV2StageExecutorContext.reportActiveProfile`이 optional preview를 받게 한다.
- `profile_ai`만 profile checkpoint에서 preview를 넘긴다.
- `profile_fetch`의 기존 username-only callback은 변경하지 않는다.

### 검증

```bash
npx vitest run lib/services/analysis/progress-candidate-media.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-worker.test.ts
```

## Task 2 — 진행 계약·reporter·store 확장

### RED

다음 기존 테스트를 먼저 확장한다.

- `lib/contracts/analysis-v2.test.ts`
- `lib/services/analysis/v2-progress-reporter.test.ts`
- `lib/services/analysis/v2-progress-store.test.ts`
- `lib/services/analysis/v2-progress-route.test.ts`
- `lib/services/analysis/use-analysis-progress-request-contract.test.ts`

검증 항목:

- 기존 `{ maskedUsername, imageUrl }` 응답을 계속 허용한다.
- optional `feedImageUrls`는 최대 3개, unique, bounded proxy path만 허용한다.
- reporter는 raw URL을 opaque proxy path로 바꾸고 payload에 남기지 않는다.
- preview 선택 또는 signing 실패 시 username heartbeat를 media 없이 기록한다.
- 새 필드가 없을 때 기존 route/client 응답이 변하지 않는다.
- heartbeat RPC 호출 횟수는 후보당 기존 1회다.

### GREEN

- `ProgressSnapshotV1.activeProfile`에 optional `feedImageUrls`를 추가한다.
- heartbeat input/store 타입과 RPC payload에 feed image array를 추가한다.
- reporter가 optional preview를 안전하게 proxy-sign하고 최대 3개로 제한한다.
- preview-only 오류를 삼키고 기존 username heartbeat는 유지한다.

### 검증

```bash
npx vitest run lib/contracts/analysis-v2.test.ts \
  lib/services/analysis/v2-progress-reporter.test.ts \
  lib/services/analysis/v2-progress-store.test.ts \
  lib/services/analysis/v2-progress-route.test.ts \
  lib/services/analysis/use-analysis-progress-request-contract.test.ts
```

## Task 3 — additive heartbeat migration

### RED

다음 테스트를 추가한다.

- `lib/services/analysis/v2-progress-candidate-media-migration-contract.test.ts`
- `lib/services/analysis/v2-progress-candidate-media-pglite.test.ts`

검증 항목:

- 기존 heartbeat 테이블에 bounded `TEXT[]` 한 칼럼만 추가한다.
- 배열은 최대 3개이며 각 값은 `/api/image-proxy?`로 시작한다.
- 기존 RPC 이름을 유지하고 새 parameter는 default를 가져 구버전 호출이 유효하다.
- 같은 이름의 overload를 남기지 않는다.
- request/job/input hash/claim token/live lease/topology fence가 유지된다.
- owner가 아닌 사용자는 progress media를 읽지 못한다.
- terminal transition은 heartbeat와 media를 함께 제거한다.
- retry/update는 idempotent하고 raw provider URL을 저장하지 않는다.

### GREEN

`supabase/migrations/20260801010000_add_progress_candidate_media.sql`을 추가한다.

- `analysis_v2_active_profile_heartbeats.feed_image_urls` 추가.
- bounded array constraint 추가.
- 기존 heartbeat RPC를 defaulted array parameter가 있는 단일 signature로 교체.
- owner load RPC가 live heartbeat에만 optional `feedImageUrls`를 projection.
- 기존 RLS, revoke/grant, terminal purge를 유지.

프로덕션에는 적용하지 않는다.

### 검증

```bash
npx vitest run \
  lib/services/analysis/v2-progress-candidate-media-migration-contract.test.ts \
  lib/services/analysis/v2-progress-candidate-media-pglite.test.ts
```

## Task 4 — 후보별 브라우저 묶음 렌더링

### RED

`lib/services/analysis/progress-faces.test.ts`와 component contract test를 확장한다.

- 후보 하나가 profile + 0~3 feed image로 한 묶음이 된다.
- adjacent 동일 masked username heartbeat는 중복 append되지 않는다.
- 후보 이력은 최대 20개다.
- profile이 없고 feed만 있어도 묶음을 표시한다.
- 실패한 이미지는 기존 fallback으로 대체된다.
- 이미지에 lazy loading이 적용되고 raw 외부 URL은 렌더링되지 않는다.

### GREEN

- client accumulation 모델을 bounded candidate media bundle로 확장한다.
- `components/progress-faces.tsx`의 drift rail을 유지하면서 각 후보를
  `[profile][feed 1][feed 2][feed 3]` 순서로 렌더링한다.
- 새 애니메이션, 새 카피, 새 네트워크 선행 로딩은 추가하지 않는다.

### 검증

```bash
npx vitest run lib/services/analysis/progress-faces.test.ts \
  lib/services/media/proxy-image-rendering.test.ts
npx eslint components/progress-faces.tsx \
  lib/services/analysis/progress-faces.ts \
  lib/services/analysis/progress-faces.test.ts
```

## Task 5 — 전체 회귀와 독립 리뷰

```bash
npx vitest run \
  lib/services/analysis/progress-candidate-media.test.ts \
  lib/services/analysis/v2-progress-candidate-media-migration-contract.test.ts \
  lib/services/analysis/v2-progress-candidate-media-pglite.test.ts \
  lib/services/analysis/v2-progress-reporter.test.ts \
  lib/services/analysis/v2-progress-store.test.ts \
  lib/services/analysis/v2-progress-route.test.ts \
  lib/services/analysis/v2-ai-scoring-executors.test.ts \
  lib/services/analysis/v2-worker.test.ts \
  lib/services/analysis/progress-faces.test.ts \
  lib/contracts/analysis-v2.test.ts
npm run lint
npx tsc --noEmit
git diff --check
```

별도 에이전트가 다음을 독립 검토한다.

- 설계와 구현의 정확한 일치;
- provider/heartbeat 호출 수 증가 여부;
- media failure가 analysis failure로 승격되는 경로;
- raw URL/username 노출 및 owner isolation;
- migration 구버전 RPC 호환성과 terminal purge;
- 불필요한 table/R2/feature flag/추가 관측 도입 여부.

리뷰와 CI를 통과한 PR까지만 준비한다. merge, migration apply, Cloud Run/Vercel
production deployment는 사용자 승인 전까지 보류한다.
