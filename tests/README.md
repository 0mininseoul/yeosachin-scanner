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
| 진행·결과·보관함 | app/progress/, app/result/, app/mypage/ | analysis/results/archive-history.test.ts, presentation-policy.test.ts, interaction-evidence.test.ts |
| 결제·주문·대기 등록 | app/api/earlybird/, lib/services/earlybird/ | commerce/checkout-policy.test.ts, commerce/ |
| 계정·권한·인증 | lib/services/identity/, app/auth/ | identity/request-credentials.test.ts, identity/ |
| 운영자 조회·감사 | app/admin/analysis-audit/, app/api/admin/ | operations/console-model.test.ts, operations/ |
| 배포·queue·identity epoch | scripts/deploy-*, configure-*, capacity-identity-epoch/ | infra/ |
| 페이지·컴포넌트·데모 | app/, components/, hooks/, lib/services/demo-analysis/ | ui/ 및 기능별 routes/ |
| replay·실험 | lib/services/analysis/replay/, scripts/replay-* | analysis/replay/ |
| 공용 계약·유틸 | lib/contracts/, 해당 lib 모듈 | contracts/, shared/ |

표의 경로는 이 tests/ 디렉터리를 기준으로 한다. 세부 검사 파일명은 대상 기능 폴더에서 검색한다. 모든 파일명을 복제한 별도 인덱스는 유지하지 않는다.

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
