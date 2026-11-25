# 기능별 검증 안내

실행 코드에는 테스트를 나란히 두지 않는다. 구현 파일마다 테스트를 만들지 않고 **바뀌는 기능과 실패 위험**을 기준으로 기존 검증을 찾는다. 필요하지 않은 테스트는 추가하지 않는다.

## 가장 짧은 작업 경로

1. 아래 표에서 기능의 실행 진입점과 검증 묶음을 고른다.
2. 구현과 직접 호출되는 코드만 먼저 읽는다. 저장소 전체, 과거 계획 문서, 전체 migration/테스트를 매번 읽지 않는다.
3. 타입체크: `npx tsc --noEmit --pretty false`.
4. 행동/경로를 바꿨을 때만 해당 기존 검사 실행: `npm test -- tests/ai/generation-policy.test.ts`처럼 파일 또는 기능 폴더를 지정한다.
5. RPC를 바꾸면 해당 이름의 최신 SQL 정의·caller와 관련 DB 검사만 확인한다. SQL 파일 하나마다 문자열 계약 테스트를 만들지 않는다.

| 작업 | 실행 코드 시작점 | 검증 |
| --- | --- | --- |
| AI 호출·비용·응답·동시성 | lib/services/ai/gemini.ts, v2-staged-analysis.ts | ai/generation-policy.test.ts, ai/media-input-policy.test.ts, ai/ |
| 익명/로그인 입력·preflight | app/api/analysis/preflight/, lib/services/analysis/preflight.ts | analysis/preflight/entry-policy.test.ts, analysis/preflight/ |
| provider·수집·정산 | lib/services/analysis/v2-collection-executors.ts, lib/services/instagram/ | analysis/providers/ |
| job·재시도·정책 | lib/services/analysis/v2-worker.ts, v2-tasks.ts | analysis/execution/job-policy.test.ts, retry-policy.test.ts |
| Dev Standard 접수부터 소유자 결과·이미지까지 | app/api/analysis/preflight/, lib/services/analysis/v2-worker.ts, app/result/ | analysis/execution/standard-admission-result-pglite.test.ts (독립 정상 2회, 프로필 읽기 및 Apify 종료 기록 57014 재개, 특징 판독 전 57014 이후 기존 성별 판독의 개별·일괄 복구 비교) |
| 진행·결과·보관함 | app/progress/, app/result/, app/mypage/ | analysis/results/archive-history.test.ts, presentation-policy.test.ts, interaction-evidence.test.ts |
| 체리(남친 맞팔 알리미) 감지·알림·구독 | lib/services/cherry/, app/api/cherry/, app/cherry/ | cherry/ |
| 결제·주문·대기 등록 | app/api/earlybird/, lib/services/earlybird/ | commerce/checkout-policy.test.ts, commerce/ |
| 계정·권한·인증 | lib/services/identity/, app/auth/ | identity/request-credentials.test.ts, identity/ |
| 운영자 조회·감사 | app/admin0min/, app/admin/analysis-audit/workbench.tsx, app/api/admin/ | operations/console-model.test.ts, operations/ |
| 운영 콘솔 파이프라인 맵 (분석 흐름을 바꾸면 함께 점검) | lib/services/admin/pipeline-map.ts, app/admin/console/pipeline-view.tsx | operations/pipeline-map.test.ts |
| 비공개 migration 원본 검증 | scripts/verify-supabase-private-source.ts, scripts/supabase-private-source.ts | operations/tools/verify-supabase-private-source.test.ts |
| 배포·queue·identity epoch | scripts/deploy-*, configure-*, capacity-identity-epoch/ | infra/ |
| 페이지·컴포넌트·데모 | app/, components/, hooks/, lib/services/demo-analysis/ | ui/ 및 기능별 routes/ |
| replay·실험 | lib/services/analysis/replay/, scripts/replay-* | analysis/replay/ |
| 공용 계약·유틸 | lib/contracts/, 해당 lib 모듈 | contracts/, shared/ |

표의 경로는 이 tests/ 디렉터리를 기준으로 한다. 세부 검사 파일명은 대상 기능 폴더에서 검색한다. 모든 파일명을 복제한 별도 인덱스는 유지하지 않는다.

Dev Standard 통합 검사는 매 실행마다 빈 PGlite에 Dev 스키마와 합성 소유자를 준비한다. 정상 실행 두 번, 프로필 체크포인트 재개, 공급자 종료 영수증 시간 초과 뒤 같은 요청 재전달을 확인한다. 또한 저장소의 합성 프로필·게시물·이미지로 새 수집본을 봉인하고 별도 승인에서 재생한다. 일반 사전 점검과 B-lite 사전 점검을 각각 실행하고, B-lite를 재생할 때 보관된 미리보기를 복원하는지 확인한다. 재생은 Apify와 원천 이미지 다운로드 0회, DB 발행, 소유자 결과·후보 WebP 열람, 타인 접근 거부를 검사한다. 같은 초기 판독 입력에서 원본은 후보를 제외하고 재생은 특징 판독을 요청하는 조건도 검사한다. 미리 보관한 추가 이미지로 특징 판독을 마치고, 기존 역방향 좋아요로 충분하면 결과와 WebP를 연다. 원본에서 조회하지 않은 후보가 새로 포함돼도 역방향 좋아요를 미수집으로 기록하고 가산점 없이 결과를 한 번 발행한다. 소유자 페이지의 확인 범위 주석과 공개·비공개 후보 이미지, 재생 중 Apify 호출·예약·차감 0건을 검증한다. 실제 Dev 수집본의 24시간 보존 기한이 지난 뒤에도 같은 합성 입력으로 실행할 수 있다. macOS에서는 아래 명령으로 외부 연결을 차단한다.

```sh
sandbox-exec -p '(version 1)(allow default)(deny network-outbound)' node node_modules/vitest/vitest.mjs run tests/analysis/execution/standard-admission-result-pglite.test.ts
```

### Standard 동시 접수 16건

PostgreSQL 17의 `postgres`, `initdb`, `pg_ctl`을 PATH에 둔다. macOS와 네트워크 네임스페이스를 지원하는 Linux에서 아래 러너가 외부 IP 연결을 차단하고 전용 Unix 소켓으로 새 DB를 만든다. 실제 계정 자료와 클라우드 자격 증명은 필요하지 않다. 네 번째 인자는 새로 만들 집계 파일의 절대 경로다.

```sh
node scripts/standard-shared-capacity.mjs 2 8 normal /tmp/standard-webhook.json 4 fast
node scripts/standard-shared-capacity.mjs 16 56 recovery /tmp/standard-recovery.json 30 fast
node scripts/standard-shared-capacity.mjs 16 48 normal /tmp/standard-observed.json 4 observed
```

- 2명은 서명된 합성 결제 웹훅을 처리한다. 16명은 한정판매 재고 10건을 보존하기 위해 각 소유자의 실제 체크아웃에 합성 결제 확인과 이행 작업을 기록한다. 두 방식 모두 사전 점검, 정식 접수, 같은 DB와 큐를 사용하는 워커, 발행, 소유자 페이지와 WebP 열람을 거친다.
- 두 번째 인자 8·48·56·64·80은 전체 Vertex 슬롯이다. 대응하는 유료 큐 동시 작업 수는 8·16·20·24·32, 특징 판독 한도는 6·32·40·48·70이다. 한 Node 프로세스에서 워커별 수집·판독 동시성 제한을 독립적으로 유지한다. 48·56·64·80용 SQL은 비어 있는 로컬 클러스터에서만 실행된다.
- 다섯 번째 인자로 요청당 공개 후보를 1~240명 지정한다. 비공개 후보는 1명이다. `fast`는 모델 응답과 재전달 대기를 단축한다. `observed`는 이전 유료 실행의 단계별 모델 평균과 수집 예약 시간을 사용한다. 수집 대기는 Actor 1회당 약 25초로 균등 배분한 값이다. Dev 유료 큐의 재시도 간격 40~300초를 적용하며 관리형 서비스의 부하 조절은 재현하지 않는다.
- `recovery`는 워커 진입 전 HTTP 429 한 번, 프로필 체크포인트 조회에서 SQLSTATE 57014 한 번을 주입하고 고정 응답 지연을 25% 늘린다. 공개 후보가 4명 이상이면 묶음 분류의 일부 응답에 중간 확신도를 사용해 추가 판독도 요청한다.
- 정식 작업 중 5분마다 운영 코드로 만료된 공급자 예약과 슬롯을 회복하고 주문 이행을 조정한다. 마지막 작업 직후에도 한 번 수행한다. SDK 응답의 사용량을 끝내 받지 못한 시도의 비용은 미확정으로 보존한다.
- 집계에 각 소유자의 결제·접수부터 발행까지, 이행 완료까지의 시간, 결과·이미지 권한과 원본 일치, 합성 사용량·정산, PostgreSQL 블록 통계를 남긴다. 발행 후 정산 불일치가 있으면 소유자의 열람과 이미지 확인을 마치고 원인별 건수를 기록한 뒤 검사를 실패시킨다. 60분을 넘긴 경우에도 작업과 열람 검사를 끝까지 진행해 완료 영수증과 초과 인원 수를 남긴다. 실제 공급자 과금과 Dev Free 디스크 잔량은 이 검사의 측정 범위 밖이다.

## 유지할 검증, 합치지 않을 검증

- 유지: 결제/claim 경합, owner·공개 권한, 익명 target-excluded 매핑, 중복 provider 실행, 비용 예약·정산, job lease/recovery.
- 작은 순수 검증은 기능별 파일로 합친다. 구현 파일 이름과 1:1로 맞출 필요가 없다.
- 서로 다른 `vi.mock` 설정, 브라우저 환경, DB 초기화·정리 수명은 억지로 합치지 않는다. 거대한 통합 테스트 파일도 만들지 않는다.
- `*-pglite.test.ts`는 실제 로컬 SQL 실행, `*-postgres*.test.ts`는 DB/동시성 검사다. 순수 단위 검사와 실행 비용·전제가 다르다. 필요한 DB 변경 때만 명시적으로 실행한다.
- `scripts/*.test.sh`와 `scripts/test-*.sh`는 현재 스크립트 옆의 상대 경로를 쓰는 수동 shell harness다. Vitest/기본 CI에서 실행되지 않는다. 이 파일만 shell 경로 보존을 위해 제자리에 둔다.
- TSX 검사는 직접 발견한다. TSX를 import만 하는 .test.ts 브리지를 다시 만들지 않는다.

## CI와 복원

기본 GitHub CI는 타입체크만 유지한다. `npm test` 전체 실행이나 PGlite·실제 Postgres·Cloud Run 배포를 작은 수정의 기본 절차로 추가하지 않는다. 새 테스트는 기존 검증으로 확인할 수 없는 중요한 동작이 바뀔 때만 고려한다.

과거 SQL 문자열 계약과 폐기한 생성기는 Git 태그 `archive/pre-cleanup-2026-09-15`(기준 `45afcf24`)에서 볼 수 있다. 테스트를 정리한 것이 DB migration·행을 지운 것은 아니다. 데모 이미지/fixture와 로고 산출물은 그대로 보존한다.
