# Launch Pipeline V2 구현 계획

**날짜:** 2026-07-13

**상태:** Phase A-C 계약·보호된 사전 점검·내구성 작업 기반 구현과 검증 완료. Phase D 진행 중

**검토 브랜치:** `agent/launch-correctness-performance`

**목표:** 결제 연동 전, 광고한 플랜 범위의 결과를 5분 이내에 완성해서 반환할 수 있는 정직하고 재개 가능한 자체 프로필 우선 Instagram 분석 파이프라인을 구축한다.

## 1. 최종 결정

기존 파이프라인 옆에 V2를 추가하고 feature flag 뒤에서 새 테스트 요청을 실행한다. V2가 실제 canary를 통과하기 전에는 Apify, RapidAPI, FlashAPI, V1 실행 경로를 삭제하거나 전면 재작성하지 않는다.

V2의 핵심 변경은 네 가지다.

1. 결제나 유료 크롤링 전에 무료 자체 크롤러 대상 계정 사전 점검을 실행한다.
2. 분석을 하나의 순차 상태 머신이 아니라 재개 가능한 Cloud Tasks DAG로 바꾼다.
3. 프로필 크롤링은 username별 성공을 체크포인트로 남기고, 미해결 username만 유료 fallback으로 보낸다.
4. 성별 선별, 특성 분석, 상호작용 근거, 점수 분류, 총평 생성을 명시적 계약을 가진 버전 관리 단계로 분리한다.

## 2. 제품 계약

### 2.1 사용자 흐름

```text
대상 username 입력
  -> 자체 크롤러만 사용하는 대상 사전 점검 즉시 시작
  -> 사전 점검 중 여자친구 username 입력 또는 명시적 건너뛰기
  -> 대상 아바타, username, bio, 팔로워/팔로잉 수 표시
  -> 서버가 이용 가능한 플랜을 강조하고 전체 플랜은 계속 표시
  -> 현재는 테스트 이용권, 향후에는 검증된 결제
  -> 제외 계정 + 플랜 스냅샷 불변화
  -> 첫 Cloud Task 수락
  -> 백그라운드 분석 진행
  -> 페이지네이션 결과
```

대상 사전 점검은 여자친구 입력을 기다리지 않고 먼저 진행한다. 다만 유료/전체 분석은 제외 결정을 받은 뒤 시작하며, 첫 전체 분석 작업부터 여자친구 계정은 후보, 프로필 조회, Gemini 입력, 상호작용 조인, 진행률 근거, 결과에 포함되지 않는다.

### 2.2 플랜 의미

| 플랜 | 팔로워 상한 | 팔로잉 상한 | 상세 맞팔 분석 상한 |
|---|---:|---:|---:|
| Basic | 400 | 400 | 300 |
| Standard | 800 | 800 | 600 |
| Plus | 1,200 | 1,200 | 900 |

- 계정 수용 상한과 출시 상태를 분리한다. 출시 상태는 `production`, `test_only`, `disabled`이며, 세 플랜 모두 E2E·5분·실측 비용 게이트를 통과하기 전까지 `test_only`다. 서명된 서버 측 테스트 이용권만 `test_only`를 실행할 수 있고 운영 사용자는 실행할 수 없다.
- 런타임 설정은 catalog 상태를 더 제한적으로만 바꿀 수 있다. `test_only`를 `production`으로 여는 작업은 검토된 catalog 변경이 필요하므로 환경변수로 실패한 출시 게이트를 우회할 수 없다.
- 계정 수 기준 최소 플랜이 비활성이고 상위 플랜이 활성이라면 실제 필요 플랜을 다음 활성 플랜으로 올린다. 이용 가능한 상위 플랜도 없으면 분석을 차단하되 모든 카드는 제한 사유와 함께 계속 표시한다.
- 팔로워/팔로잉 상한은 가입 허용 상한이다. 선언된 계정 규모가 더 크면 낮은 플랜을 선택할 수 없다.
- 적격 플랜 안에서 두 관계 목록은 선언된 수의 최소 99% 고유 계정을 확보해야 한다. 잘린 목록은 전체 목록이라고 표시하지 않는다.
- 상세 맞팔 상한은 관계 목록 자체의 상한이 아니다. 먼저 전체 맞팔 집합을 계산하고, 그중 공개 계정이 피드 기반 AI 분석에 들어갈 최대 수를 제한한다.
- 상한을 넘으면 `detected`, `screened`, `not screened`를 정확히 기록·표시한다. 일부만 전체 계정이라고 부르지 않는다. 제외 계정과 비공개 분리 후 provider의 최신순을 결정적으로 사용한다.
- 가격은 서버의 버전 관리 데이터로 둔다. 최종 원화 가격과 결제 게이트웨이는 E2E 및 실측 비용 게이트를 통과한 뒤 결정한다.
- 팔로워 또는 팔로잉이 1,200명을 넘으면 결제 전에 차단하고 대기 목록/수동 견적으로 보낸다.

### 2.3 V2 점수 정책

```text
후보 -> 대상 좋아요              20
후보 -> 대상 댓글                26
대상 -> 후보 좋아요               3
태그/캡션 언급                   14
최근 맞팔                        17
외모/노출                        20
총점                            100
```

- 외모 등급은 `0 / 3 / 7 / 10 / 13`이다.
- 노출 신호는 `0..5`다. 외모+노출의 원근거 18점을 비례 변환해 20점 구성요소로 만들고 최대 20점으로 제한한다.
- 후보가 대상 게시물에 누른 좋아요는 `20 * min(고유 좋아요 대상 게시물 수 / 4, 1)`이다.
- 후보가 대상 게시물에 단 댓글은 `26 * min(반영 댓글 수 / 12, 1)`이다. 대상 최근 게시물 6개마다 고유 댓글 최대 2개만 반영한다.
- 대상이 후보에게 누른 좋아요는 후보 최신 게시물의 첫 100명 liker에서 대상을 긍정적으로 확인했을 때만 3점이다. `not_collected`를 관측된 0점으로 처리하지 않는다.
- 대상의 명시적 태그/언급은 최대 14점이며 반복은 상한을 넘지 않는다.
- 검증된 맞팔 여성의 최근순 1~10위 점수는 `17,16,15,14,13,12,10,8,6,4`다.
- 여자친구 제외 및 최종 여성 검증 뒤, 최신 여성 5명에게만 최근 맞팔 배지를 붙인다. 남성/미확인 계정은 순위에 끼지 않는다.
- 확정된 비즈니스 맥락은 `최근 맞팔 + 외모/노출`에만 `0.5`를 적용한다. 좋아요·댓글·태그·언급 점수는 감쇄하지 않는다.
- 파트너 근거는 100점 긍정 근거 합산과 별도로 처리한다. 또래로 보이는 남성과 둘이 찍은 사진 한 장에는 원점수 `-5`를 잠정 적용한다. 연예인·공인 또는 명확한 연상 가족이면 예외다. 반복되고 강한 파트너 근거가 있으면 공개 점수를 3.4로 제한해 정상군에 두되 관측 사실은 내부에 보존한다. 라벨 평가 뒤 값을 바꿀 때는 반드시 새 점수 정책 버전으로 교체한다.
- 원점수는 `direct + businessAdjustedSoftContext + weakPartnerAdjustment`를 `0..100`으로 제한한다. `direct=20+26+3+14`, `softContext=recentMutual+appearanceExposure`다.
- 표시 점수는 `round(1 + 9 * rawScore / 100, 1)`로 1.0~10.0 범위이며 분류에는 반올림 전 값을 쓴다.
- 정상은 `<4.2`, 주의는 `>=4.2 and <6.8`, 고위험은 `>=6.8`이다.
- 고위험/주의군 최소 인원을 강제로 만들지 않는다. 임계값을 넘는 사람이 없으면 별도 `relativeWatch`로만 보여주고 고위험/주의라고 재분류하지 않는다.
- `riskBand`와 `featuredRank`는 분리한다. 고위험 대표는 최대 3명, 주의 대표는 최대 15명이며 전체 행은 절대 점수와 분류를 모두 유지한다.

### 2.4 역방향 좋아요 Top-10 범위

검증된 모든 여성에게 대상→후보 좋아요를 제외한 97점 예비 점수를 먼저 계산한다. 전체 예비 점수 상위 10명을 체크포인트로 고정한 뒤, 그 10명에게만 후보 최신 게시물의 첫 100명 liker를 수집하고 고정된 shortlist 안에서 최종 재정렬한다.

이 목록은 전역 최종 Top-10이 아니라 `verificationShortlist`로 명명한다. 나머지는 `reverseLikeStatus=not_collected`, `possibleUpperBound=preScore+3`을 저장하며, 미수집을 부정 근거로 취급하지 않는다. 3점짜리 양의 보정은 고정 shortlist 내부 순서만 바꿀 수 있다.

### 2.5 Provider 정책

| 기능 | 프로덕션 기본 | 선택 fallback |
|---|---|---|
| 대상 프로필/게시물 | 로그인 없는 자체 크롤러 | Apify 프로필 actor |
| 공개 맞팔 프로필/게시물 | 캐시 후 자체 크롤러 | 미해결 username만 Apify |
| 팔로워/팔로잉 | Apify no-cookie 관계 actor | 운영자가 선택한 외부 provider |
| 대상 게시물 liker/댓글 | Apify interaction actor | 별도 canary 전에는 비활성 |
| 후보 게시물 liker | Apify interaction actor | 별도 canary 전에는 비활성 |

Instagram 로그인 세션이 필요한 자체 팔로워/팔로잉 수집은 비활성으로 둔다. FlashAPI, RapidAPI, CoderX 및 기존 Apify 구현은 canary나 운영자 override용으로 선택 가능하게 남긴다.

## 3. 이미 존재하는 기반

- `lib/services/instagram/scraper.ts`의 기능별 provider 라우팅과 외부 fallback
- `providers/selfhosted`의 로그인 없는 공개 프로필/게시물 수집
- 관계 목록 완전성 검사, provider 실행 체크포인트, 비용 원장, 대사
- 요청한 `4x150`, `6x15`, `1x100` 범위의 대상 liker/댓글 및 후보 liker 수집
- Cloud Tasks 백그라운드 연속 실행과 OIDC 검증
- 멱등 분석 시작, request lease, 실패 정리, 완료 압축, RLS, 정리된 결과 라우트
- Gemini 토큰·지연·모델·예상 비용 telemetry
- 결과 헤더 대상 아바타, 비공개 계정 이름 정렬, 최근 맞팔 배지, 고위험 2줄 총평 저장

이 기반은 전면 교체하지 않고 확장한다.

## 4. 현재 핵심 공백

1. `collect -> profiles -> analyze -> interactions -> deep_analysis -> finalize`가 하나의 lease를 잡은 순차 흐름이다.
2. 대상 상호작용이 여성 집합 확정 뒤에야 시작된다.
3. 공개 프로필마다 성별과 심층 특성을 한 번에 Gemini 호출한다.
4. Gemini 모델과 thinking이 프로세스 전역 설정이다.
5. `InstagramPost`가 이미지 하나만 들고 carousel 자식을 버린다.
6. 자체 batch에서 username별 rejected/null 결과가 조용히 누락되어 정확한 실패 원인이 사라질 수 있고, 일부 성공 뒤에도 전체 배치를 Apify에 재전송할 수 있다.
7. 현재 점수는 합의한 100점제가 아닌 290점 혼합식이다.
8. 위험 등급이 순위 쿼터라 근거가 없어도 고위험이 생긴다.
9. 최근 맞팔 점수가 전체 순서와 결과 시점의 최대 10개 username에 의존한다.
10. 진행률이 5초 폴링 기반 고정 문자열이라 병렬 작업과 정정을 표현하지 못한다.
11. 백그라운드 큐가 없으면 브라우저 실행에 의존해 사용자가 이탈 시 작업을 잃을 수 있다.
12. 플랜·점수·모델·진행률 규칙이 코드와 문서 여러 곳에 중복되어 있다.

이전 `0_min._.00` canary는 자체 크롤러 전체 실패를 보여준 것이 아니다. 영속 provider telemetry에서 대상 프로필 자체 조회 성공과 프로필 batch `30/30`, `30/30`, `15/16`, 이어진 다른 미캐시 batch `17/18`이 확인됐다. 다만 미해결 username의 최종 사유를 저장하지 않아 그 1개 누락을 특정 HTTP, 파싱, 비공개, rate-limit 원인으로 단정할 수는 없다. 같은 실행은 Apify 프로필 fallback을 사용했고, 최초 파이프라인 실패는 Apify dataset shape 불일치였다. V2는 정확한 누락 원인만 미확정으로 두고 username별 최종 telemetry를 저장하며, 고정된 미해결 username 집합만 fallback으로 보낸다.

## 5. 목표 아키텍처

```text
Vercel UI/API
  |
  +-- 사전 점검 API -- 자체 대상 프로필만 -- Supabase preflight
  |
  +-- 이용권/결제 경계
             |
             v
        Cloud Tasks coordinator
             |
     +-------+--------------------+
     |                            |
     v                            v
Track A: 관계/프로필 AI           Track B: 대상 상호작용
팔로워+팔로잉                     대상 4게시물 liker
맞팔+공개/비공개                   대상 6게시물 댓글
프로필 배치                       제한된 원시 interactor 저장
성별 선별
특성 분석
     |                            |
     +------------- join --------+
                   |
             97점 예비 점수
             Top-10 체크포인트
             후보 liker 작업
             최종 100점 점수
             파트너 안전성 검사
             고위험 총평 최대 3건
             트랜잭션 완료
```

초기에는 같은 Next.js 이미지를 private Cloud Run worker로 배포하고 Vercel은 UI로 유지한다. Cloud Tasks가 OIDC로 worker를 호출하므로 서버 소유 실행, 작은 작업당 300초 경계, 자체 크롤러용 동적 GCP egress를 확보할 수 있다. 단, 동적 egress를 요청마다 IP가 반드시 바뀐다고 보장하지 않는다.

## 6. 정본 계약과 SSOT

첫 구현 커밋에서 다음 파일을 정본으로 만든다.

- `lib/domain/analysis/plan-catalog.ts`: `PlanId`, 상한, 가격 버전, 적격성
- `lib/domain/analysis/risk-policy.ts`: 점수 요소, modifier, 임계값, 표시 변환, 정책 버전
- `lib/domain/analysis/media-policy.ts`: 8개 게시물/10개 이미지 선택, carousel 커버리지, 파트너 확인 contact 후보
- `lib/domain/analysis/recent-female-mutual-policy.ts`: 검증된 여성만 소비하는 최신순 점수와 배지
- `lib/domain/analysis/profile-fetch-outcome.ts`: username별 provider 최종 결과와 미해결 집합 계산
- `lib/domain/analysis/progress-policy.ts`: 가중 작업량, 비감소 퍼센트, snapshot revision, 이벤트 sequence
- `lib/domain/analysis/result-pagination.ts`: 공개/비공개 목록의 제한된 결정적 cursor pagination
- `lib/domain/analysis/pipeline-version.ts`: 알 수 없는 값은 거부하는 V1/V2 dual-read 라우팅
- `lib/contracts/analysis-v2.ts`: 사전 점검·진행률·결과·에러 코드 Zod 스키마와 DTO
- `lib/services/ai/stage-policy.ts`: 단계별 모델, thinking, 이미지, 출력, 동시성, 프롬프트/스키마 버전

`docs/PRD.md`, `docs/AI_*.md`, `docs/operations-cost-model.md`, components, mypage, migration의 중복 값은 가능한 경우 정본을 import하거나 링크·생성 방식으로 바꾼다.

### SSOT 감사 결과

| 기준 | 현재 위치 | 문제 | V2 조치 |
|---|---|---|---|
| 플랜 상한 | `plan-limits.ts`, PRD, 한국어 문서, 비용 문서, my-page, migration | 500/1,000 및 Basic/Standard 값 충돌 | 버전 있는 plan catalog 사용 |
| 점수 가중치 | `scoring.ts`, `interaction-score.ts`, `step/route.ts`, 문서 | 190/100/290점 체계 혼재 | risk policy를 scorer와 테스트에서 import |
| 위험 등급 | `classifyRiskGrade`, finalize, `ThreatBar` | 순위 등급과 화면 점수 불일치 | 절대 밴드+실제 1.0~10.0 점수 |
| 모델/thinking | `gemini-cost.ts`, `gemini.ts`, env, 비용 문서 | 단계별 정책 표현 불가 | stage policy로 분리 |
| 진행률 | `steps.ts`, request 컬럼, 페이지, hook | 고정 순차 퍼센트 중복 | V2 progress contract |
| 미디어 범위 | `instagram.ts`, mapper, preprocessing, prompt | carousel 자식 누락 | media policy와 selection hash |

## 7. API 계약

### 사전 점검

`POST /api/analysis/preflight`는 요청을 저장하고 무료 대상 프로필 작업을 큐에 넣은 뒤 즉시 `pending`을 반환한다. `GET /api/analysis/preflight/:id`는 `pending`, `ready`, `blocked` 상태와 대상 username, 이름, bio, 아바타, 팔로워/팔로잉 수, 비공개 여부, 필요한 플랜, 플랜 견적, 가격 버전을 반환한다.

```ts
type PreflightRequestV1 = { targetInstagramId: string };
type PreflightAcceptedV1 = {
  schemaVersion: 1;
  preflightId: string;
  expiresAt: string;
  status: 'pending';
};
```

worker는 `fallback=false`로 자체 프로필 provider만 사용한다. 사전 점검에서는 관계·상호작용·Gemini·유료 provider 원장 행을 만들지 않는다. 소유자 범위, 멱등성, 30분 TTL, 서명된 이미지 proxy를 적용한다.

`PATCH /api/analysis/preflight/:id`는 정규화된 `excludedInstagramId` 하나 또는 명시적 skip을 저장한다. 대상 username, 잘못된 username, 다른 소유자, 이용권 소비 후 변경은 거부한다.

### 테스트 이용권과 향후 결제

결제 전에는 관리자 서명 테스트 이용권만 허용한다. 운영 환경에는 결제 우회가 없다. 향후 `POST /api/checkout`은 `preflightId`만 받아 서버에서 플랜과 가격을 재계산한다. 검증된 webhook 트랜잭션은 불변 플랜·범위·가격·제외·정책 스냅샷을 가진 요청 하나만 만들고, 첫 task가 수락된 뒤에만 실행을 활성화한다.

### 진행률

```ts
type ProgressSnapshotV1 = {
  schemaVersion: 1;
  requestId: string;
  revision: number;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'upgrade_required';
  progressBp: number;
  backgroundProcessing: boolean;
  tracks: Record<'relationshipAi' | 'interactions' | 'finalization', {
    state: 'pending' | 'running' | 'completed' | 'failed';
    stageCode: string;
    done: number;
    total: number;
    progressBp: number;
  }>;
  activeProfile: { maskedUsername: string; imageUrl: string | null } | null;
  etaRange: { lowSeconds: number; highSeconds: number } | null;
  lastEventSeq: number;
};
```

`GET /api/analysis/progress/:id?afterSeq=N`은 현재 snapshot과 허용된 이벤트를 반환한다. Realtime은 가속기이고, 끊김·절전·앱 전환 뒤에는 sequence polling으로 누락을 복구한다. 네트워크에는 원시 댓글·캡션·liker username·근거 수·원점수·`step_data`를 보내지 않는다. 자극적인 발견 카피는 최종 체크포인트 전까지 provisional 코드로 표시하고 나중 이벤트로 정정할 수 있다.

`activeProfile`은 작업별 시작 heartbeat에서 조회 시점에 투영한다. 프로필 수집기는 실제 자체 요청 직전(원격 fallback batch는 실제 입력 중 대표 계정 하나)에, 프로필 AI는 제한된 후보 작업 시작 직전에 heartbeat를 남긴다. 저장값은 마스킹된 username과 `null` 또는 서명된 이미지 proxy 경로뿐이다. 병렬 실행에서는 **정확한 lease가 아직 살아 있는 작업 중 가장 최근 시작된 프로필**을 `started_at` 순서로 선택하고, 완료되거나 lease가 만료된 작업은 자동으로 제외한다. 이 값은 판정 근거가 아닌 일시적 UX 정보라 DAG/event revision 없이 바뀔 수 있으며, 클라이언트는 5초 polling 때 함께 갱신한다.

### 결과

요약에는 플랜, 선언/수집 관계 커버리지, 감지 맞팔, 공개/비공개 수, 선별/상세 수, 제외 적용 여부, 점수 정책 버전, 대상 아바타를 포함한다. 여성 행에는 `displayScore`, `riskBand`, `featuredRank`, `recentMutualRank`, `analysisDepth`, `oneLineOverview`를 포함한다. 구성 점수와 상호작용 수는 서버 전용이다. 고위험 총평은 대표 고위험 행에만 정확히 2개의 검증된 줄로 반환한다. 여성/비공개 행은 cursor pagination을 사용하고, 900개 이상을 한 DOM에 렌더링하지 않는다.

## 8. 데이터베이스 마이그레이션

V1 활성 요청은 기존 테이블과 라우트에서 계속 동작하도록 먼저 additive migration을 적용한다.

새 테이블:

1. `analysis_preflights`: 소유자, 대상 snapshot, 필요 플랜, 제외, 상태, 멱등키, 만료, 가격 버전
2. `analysis_pipeline_jobs`: 요청, job key, track, kind, batch, 상태, 입력 hash, lease fencing token, 시도 횟수, 시간, 에러 코드
3. `analysis_profile_fetch_results`: username, source(`cache/selfhosted/apify`), 상태, 제한된 프로필/미디어 snapshot, 실패 원인, 수집 시각
4. `analysis_candidate_ai_results`: 단계(`triage/features/partner_safety`), 모델/thinking/prompt/schema 버전, 입력 hash, 엄격한 결과
5. `analysis_target_interactors`: 성별 확정 전 저장하는 제한된 대상 liker/댓글 staging. service-role만 읽고 종료 시 삭제
6. `analysis_progress_state`, `analysis_progress_events`: 소유자가 읽을 수 있는 정리된 상태/이벤트, 단조 증가 revision/sequence
7. `analysis_v2_active_profile_heartbeats`: service 전용 마스킹 시작 heartbeat. 살아 있는 프로필 작업별 1행을 두고 소유자 progress 조회에는 가장 최근 시작 행 하나만 투영

기존 `analysis_requests`에는 pipeline/preflight/제외/플랜·가격·범위 snapshot 및 정책 버전을 추가한다. `analysis_interaction_scores`에는 6개 구성 점수, soft context, business/partner modifier, pre/final 원점수, 표시 점수, shortlist·역방향 좋아요 상태, 상한, 위험 밴드, 대표 순위, 버전을 추가한다. `analysis_results`에는 1자리 숫자 점수, 밴드, 대표 순위, 최근 맞팔 순위, 분석 깊이, 한 줄 개요, 점수 버전을 추가한다. 새 staging 테이블의 anon/authenticated 읽기는 차단하고, 완료/실패 RPC는 모든 V2 PII staging을 원자적으로 삭제한다.

## 9. 구현 단계

### Phase A: 계약 기반

1. 정본 정책과 Zod 계약 파일 추가
2. `pipelineVersion=v2`, 정책 버전, 에러 코드, DTO fixture, dual-read 정의
3. 플랜 적격성, 점수 경계, 최근 여성 순위, 미디어 선택, pagination, 진행률 단조성 순수 테스트
4. 이 커밋을 프론트엔드 분기점으로 push. 이 전에는 UI 구현 시작 금지

### Phase B: 사전 점검과 제외

구현 상태: 백엔드 브랜치에서 완료했다. migration은 Phase I의 테스트 프로젝트 통합 게이트 전까지 원격에 적용하지 않는다.

migration/RLS/만료/멱등성, 비동기 preflight API, 자체 Cloud Run 작업, 제외 route, 서명 테스트 이용권을 추가한다. preflight가 Gemini·관계·상호작용·유료 provider를 0건 생성하는 테스트를 둔다.

### Phase C: V2 작업 기반

구현 상태: 백엔드 브랜치에서 완료했다. 추가 migration은 Phase I 전까지 원격에 적용하지 않는다. Phase D-G handler와 독립 복구 scheduler를 연결하고 검증하기 전까지 실행 capability는 `preflight_only`로 닫아 둔다.

작업별 lease와 결정적 task name, `{requestId, jobKey}` payload, V2 dispatcher, fan-out/join, terminal cleanup을 추가한다. V1 lease는 건드리지 않는다. 운영 V2는 queue 수락을 필수로 하고 브라우저 실행은 로컬 개발에서만 허용한다.

### Phase D: 프로필 미디어와 미해결 전용 fallback

`InstagramPost`에 순서가 있는 `mediaItems`를 추가하고 `imageUrl`은 호환 alias로 남긴다. carousel 자식과 reel/video 썸네일을 파싱한다. 최신 8개 게시물에서 게시물별 대표 1장씩 선택한 뒤 최신 carousel에서 2장을 추가해 최신·중간·마지막 프레임을 확보한다. 위험 shortlist 계정은 선택된 3장 밖의 파트너 근거를 확인하도록 제한된 저해상도 contact sheet를 병렬 생성한다. 요청한 모든 username/provider 시도에 대해 `success/unavailable/failed`, 제한된 원인, 지연시간 중 하나를 반드시 저장하고 rejected promise, `data.user=null`, schema·transport 오류가 `Promise.allSettled`에서 사라지지 않게 한다. 그 뒤 미해결 username 집합을 고정하고 정확히 그 집합만 하나의 durable paid Actor에 보낸다. 이 telemetry 배포 후에만 `0_min._.00` canary를 재실행해 빠진 프로필의 실제 원인을 판정한다.

### Phase E: 2단계 Gemini

1. Gemini wrapper에 호출별 모델, thinking, 해상도, 출력 한도, JSON schema, stage metadata, 프로세스 공유 동시성 상한 10을 추가한다. 단계별 상한이 더 낮으면 그 값을 우선한다.
2. 1차 선별: `gemini-3.1-flash-lite`, `MINIMAL`, 프로필+대표 피드 4장, 작은 성별/소유자 schema. 고신뢰 남성만 제외한다.
3. 2차 특성: 초기에는 `gemini-3.1-flash-lite`, 여성/unknown/borderline 계정, 프로필+선정 피드 10장, `MEDIUM`. 최종 성별, 외모, 노출, 비즈니스, 기혼/파트너 근거, 한 줄 개요, 근거 ID를 반환한다. 정확도 향상이 지연·비용을 정당화할 때만 라벨 A/B로 Gemini 3 Flash 승격을 검토한다.
4. 고위험 총평: 대표 고위험만 최대 3건 병렬, Gemini 3 Flash `HIGH`, 프로필·피드·bio·캡션·검증 상호작용·실제 정리된 댓글을 사용한다. 2차는 검증된 여성마다 이미지별 객체를 여러 개 만들지 않고 비공개 content-addressed 정규화 미디어 bundle 하나를 저장한다. 총평은 이 bundle을 재사용해 Instagram 이미지를 다시 다운로드·디코딩하지 않으며, 종료 정리는 정확한 객체 generation을 삭제한다.
5. triage/features cache를 모델·prompt/schema 버전·미디어 hash별로 분리한다. V1 결합 cache는 V2 miss다.
6. 사람이 라벨링한 독립 A/B로 평가한다. 1차에서 false-female 품질 게이트가 통과할 때만 `MINIMAL`을 유지한다.

따라서 라우팅된 계정에는 1차, 2차, 대표 고위험에 한한 추가 고사고 총평 호출이 발생한다. 명백한 남성 계정에 중간/고급 추론과 11장 이미지를 낭비하지 않기 위한 분리다. Google 모델 문서 기준 `gemini-3.1-flash-lite`는 이미지 입력·구조화 출력·`MINIMAL/LOW/MEDIUM/HIGH` thinking을 지원한다.

### Phase F: 병렬 근거 트랙

대상 snapshot 뒤 관계 수집과 대상 liker/댓글 수집을 동시에 enqueue한다. 제한된 raw interactor를 성별 확정 전 저장하고, 프로필 batch가 들어오는 즉시 1·2차 AI를 시작한다. 비공개 계정 이름 분석도 공개 프로필/AI와 병렬 실행한다. 두 트랙 완료 후 최종 여성 집합과 상호작용을 join하고, 97점 예비 점수→Top-10 고정→후보 liker→최종 점수·밴드·대표 순위·relative-watch를 계산한다.

### Phase G: 총평과 완료

구조화된 제한 근거와 정리된 실제 댓글로 총평 입력을 만든다. 첫 줄은 계정 스타일을 구체적으로 설명하고, 둘째 줄은 대상과의 관계 근거와 실제 댓글이 있으면 그 내용을 언급한다. 출력은 근거 참조를 가진 정확히 한국어 2줄이다. 말투는 시니컬·위트·도발적·가설 중심이어도 되지만 사실이 아닌 외도 단정은 금지한다. 지원하지 않는 방향의 상호작용, 관계, 내부 지표, handle/URL/이메일/전화번호는 거부하고, 잘못된 출력은 재과금 생성 대신 결정적 fallback을 사용한다. 마지막에 점수·밴드·대표 순위·최근 맞팔 순위·개요·총평을 저장하고 staging을 트랜잭션으로 삭제한다.

### Phase H: 진행률과 결과 UI

고정 순차 임계값이 아니라 DAG work-unit으로 단조 증가 진행률을 발행한다. 마스킹된 현재 프로필, 병렬 트랙 상태, 퍼센트, ETA, provisional/correction 이벤트를 제공한다. 숫자 퍼센트가 같아도 terminal 상태와 이벤트 sequence 등 내구성 있는 snapshot 의미가 바뀌면 revision을 올리고 이벤트 append 시 sequence 연속성을 강제한다. 현재 프로필은 별도 일시적 heartbeat에서 살아 있는 작업 중 `started_at` 최신 행을 선택하므로 DAG revision과 독립적이다. snapshot을 먼저 hydrate하고 Realtime 구독 후 sequence gap을 보정하며, 5초 polling으로 이벤트 누락과 현재 프로필을 함께 갱신한다. 결과에는 범위 커버리지, 실제 1.0~10.0 점수, 별도 대표 섹션, 한 줄 개요, 고위험 없음 상태, pagination, 긴 목록 virtualization을 추가한다. reduced-motion, 모바일, 이미지 실패, reconnect, 브라우저 복귀, terminal failure를 처리한다.

### Phase I: 실측과 E2E

테스트 프로젝트에 migration을 적용하고 GCP CLI로 Cloud Tasks/Run과 제한된 preflight retention scheduler를 설정한다. 미디어 artifact bucket은 worker와 같은 리전에 두고 uniform bucket-level access, public access prevention 강제, 기본 7일 soft delete와 Object Versioning 비활성화, 무조건 `Age=1` Delete lifecycle, worker의 object create/get/delete만 허용하는 IAM을 설정한 뒤 모든 조건을 실제로 검증한다. 정확한 generation을 지우는 종료 정리가 1차 수단이고 lifecycle은 DB 등록 성공 여부가 모호한 upload을 위한 비동기 fallback이다. 이 검증 전에는 V2 실행을 열지 않는다. provider·RLS·migration·멱등성·정리 통합 테스트를 실행한다. 첫 계정은 `0_min._.00`으로 하고 단계별 지연, provider, 선언/반환 수, fallback username 집합, Gemini 호출/토큰/thinking, 비용, 전체 wall time을 기록한다. Basic/Standard/Plus fixture를 동시 부하로 반복한다. E2E와 비용 대사가 끝난 뒤 결제 checkout/webhook을 마지막 단계로 붙인다.

## 10. 프론트엔드 병렬 작업

프론트엔드는 Phase A가 commit/push된 즉시 시작한다. crawler/DAG 완성을 기다리지 않는다.

```bash
git worktree add ../ai-baram-detector-frontend -b feat/launch-funnel-ui <contract-commit>
```

백엔드는 `app/api/**`, `supabase/**`, `lib/services/analysis/**`, `lib/services/instagram/**`, `lib/services/ai/**`, 정본 domain/contract 파일을 소유한다. 프론트는 `app/page.tsx`, `app/analyze/**`, `app/progress/**`, `app/result/**`, `app/share/**`, `app/mypage/**`, `components/**`, progress/result hook을 소유한다. 프론트는 계약 파일을 읽기 전용으로 import하고 plan limit·가격·진행률 코드·위험 임계값을 하드코딩하지 않는다.

필수 fixture는 preflight pending/ready/private/missing/over-Plus, 3개 플랜 중 하나만 eligible, 여성 0명/고위험 0명/고위험 3명/주의 overflow/Stage-1-only, provisional→correction, 이미지 누락, Realtime gap 및 polling 복구, 브라우저 복귀, terminal failure, 900행 pagination/virtualization, reduced-motion 모바일이다.

통합 순서는 계약 merge → 백엔드 preflight/DAG/result API 통합 브랜치 → 프론트 rebase 및 live endpoint 교체 → 모바일/데스크톱 Playwright → main 전 code review다.

## 11. 테스트 및 출시 게이트

### 정확성

- 관계 목록은 각자 99% 고유 커버리지를 달성하거나 최종 결과를 생성하지 않는다.
- 자체 성공과 Apify 미해결 결과가 누락·중복 없이 merge된다.
- 모든 provider batch는 fallback 집합을 만들기 전에 username별 최종 결과를 정확히 하나씩 저장하며 rejected/null 항목을 조용히 버리지 않는다.
- Apify 입력 username 집합은 저장된 unresolved 집합과 정확히 같다.
- 여자친구 username은 어떤 프로필·AI·상호작용·점수·진행률·결과·공유 payload에도 없다.
- 최근 점수와 배지는 검증된 여성에게만 적용된다.
- 근거가 모두 낮은 fixture에서 고위험은 0명이다.
- 비즈니스 감쇄는 soft context에만 적용된다.
- shortlist 밖 역방향 좋아요는 `not_collected`로 표시된다.

### AI 품질

독립 라벨셋에서 false-female 최대 1%(신뢰구간 포함), 여성 recall 최소 95%, schema 검증 후 구조화 응답 성공률 최소 99.9%, 근거 없는 관계 주장 0건, 총평 2줄·한국어·근거 참조·비식별화 100%를 목표로 한다.

### 복원력·개인정보

중복 task/retry가 provider 비용·진행률 이벤트·결과를 중복 생성하지 않아야 한다. 브라우저를 10분 닫아도 서버 작업이 중단되지 않아야 하며, 재접속 시 snapshot과 이벤트 gap을 복구한다. 네트워크 payload에는 원시 댓글·캡션·liker username·근거 수·원점수·`step_data`가 없어야 한다. 완료/실패 시 새 staging은 모두 삭제한다.

### 성능

- cache miss 사전 점검 p95 < 5초
- 첫 유용한 확정 진행률 < 60초
- 각 플랜 광고 상한에서 전체 결과 p95 < 300초
- 단계 예산: bootstrap 5초, 병렬 관계/대상 근거 60초, profile+AI 150초, shortlist/reverse liker 45초, 총평/finalize 40초, 총 300초 상한

### 비용

사전 점검은 유료 provider와 Gemini 비용 0이어야 한다. 모든 유료 provider 실행에는 예상/실제·상한 비용, run ID, credential slot, input hash, 종료 대사가 있어야 한다. Gemini 호출마다 stage, model, thinking, 이미지 수, 지연, 토큰, cache hit, 예상 비용을 기록한다. 세 플랜의 측정 p95 비용이 가격 catalog에 들어온 뒤에만 결제를 붙인다.

## 12. 오류 및 구제 표

| 실패 | 사용자 상태 | 구제 |
|---|---|---|
| 대상 없음/비공개 | 사전 점검 차단 | 과금 없음, username 수정 |
| Plus 상한 초과 | 미지원 | 대기 목록/수동 견적 |
| 결제 범위보다 수 증가 | 업그레이드 필요 | 유료 Actor 전 중단, 업그레이드/환불 |
| 관계 커버리지 99% 미만 | 처리 실패 | 같은 실행 재개 또는 설정된 한 번의 fallback, 부분 결과 금지 |
| 자체 프로필 일부 실패 | 처리 계속 | 성공분 checkpoint, 미해결만 유료 fallback |
| 두 provider 모두 실패 | 근거 부족 | 확실히 unavailable인 행 제외, 아니면 범위 게이트 실패 |
| Gemini 429 | 지연 | 제한된 retry |
| Gemini 전송 결과 모호 | 안전 실패 | 과금됐을 수 있는 생성 재실행 금지 |
| 1·2차 성별 충돌 | 미확정 | 여성 결과 직접 진입 금지, 제한된 adjudication/fallback |
| 강한 파트너 근거 | 조정 | 공개 점수 3.4/정상 상한, 내부 근거 보존 |
| 고위험 임계값 없음 | 정상 빈 상태 | 정직한 요약과 별도 relative-watch |
| 큐 불가 | 대기/실패 | 운영에서는 browser-paid 실행으로 전환하지 않음 |
| Realtime 단절 | 화면만 stale | sequence fetch와 polling 복구 |
| webhook 중복 | 중복 요청 없음 | unique order transaction |

## 13. E2E 통과 전 범위 제외

공개 결제 checkout/webhook, V1 및 외부 provider 삭제, 로그인 쿠키 기반 자체 관계 수집, 정확한 팔로우 시각 보장, 원시 상호작용 수 브라우저 노출, 5분/비용 게이트를 통과하지 못한 Plus 출시.

## 14. 구현 작업 목록

1. 정책 SSOT·계약·fixture·경계 테스트
2. preflight/exclusion schema·RLS·API·무비용 테스트
3. V2 job·lease·dispatcher·coordinator·terminal purge
4. media-item mapper·carousel·reel thumbnail·선택 테스트
5. username별 crawler checkpoint·미해결 전용 paid fallback
6. 단계별 Gemini wrapper·triage·feature·cache·라벨 평가 harness
7. 병렬 관계/대상 상호작용 track과 join
8. V2 점수·shortlist·최근 여성·partner/business modifier·분류
9. 고위험 총평 검증기와 결정적 fallback
10. 정리된 progress state/events와 결과 pagination API
11. 별도 worktree의 프론트 funnel·progress·result·share·mypage V2
12. Cloud Run/Tasks 배포·관측성·canary·load·비용 문서·Playwright E2E
13. 모든 게이트 통과 후 결제 provider 연동

## 15. 검토 결정

- 제품: 모든 플랜 카드는 공개하고, 적격 플랜 하나만 자동 강조하며, 실제 자체 대상 미리보기를 보여주기 전 결제하지 않는다.
- 디자인: 진행률은 생생하게 보여주되 provisional과 confirmed 및 correction을 구분한다.
- 엔지니어링: V1 옆에 V2를 추가하고 request-wide state를 job row로 전환하며 계약을 먼저 고정한다.
- 데이터 품질: 관계 완전성과 분석 깊이는 결과의 일급 필드이며 부분 작업을 완료라고 표현하지 않는다.
- 사용자 요구와의 충돌: 고위험/주의 최소 인원 강제는 절대 임계값과 충돌하므로 `relativeWatch`를 별도 표시한다.
- 파트너 조정: V2.2는 약한 남성 동반자 감점을 잠정 `-5`로 적용한다. 강한 파트너 신뢰 기준과 향후 감점 변경은 라벨 fixture와 새 정책 버전이 필요하며, 강한 근거의 정상군 상한 자체는 고정한다.

### Phase A를 막지 않는 보류 결정

최종 Basic/Standard/Plus 원화 가격·결제 provider, 강한 파트너 신뢰 기준·잠정 `-5` 검증, Stage 2가 Flash-Lite medium인지 Gemini 3 Flash medium인지, Cloud Run 리전/CPU/메모리/동시성/Gemini quota, Standard/Plus 출시 여부는 E2E·A/B·부하·비용 게이트 뒤에 결정한다.

## GSTACK 검토 보고서

### 검토 범위

CEO 관점의 범위와 funnel, 디자인 정보 구조·모바일·재접속 상태, 엔지니어링 아키텍처·데이터 흐름·복구·성능·테스트·rollout·worktree 병렬화를 검토했다. 2026-07-13 공식 Google 모델 및 thinking 문서를 확인했고, plan·score·model·progress 정의가 중복되어 있음을 SSOT 감사로 확인했다.

### 준비 상태

- 제품 계약: 가격을 의도적으로 보류한 상태로 준비됨
- 백엔드 계약: Phase A와 보호된 Phase B endpoint 구현·검증 완료
- 프론트엔드: Phase A 계약 commit 이후 시작 가능
- 프로덕션 출시: V2 구현, 독립 라벨 AI 평가, 전체 E2E, 부하/비용 게이트, 결제 연동 전에는 차단

### 확인한 공식 문서

- Gemini 3.1 Flash-Lite: https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite
- Gemini thinking levels: https://ai.google.dev/gemini-api/docs/thinking
