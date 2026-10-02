# 2026-10-03 통합 체크아웃 및 워크트리 정리

기준일: **2026-10-03, Asia/Seoul**. 이 문서는 **Codex 앱에서 새 워크트리를 만들고, 상위 세션이 전체 작업을 orchestration하며 작업별 서브 에이전트를 사용하는** 후속 작업의 한국어 원본이다. 과거 세션을 처음부터 다시 수행하기 위한 계획이 아니다.

빠른 시작: [Codex 앱 새 세션 요청문](2026-10-03-codex-app-start.ko.md)

보존 위치: `/Users/youngminpark/.backups/yeosachin_scanner/worktree-cleanup/20261003-consolidated/`

작성·실행 상태: **로컬 정리·동기화·원본 보존 검증 완료**. Git과 Orca 모두 root main 1개만 남고, 6개 원본 보존본의 메타데이터/보호 migration 및 bundle 무결성을 확인했다. 상세 근거는 `verification-final.json`이다. 원격 ref도 `git ls-remote`로 다시 확인해 local HEAD/origin/main과 일치했다. 원격 병합 결과는 이 문서를 추가하는 PR의 상태로 확인한다.

## 1. 가장 먼저 알아야 할 현재 결론

1. 10월 3일 새로 fetch한 `origin/main`은 **`4147318472cf3d9101e7ea8a87cf31b943124bed`**다. 마지막 커밋은 9월 16일 PR #594다. 작업 공백 동안 원격 main에 더 최신 커밋은 확인되지 않았다.
2. 마지막 실질적인 인계는 **9월 16일 08:08 KST**다. 당시 VERIFIED_OK, 운영 활성화, 최신 main 웹 배포와 native read-back까지 완료했다. 9월 15일 이전의 “운영 활성화 미완료”, “모든 큐 PAUSED”, “readiness 실패” 문구를 현재 상태로 재사용하지 않는다.
3. **10월 3일 운영 클라우드 상태는 이번 작업에서 조회하지 않았다.** 이번에 새로 확인한 것은 Git/GitHub 병합 상태, 로컬 변경, Orca 세션/터미널, 보존 문서다. 아래 운영 수치에는 관측일을 붙인다.
4. 코드·DB 경량화 PR #589·#590과 관리자 대시보드는 완료됐다. **22개 테이블을 맞추는 목표는 폐기됐다.** 이전 계획의 빈 체크박스를 그대로 미완료 목록으로 삼지 않는다.
5. 실계정 분석 성공, 실제 운영자 화면의 데이터 조회, Vertex 비용 최적화의 실제 품질 증거, migration 이력 정렬에는 후속 확인이 남는다. `production-unblock`의 미병합 코드와 오래된 stash는 보존하지만 자동 통합하지 않는다.
6. 정리 후 유일한 활성 checkout은 `/Users/youngminpark/Desktop/개발/yeosachin_scanner`의 `main`이다. macOS의 분해형 한글 경로 표기는 같은 실제 디렉터리다. 옛 `.worktrees/final-main-20260725`는 보존본으로 옮긴다.

## 2. 증거의 우선순위와 조사 범위

우선순위는 **10월 3일 Git 실측 → 9월 16일 최종 체크아웃/활성화 receipt → 9월 15일 완료 보고서 → 이전 작업 계획/중간 리뷰**다. Git에 병합됐다는 사실은 현재 운영 성공을 뜻하지 않으며, 과거 운영 성공은 10월 3일의 성공을 뜻하지 않는다.

- Git 등록 7개를 모두 조사했다. 그중 main 1개를 유지하고 나머지 6개를 정리한다.
- Orca는 main 포함 5개를 표시했다. Supabase 설계 worktree와 detached canonical worktree는 Git에만 등록돼 있었다.
- Orca native 상태에서 정리 대상에 새 코드를 작성 중인 agent는 확인되지 않았다. `cormorant`에 과거 Codex/Claude 터미널 2개, cleanup worktree에 idle shell 1개가 남아 있었다. main의 현재 작업 세션은 유지한다.
- Orca Agent Session History 검색은 `enabled=false`였다. 이를 켜거나 비공개 인덱스를 우회하지 않았다. 열린 터미널 기록, 카드 상태, 외부 `.gstack` 체크포인트, Git 이력과 로컬 메모를 대조했다. **이미 닫힌 모든 대화의 전체 transcript를 검색한 것은 아니다.** 확인되지 않은 사용자 테스트 결과는 미확인으로 남긴다.
- `.orca/`, `.worktrees/`, 이 저장소의 Orca workspace 경로에서 `.git` 포인터도 추가 검색했다. 등록 목록 밖의 추가 linked checkout은 발견하지 못했다. 비어 있는 과거 trash 디렉터리와 다른 프로젝트는 정리 대상이 아니다.
- 기존 stash 2개, worktree 없는 로컬 브랜치 4개, migration 원본 복구에 필요한 과거 커밋 4개도 보존 범위에 포함했다.

## 3. 워크트리별 판정

뒤/앞은 `origin/main...HEAD`의 커밋 수다. squash된 이력은 앞선 커밋 수만으로 미반영이라고 판정하지 않았다. `git cherry`, patch 동등성과 최종 tree 비교를 함께 사용했다.

| 원래 워크트리 | HEAD / 브랜치 | 뒤/앞 | 로컬 변경 | 판정과 처리 |
| --- | --- | --- | --- | --- |
| 저장소 루트 | `c07e3c0a`, `main` | 367 / 0 | tracked 2개, scratch 및 중첩 orphan 파일 | tracked 변경을 별도 stash/patch로 보존하고 fast-forward. 관리자 page 변경은 최신 main과 byte 동일. 한국어 응답 규칙 추가는 고유 로컬 변경. |
| `supabase-22-table-consolidation-design-20260909` | `1913295f`, `0mininseoul/supabase-22-table-consolidation-design-20260909` | 169 / 1 | clean | 고유 SHA 1개지만 `git cherry`는 `-`: 동일 patch가 main에 존재. 옛 22-table 목표는 재개하지 않는다. |
| `vertex-production-rollout-20260904` | `8595fe34`, `0mininseoul/vertex-production-rollout-20260904` | 270 / 1 | 비추적 handoff 1개 | 커밋 patch는 이미 main에 존재. **비추적 Vertex 인계 문서는 별도 고유 증거**라 보존. 비용 최적화 승격 판단은 여전히 후속 확인 대상. |
| `.worktrees/final-main-20260725` | `a76a1a19`, detached | 10 / 0 | tracked clean, ignored 연결 메타데이터 | HEAD는 main의 조상. 소스 미반영 없음. Supabase/Vercel 연결 원본 보존 후 등록 해제. 아래 P0의 코드 경로 정비 필요. |
| `cormorant` | `03bf505f`, `canonical-release-24h` | 342 / 2 | tracked 5개, 비추적 23개 | 2개 커밋 모두 patch 반영 완료. 사용자 로컬 변경과 리뷰·SQL·디자인 원본 전체를 보존. 오래된 HEAD를 새 작업 기반으로 사용하지 않는다. |
| `orca-worktree-cleanup-audit-20260914` | `2486d831`, `ops/production-disabled-gates-20260916` | 1 / 10 | clean, ignored 연결/의존성 | 10개 커밋이 PR #594로 squash됐다. **최신 main과 전체 tree 동일**이며 GitHub MERGED도 확인. 재병합 필요 없음. |
| `production-unblock-minimal-20260914` | `f0982752`, `0mininseoul/production-unblock-minimal-20260914` | 6 / 3 | clean, ignored 의존성 | **3개 patch가 실제로 main에 없음.** 해당 CLI 설계는 이후 다른 운영 수정·활성화로 목적을 달성한 과거 대안이다. 미반영 원본을 보존하고 다음 세션에서 필요성만 재평가한다. |

각 원래 절대경로, 전체 SHA, status, ignored 목록은 보존 폴더의 `inventory-before.json`에 있다. 원본 파일은 `worktrees/<표의 워크트리 이름>/`에 위치한다. 이 보존 폴더에는 `.git` 포인터가 없으므로 활성 워크트리가 아니다.

### 3.1 실제 미반영 production-unblock 커밋

- `7e693ea9b99c7b6e36ee8cf278da443b09dcd8b3`: owner-only production unblock gate.
- `cd52f522a0392827a3ed85679ff75c3cf6cc83e2`: review gap 보완.
- `f0982752ae48dc11697939c91e2ed05ff08b4778`: graph·ambiguous queue 처리 보완.

분기점 대비 9개 파일, +1,877/-87줄이다. 핵심은 당시 `scripts/capacity-identity-epoch/owner-unblock.ts`, owner-production/discovery/contracts/work-planes, `scripts/prepare-capacity-identity-epoch.ts`, 관련 검사와 runbook이다.

현재 main에는 `owner-unblock.ts`와 별도의 `unblock inspect/apply` 진입점이 없다. 같은 목표를 PR #591~#594와 실제 owner 작업으로 해결했고 9월 16일 활성화까지 완료했다. 이 3개 커밋을 그대로 cherry-pick하면 최신 owner 계약, 이동된 테스트 위치, 실행 경계를 역행시킬 수 있다. **현재 main에 정말 필요한 미해결 증상이 발견된 경우에만 최소 아이디어를 이식한다.**

### 3.2 main과 cormorant의 미커밋 변경

main:

- `app/admin/analysis-audit/page.tsx`: 운영 콘솔 UI로 교체된 로컬 내용이 `origin/main`의 blob과 정확히 같았다. 다시 적용할 작업 없음.
- `AGENTS.md`: 한국어 응답 규칙과 장 번호 추가. 새 worktree의 후속 정비에서 한국어 규칙을 유지하되 최신 main의 다른 지침을 덮지 않는다.

cormorant:

- `AGENTS.md`, `README.md`, `package.json`, `package-lock.json`: 프로젝트 이름을 `yeosachin-scanner`로 변경.
- `docs/analysis-v2-production-operations.md`: canonical Vercel 프로젝트 slug/연결 검증 규칙 추가.
- `package-lock.json`: rollup의 `devOptional` 한 줄 제거도 포함.

이 변경 의도는 최신 main에 이미 반영돼 있다. README는 전체 blob도 같고, 다른 파일에는 이후 변경이 더 있으므로 오래된 전체 파일을 복사하지 않는다. 패치는 `patches/primary-main/`, `patches/cormorant/`, 원본 main 파일은 `primary-tracked/`에 보존한다.

### 3.3 비추적 파일과 중첩 경로 밖 orphan 파일

- Vertex 고유 문서: `worktrees/vertex-production-rollout-20260904/docs/operations/2026-09-04-vertex-cost-production-rollout.md`.
- cormorant `.superpowers/`: 디자인 HTML, review brief 및 최종 리뷰 여러 버전, SQL 감사 입력/출력, `released` 원본. 과거 review의 지적은 더 최신 완료 보고서와 대조해 재개 여부를 정한다. raw SQL 출력은 사용자 행을 포함할 가능성을 가정하고 출력·실행하지 않는다.
- 루트 scratch: `.tmp-instagram-session-bootstrap.py`, `scripts/.tmp-diagnose-replay-profile-dataset.ts`, `__pycache__/`를 `primary-untracked/`로 이동한다. 세션/프로필 관련 임시 스크립트이므로 자동 실행하지 않는다.
- 루트 `.orca/worktrees/yeosachin_scanner/`에서 실제 checkout 밖에 남아 있던 8개 파일을 `primary-untracked/.orca/`로 보존한다.

| orphan 상대경로 | 최신 main의 비교 대상 | 판정 |
| --- | --- | --- |
| `supabase/migrations/20260909110000_atomic_anonymous_preflight_landing_claim.sql` | 같은 경로 | blob 동일, 재적용 금지 |
| `supabase/migrations/20260909183850_revoke_legacy_landing_lead_insert_after_rpc_ready.sql` | 같은 경로 | blob 동일, 재적용 금지 |
| `docs/reports/2026-09-10-supabase-22-comment-interaction-retirement-evidence.md` | 같은 경로 | 내용 차이 있는 과거 증거 원본, 보존 |
| 같은 이름의 `manifest.json` | 같은 경로 | 내용 차이 있는 과거 manifest, 보존 |
| `lib/services/analysis/anonymous-preflight-landing-claim-migration-contract.test.ts` | `tests/analysis/preflight/anonymous-preflight-landing-claim-migration-contract.test.ts` | 파일 이동 및 후속 차이 있음 |
| `lib/services/operations/supabase-22-evidence-traffic.test.ts` | `tests/operations/operations/supabase-22-evidence-traffic.test.ts` | 파일 이동 및 후속 차이 있음 |
| `scripts/verify-supabase-22-comment-interaction-retirement.test.ts` | `tests/analysis/results/tools/verify-supabase-22-comment-interaction-retirement.test.ts` | 파일 이동 및 후속 차이 있음 |
| `scripts/verify-supabase-22-catalog.ts` | 같은 경로 | orphan은 오래된 supabaseAdmin RPC 방식, main에는 후속 CLI adapter 존재. 통째 복원하지 않음 |

파일 내용 차이가 있다는 사실만으로 개선 코드 또는 미완료 작업이라고 단정하지 않았다. 원본을 모두 보존했으므로 필요할 때 해당 기능만 비교할 수 있다.

## 4. 세션별 작업 현황과 완료 경계

### A. 자동 분석 안정화·용량 확장, cormorant

8월 31일 터미널 인계의 “아직 미배포/용량 확장 필요”는 당시 기준이다. 이후 PR #522의 자동 분석 capacity 작업, PR #548의 preflight/control-plane 수정, PR #591~#594의 운영 증거 작업이 main에 반영됐다.

당시 승인한 설계 목표는 순간 400건 접수, preflight 32→64의 단계적 실행, paid 200건 이상 안전 큐잉과 8→16의 단계적 실행이었다. 접수량과 실제 유료 provider 실행 동시성은 서로 다르다. 과거 600건 fake-provider 부하검사 통과가 실제 provider 600건 성공을 뜻하지 않는다. 새로 용량을 늘리기 전에 실사용 관측부터 확인한다.

실제 계정의 preflight→결제/분석→결과 성공은 에이전트가 실행하지 않았고 9월 16일 사용자에게 넘겼다. 이후 사용자가 실행했는지는 이번에 확인되지 않았다.

### B. 최신 운영 증거·활성화, cleanup/production 세션

**마지막 관측: 2026-09-16 08:07 KST.**

- PR #594 main: `41473184`; 검토 operator: `2486d831`.
- 정식 check/apply/독립 verify: 모두 exit 0, `VERIFIED_OK`.
- 웹: main source SHA, native READY, 공개 readiness HTTP 200/`ready=true`.
- 검증 worker artifact: **`b44f7180`**. main과 worker Git SHA가 다른 것은 이 보고서에서 의도적으로 구분돼 있다. 최신 main은 운영 도구/검사 변경이므로 “SHA 문자열이 다르다”만으로 worker를 재배포하지 않는다. 실제 artifact/source/build/runtime 관계를 검증한다.
- 접수 및 웹훅 자동 접수 활성화, 테스트 entitlement 플래그 복원.
- preflight/paid worker 모두 계획 revision 100%, generation 28/20.
- `analysis-preflight`, `analysis-v2-pipeline`: RUNNING.
- preflight/paid recovery scheduler: ENABLED.
- legacy `analysis-pipeline`, `analysis-v2`: PAUSED. retention scheduler: ENABLED 유지.
- 활성화 reservation 해제, 잔여 0.

PR #594 본문은 활성화 직전 VERIFIED 경계를 설명한다. **그 뒤 활성화까지 포함한 최종 외부 보고서가 더 최신 증거**다. 현재 열린 운영 상태에 옛 닫힌-state epoch를 다시 apply하지 않는다.

### C. 관리자 콘솔

`/admin/analysis-audit`와 관련 비공개 API, 주문/분석 감사, Apify inventory, landing lead projection, responsive/accessibility/loading/error/recovery 검증은 완료됐다. 대표 근거는 PR #546·#552와 `docs/reports/2026-09-11-preflight-admin-final-gap-audit.md`다.

남은 경계는 **실제 allowlisted 운영자 계정으로 현행 데이터를 조회하는지**다. 이것은 대시보드 재구축 작업이 아니다. 결과를 보며 필요한 문제만 수정한다.

### D. 코드·DB 경량화 및 22-table 설계

9월 15일 PR #589에서 테스트를 기능별 `tests/`로 정리했고 기본 CI를 타입체크 중심으로 줄였다. PR #590에서는 optional execution/progress shadow만 제거했다. 실제 V2 DAG·checkpoint·dispatch는 보존했다.

당시 원격 migration `20260915060416_retire_optional_analysis_execution_shadow.sql` 적용과 history 검증을 완료했다. public base tables 152→150, routines 815→802, history 391→392였다. **재적용하거나 테이블을 22개로 강제 축소하지 않는다.**

9월 15일 백업은 public schema/data + custom roles이고 실제 격리 복원 검증이 끝났다. Auth 관리 데이터와 Storage 실제 객체까지 포함한 전체 프로젝트 백업은 아니다. 프로젝트 초기화 근거로 쓰지 않는다.

### E. Vertex 비용 최적화

9월 4일 고유 handoff에 따르면 v2.12 구현은 존재하지만 일반 production 승격은 보류였다. 당시 rollout은 `test_entitlement`, deterministic gate의 blocker는 `VERTEX_AI_HIGH_RISK_RECALL_EVIDENCE_UNVERIFIED`였다. fixture의 0.97 recall을 실제 retained quality 증거로 인정하지 않았다.

당시 모델 비용은 baseline 146.801862달러, proposed 56.801862달러, 절감 61.307124%였다. 이는 모델링 결과이며 실제 10월 청구액이 아니다. **9월 16일 일반 운영 활성화와 Vertex 품질 gate 통과는 서로 다른 사건이다.** 최신 main/보고서에서 이 품질 gate가 해소됐다는 근거는 이번 조사에서 찾지 못했다.

9월 4일 migration 조회 오류와 worker SHA drift는 이후의 9월 16일 운영 완료 증거와 함께 재평가해야 한다. 별도 `20260904090000` 파일을 과거 계획에 적혀 있다는 이유로 만들어서는 안 된다. 당시 문서에 기록된 인증정보 후속 조치도 완료 기록이 확인되지 않았으므로, 관련 배포를 재개한다면 owner의 처리 여부를 확인한다. 비밀값 자체는 조회·기록하지 않는다.

### F. Docker 디스크 감사

cormorant의 Claude 터미널 작업은 **읽기 전용 감사 완료**다. 당시 Docker 약 60GB 중 이 저장소의 몫은 1% 미만으로 판단했고, 다른 프로젝트의 volume/cache가 대부분이었다. Docker가 꺼져 있어 정확한 live 크기 측정은 하지 않았다. 이 수치는 9월 초의 과거 관측이다.

이번 워크트리 정리는 Docker 정리 요청이 아니다. Docker 실행·prune·volume 삭제로 이어가지 않는다. 현재 세션을 “미완료 코드 구현”으로 다시 시작할 필요가 없다.

## 5. 새 세션에서 이어갈 통합 작업 목록

### P0. 정리 후 canonical 경로 계약 정비

**새로 확인한 실제 재개 장애다. 운영 CLI를 실행하기 전에 처리한다.**

- 최신 main의 `AGENTS.md`와 `docs/analysis-v2-production-operations.md`에는 여전히 `.worktrees/final-main-20260725`가 canonical이라고 적혀 있다.
- `scripts/capacity-identity-epoch/owner-production.ts`의 `primaryRepositoryRoot()`도 그 경로를 고정 사용한다. 현재 조사 기준 약 254~275행.
- `tests/infra/tools/capacity-identity-epoch/owner-production.test.ts`에도 해당 경로 전제가 있다.
- 이 함수는 `lstat`로 실제 디렉터리/owner/쓰기 권한을 검증한다. **단순 symlink로 옛 경로를 위장하면 통과하지 않는다.** 이번 정리에서는 가짜 canonical checkout/alias를 만들지 않는다.

해야 할 최소 변경:

1. Git common dir에서 구한 primary root, 즉 유일한 main checkout을 owner workdir로 검증하도록 scoped 수정한다.
2. 동일 repository/owner/권한 검사와 linked project 검증을 유지한다. feature worktree의 환경이나 연결로 자동 fallback하지 않는다.
3. root `supabase/.temp/`와 `.vercel/`의 기존 연결이 올바른지 안전하게 확인한다. 예전 canonical의 원본은 `worktrees/final-main-20260725/`에 보존된다. 연결값을 출력하거나 무조건 덮어쓰지 않는다.
4. AGENTS의 canonical 경로와 한국어 응답 규칙, 운영 문서, 기존 관련 테스트를 함께 정비한다.
5. 해당 기존 owner-production 검사와 타입체크로 검증한다. 순수 Git 정리 작업에서 production 코드를 임의 변경하지 않기 위해 이 수정은 새 워크트리의 후속 항목으로 남겼다.

완료 기준: linked feature worktree에서도 owner workdir가 실제 root main으로 해석되고, 다른 repo/잘못된 owner/부적절한 권한은 계속 거부되며, 운영 인증정보를 출력하지 않는다.

### P1. 현행 운영 상태를 다시 관측하고 실제 사용자 테스트 결과 확인

1. 최신 remote main, 웹 배포 source, worker의 승인된 artifact와 traffic, 두 운영 큐/recovery/retention 상태를 읽기 전용으로 관측한다.
2. 9월 16일 활성화 이후 source/config drift가 있는지 분류한다. 옛 PAUSED 상태로 되돌리거나 종료된 epoch를 재적용하지 않는다.
3. 사용자에게 9월 16일 이후 실제 계정 테스트를 했는지, 결과가 어땠는지 확인한다. 기존 결과가 있다면 그 구간의 안전한 집계/오류 분류부터 본다.
4. 아직 테스트하지 않았다면 사용자가 테스트할 경로와 관측 항목을 준비한다. 이 체크아웃은 에이전트의 실제 분석/결제/provider 실행을 요청한 문서가 아니다.
5. 운영자 계정의 콘솔 조회도 확인한다. 기존 콘솔을 재구축하지 않는다.

완료 기준: 관측 시각과 source/artifact 관계가 명시된 현행 상태, 실제 테스트의 성공/실패 근거, 남아 있는 구체적 오류가 구분된다. 문제가 없으면 추가 코드/DB 변경을 만들지 않는다.

### P1. Vertex 품질 gate와 승격 결정

1. 현재 rollout과 budget guard의 의미를 읽기 전용으로 확인한다. 당시의 `test_entitlement` 값을 현행값으로 단정하지 않는다.
2. 기존 `cost:vertex-ai:gate`와 관련 retained/replay 증거 경로를 확인한다. 합법적으로 확보된 실제 label/evidence와 fixture를 구분한다.
3. 실제 high-risk recall, route/unknown-usage, 최소 절감률 기준을 통과할 때만 승격 근거를 만든다. 실제 증거가 없으면 “품질 증거 대기”가 올바른 종료 상태다.
4. 필요한 migration/source/build provenance를 현재 기준으로 확인한 뒤에만 제한된 rollout/rollback 절차를 다룬다. 오래된 handoff의 배포 명령을 그대로 재실행하지 않는다.

완료 기준: 실제 품질 근거가 있는 gate PASS와 검토된 승격 계획, 또는 충족되지 않은 근거가 정확히 명시된 보류. 일반 운영 성공으로 대체할 수 없다.

### P2. migration provenance 6대6 불일치 정렬

9월 16일 최종 보고 기준 local/remote count는 각각 392였지만 집합은 6개씩 달랐다. 동일 count는 동일 history가 아니다. 이번 세션에서는 원격 history를 다시 조회하지 않았다.

remote-only로 기록된 버전:

| 버전 | 원본 복구 근거 |
| --- | --- |
| `20260814110000` | authenticated remote statement array의 정확한 원본 |
| `20260814111000` | authenticated remote statement array의 정확한 원본 |
| `20260823165841` | 비-main commit `9fc65c76` |
| `20260824151600` | 비-main commit `9042120d` |
| `20260824152500` | 비-main commit `6bdb5149` |
| `20260824160500` | 비-main commit `0c52c100` |

네 커밋은 10월 3일 로컬 object 존재를 확인했고 archive ref와 bundle에 별도 보존한다. SQL 내용을 이 문서에 넣지 않는다.

local-only로 기록된 버전: `20260805001619`, `20260805014000`, `20260805023000`, `20260805025000`, `20260805050000`, `20260813233000`.

순서:

1. 기존 `RESTORE-PROVENANCE-REVIEW.md`와 source package를 먼저 읽는다.
2. 현행 authenticated history와 원본의 statement count/length/hash/byte equivalence를 검증한다.
3. local-only 6개가 현재 routine/signature/ACL/search_path/constraint/dependency와 동등한지 각각 확인한다.
4. 증거가 다 모였을 때만 로컬 source-package 정렬안을 검토한다. placeholder, historical SQL 내용 변조, 임의 `migration repair`, `--include-all`로 덮지 않는다.
5. 격리 workdir의 정확한 version-set parity와 zero-pending dry-run을 확인한다. 이는 추가 DDL과 별도 작업이다.

완료 기준: 모든 원본의 검증 가능한 provenance와 집합 일치, 또는 이유가 명확한 `BLOCKED_NO_CHANGE`. 현재 정상 운영을 위해 이 부채를 억지로 해소할 필요는 없었다.

### P3. 조건부 DB 축소 및 오래된 로컬 대안 정리

- replay-capture 3개 테이블: 9월 13일에는 routine/FK 의존성 때문에 blocked였다. 새 관측 없이 drop하지 않는다.
- V1 `analysis_provider_runs`, interaction 3개: 실제 start/step/status/terminal 처리 관계와 producer drain을 먼저 증명한다.
- `account_lifecycle`: optional mirror지만 계정 삭제 fail-closed 경계와 연결된다.
- `payment_events`: webhook mirror가 남아 있다. mirror가 비어 보인다고 `payment_pending`을 변경하지 않는다.
- 9월 15일 bounded audit에는 추가 즉시 DROP 가능한 후보가 없었다. 150개가 모두 필수라는 증명도 아니었다.
- 미병합 production-unblock 3개 커밋, orphan 파일, 기존 7월 stash는 필요할 때만 최소 diff를 검토한다. 새 장애가 없으면 “보존된 대안/역사”로 두어도 된다.

완료 기준: 실제 이득과 의존성/보존/복원 증거가 있는 최소 작업만 수행한다. 임의 테이블 수 목표나 옛 미체크 checklist 전체를 백로그로 복원하지 않는다.

## 6. 보존본 구성과 복구

| 항목 | 보존 내용 |
| --- | --- |
| `CHECKOUT.ko.md` | 이 통합 인계 문서 |
| `inventory-before.json` | 원래 7개 worktree/10개 branch/2개 stash와 보호파일 상태 |
| `repository.bundle`, `bundle-manifest.json` | 전체 refs + archive refs, 검증 결과와 SHA-256 |
| `patches/<label>/unstaged.patch`, `staged.patch` | worktree별 변경 패치; 빈 파일은 해당 diff 없음 |
| `primary-tracked/` | root main의 원래 수정 파일 2개 |
| `primary-untracked/` | root scratch와 checkout 밖 `.orca` orphan 원본 |
| `worktrees/<label>/` | 제거 대상 6개 checkout의 원본 파일 전체, ignored 파일 포함, `.git` 제외 |
| `receipts/<label>.json` | 파일 이동 전후 inode/size/mode/mtime 목록의 동일성 검증과 보호 migration hash |
| `verification-final.json` | 최종 main 일치, worktree 1개, 원본/보호파일 보존 검증 |

보존본은 owner-only 디렉터리에 두고, 설정·비추적 파일은 내용을 출력하지 않고 같은 파일시스템에서 원본을 이동한다. 의존성 폴더도 보존하므로 **이번 작업의 목적은 활성 워크트리 정리이며 디스크 확보량은 보장하지 않는다.** 보존한 node_modules나 절대경로 symlink를 새 작업의 실행 환경으로 재사용하지 말고 새 worktree에서 lockfile 기준으로 설치한다.

archive ref namespace: `refs/archive/worktree-cleanup-20261003/`.

- `worktrees/<label>`: 원래 HEAD.
- `branches/<기존 브랜치 이름>`: 원래 로컬 branch tips. 기존 branch 이름도 유지한다.
- `stashes/original-0`, `stashes/original-1`: 기존 stash 전체 SHA 보존.
- `stashes/primary-20261003`: 이번 main 동기화 전에 보존한 scoped stash.
- `provenance/<short-sha>`: DB 원본 복구에 필요한 네 커밋.

기존 stash:

- `de63fd30af792dc73324baacea05c58a1e58ccc8`: 7월 27일 frontend 결과/owner-view presentation 변경, 4개 파일.
- `b2ed2e5a030ef4ece54be9b645fd8dc2cd32d671`: 같은 날 package-lock 변경, 1개 파일.

이번 root main scoped stash는 `e7ec899cca33f2fcd3fb8981e9933d0214e1ca12`이며 AGENTS와 admin page만 담는다. 기존 stash 2개와 함께 그대로 유지했다.

둘 모두 이번 정리 이전부터 있었다. main에 모두 적용됐는지 기능 수준으로 검증하지 않았으며, **자동 pop하지 않았다.** 날짜가 오래된 결과 UI와 lockfile을 최신 main에 통째 적용하지 않는다.

확인 명령 예시:

```sh
git bundle verify /Users/youngminpark/.backups/yeosachin_scanner/worktree-cleanup/20261003-consolidated/repository.bundle
git show refs/archive/worktree-cleanup-20261003/worktrees/production-unblock-minimal-20260914
git diff refs/archive/worktree-cleanup-20261003/stashes/primary-20261003^1 refs/archive/worktree-cleanup-20261003/stashes/primary-20261003 -- AGENTS.md
```

복구가 필요할 때는 새 worktree에서 해당 커밋/파일만 검토한다. source root나 main을 과거 snapshot으로 덮지 않는다. Git 저장소 자체를 잃었을 때도 bundle로 별도 복원할 수 있지만, env/설정/비추적 파일은 bundle이 아니라 위 파일 보존본에 있다는 차이를 기억한다.

## 7. 새 워크트리 시작 방법

**사용자의 10월 3일 추가 지시: 새 변경을 main에 올릴 때는 반드시 PR을 생성하고 검증한 뒤 병합한다.** 직접 main push로 반영하지 않는다. 이번 정리의 local fast-forward는 이미 PR로 병합된 origin/main을 가져오는 작업이며 새 변경의 원격 반영이 아니다.

**후속 실행 환경은 Orca가 아니라 Codex 앱이다.** 이 문서의 Orca 명칭·터미널 handle·카드 상태는 과거 조사 근거일 뿐이다. 새 세션을 위해 Orca를 실행하거나 `orca worktree create`, Orca orchestration task/worker/terminal 명령을 사용하지 않는다. 과거 문서의 특정 Orca 모델·effort·visible-worker 지시는 이번 사용자 지시로 대체한다.

현재 main의 로컬 `.env.local`, `.playwright-mcp/`, 보호 migration은 제자리에 남긴다. 보호 `.playwright-mcp/` 때문에 `git status`에 비추적 항목이 남을 수 있다. tracked diff와 main/origin/main 동기화 여부는 따로 확인한다.

```sh
cd /Users/youngminpark/Desktop/개발/yeosachin_scanner
git fetch origin
git status --short --branch
git rev-parse HEAD origin/main
git worktree list
```

Codex 앱에서 이 저장소를 선택하고 최신 main 기준의 새 worktree를 만든다. 실제 생성 경로·브랜치는 앱이 선택한 값을 사용한다. 이 정리 세션에서는 새로운 feature worktree를 미리 만들지 않는다. 생성 후 상위 세션이 다음을 확인한다.

```sh
git rev-parse --show-toplevel
git rev-parse --path-format=absolute --git-common-dir
git branch --show-current
git status --short --branch
git rev-parse HEAD origin/main
```

새 worktree의 Git common dir이 기존 저장소의 `.git`인지 확인하고, main 직접 작업이 아닌지 확인한다. 환경·프로젝트 연결은 기존 root main을 owner 기준으로 검증하며 feature 환경을 운영 환경으로 오인하지 않는다. 의존성은 새 worktree의 lockfile 기준으로 설치한다.

테스트 위치의 진실은 최신 `tests/README.md`다. 옛 브랜치의 runtime 옆 테스트 경로를 되살리지 않는다. 첫 코드 변경에는 해당 기존 검사와 `npx tsc --noEmit --pretty false`를 사용한다. 전체 테스트·DB·배포를 일괄 재실행하지 않는다.

새 세션에 전달할 요청문:

> `docs/operations/2026-10-03-consolidated-checkout.ko.md`와 `verification-final.json`을 읽고, Codex 앱의 최신 origin/main 기반 새 워크트리에서 모든 미완료 작업을 종합적으로 이어서 진행해줘. 이 상위 세션은 orchestration을 맡고 작업별로 Codex 서브 에이전트를 사용해줘. Orca를 실행하거나 Orca task/worker/terminal에 의존하지 마. 문서의 W00~W08을 누락 없이 관리하되 이미 완료된 작업을 다시 구현하지 마. 먼저 제거된 옛 canonical 경로를 사용하는 owner CLI·AGENTS·운영 문서를 실제 root main 기준으로 최소 정비하고, 현행 운영/실제 사용자 테스트, Vertex 품질 gate, migration 6대6 provenance 부채와 조건부 후속을 선행 관계에 맞춰 진행해줘. 9월 16일에는 VERIFIED와 운영 활성화까지 완료됐지만 현재 상태는 새로 확인해야 해. 보존된 unmerged 브랜치·stash를 자동 통합하거나 22-table 목표를 되살리지 마. 실제 계정 분석은 사용자 실행 경계를 유지하고 토큰·쿠키·DB 비밀번호·사용자 UUID를 출력/기록하지 마. 새 변경은 관련 기존 검사와 독립 리뷰를 거쳐 PR 생성·검증·병합으로 main에 반영해줘. 한국어로 진행하고 승인용 영어 문서에는 전체 내용을 보존한 `.ko` 사본을 함께 만들어줘. 실행 가능한 작업은 끝까지 진행하고 근거 부족으로 막힌 작업은 필요한 증거와 재개 조건을 명시해줘.

### 7.1 상위 orchestration 세션의 책임

- 시작 직후 아래 모든 workstream을 상태판에 등록한다. 상태는 `미착수 / 진행 / 검토 / PR / 병합완료 / 근거대기 / 불필요확정`으로 관리하고, 각 상태에 근거·다음 행동·담당 agent를 붙인다.
- Codex의 해당 세션에 제공되는 서브 에이전트 기능으로 작업자를 만든다. 도구 이름이나 지원되지 않는 역할/모델을 임의로 가정하지 않는다. 기능이 없다면 사용자에게 제약을 알리고 작업을 잊어버리지 않는다.
- 각 서브 에이전트에는 최신 base SHA, 독점 편집 범위, 읽기 전용 범위, 입력 근거, 완료 기준, 검증 명령, 동료 수정 보존 규칙을 전달한다. 전체 저장소의 오래된 문서를 무차별 읽도록 시키지 않는다.
- 같은 `owner-production.ts`, `AGENTS.md`, 운영 문서, package lock, migration 목록을 여러 작업자가 동시에 수정하지 않는다. 공유 파일의 통합 책임은 상위 세션 또는 명시된 단일 담당자에게 둔다.
- 서로 독립적인 읽기 전용 조사부터 병렬로 진행하고, code/DB/운영 변경은 의존성에 따라 순서화한다. 공유 worktree를 쓰는 subagent라면 파일 소유권을 분리하고, 추가 격리가 필요하면 Codex/Git 환경에서만 분리한다.
- 작업자가 구현한 diff는 다른 agent가 검토한다. 완료 보고에는 변경 목적, 파일/commit, 실행한 검사 결과, 미검증 경계, 다음 의존성이 있어야 한다.
- 변경 필요성이 없는 조사에도 결과를 남긴다. 검증된 완료 작업, 근거가 부족한 작업, 실제 구현이 필요한 작업을 혼합하지 않는다.
- 기능별 작은 PR로 올리고 관련 검사/리뷰를 통과시킨 뒤 병합한다. remote main fetch와 local fast-forward로 마감한다. 보존본 원본을 수정하거나 archive refs를 제거하지 않는다.

### 7.2 작업별 서브 에이전트 배분표

| ID / 담당 | 범위와 산출물 | 선행 조건 | 완료 판정 |
| --- | --- | --- | --- |
| **W00: 인계·유실 여부 검토** | 이 인계, manifest, 실제 미반영 3개 커밋, orphan 파일, 2개 기존 stash를 대조. 원본은 read-only. 필요한 변경/이미 대체됨/근거대기를 각각 분류 | 새 worktree 생성 | 모든 보존 변경에 처리 방향이 있음. 자동 cherry-pick/pop 없음 |
| **W01: canonical owner 경로 정비** | P0의 owner-production resolver와 해당 기존 검사. AGENTS/운영 문서의 canonical·한국어·PR 규칙은 상위 세션과 단일 담당으로 통합 | 초기 SHA·root 확인 | 보안 경계 유지, root main 해석, 관련 검사·타입체크, 독립 리뷰, PR 병합 |
| **W02: 현행 운영 증거 갱신** | 웹/worker source·artifact·traffic, queue/scheduler, admission, 오래된 receipt와 차이의 안전한 보고서. 관측은 읽기 전용 | owner CLI 사용 구간은 W01 이후. Git/문서 조사는 즉시 가능 | 관측일이 있는 현재 상태와 drift 원인. 9월 수치를 현재값으로 재사용하지 않음 |
| **W03: 사용자 경로·관리자 확인** | 실제 테스트 여부/결과 확인은 상위 세션이 사용자와 조율. 작업자는 preflight/결과·admin 관측 준비와 확인된 장애의 최소 수정. 담당 구현/기존 tests 범위를 명시 | W02, 유효한 인증/사용자 테스트 결과 | 실제 성공 근거 또는 재현 가능한 오류·최소 수정. 에이전트의 임의 결제/실계정 실행 없음 |
| **W04: Vertex 품질·비용 승격** | 현재 rollout, 기존 gate, retained label/evidence와 fixture 구분. 필요한 최소 코드·검사 또는 정확한 blocker. W02의 artifact 근거 재사용 | 로컬 gate 조사는 즉시 가능. 운영 결론은 W02 이후 | 실제 품질 증거로 판정. 일반 운영 활성화와 최적화 승격 구분 |
| **W05: migration 원본·동등성** | 6 remote-only 원본, 6 local-only 현행 동등성, existing source package/복원 근거. history 수리/DDL은 수행하지 않는 provenance 작업 | 과거 source 조사는 즉시 가능. linked 조회는 W01 이후 | 정확한 원본/집합 일치 계획과 dry-run 근거 또는 BLOCKED_NO_CHANGE. 필요 code/source PR 분리 |
| **W06: 조건부 DB 후보** | replay-capture/V1 provider/interaction/lifecycle/payment 후보의 현행 reader/writer·retention·복원·의존성. 현재 DROP-ready 목록이 없을 수 있음 | 최종 결론은 W05 및 fresh runtime/catalog 근거 이후 | 최소 이득과 안전한 allowlist 또는 불필요/근거대기. 22-table 강제 목표 없음 |
| **W07: 용량 확장 후속 판정** | 400 접수·preflight 32→64·paid 200 큐잉/8→16의 기존 구현과 실제 초기 운영 지표를 비교. 필요 시 기존 fake-provider 검사와 단계별 확대 근거 | W02/W03. provider 비용 영향은 W04와 조율 | 실제 확장이 필요한지 근거 기반 결정. 기존 capacity 기능 중복 구현이나 자동 유료 부하 없음 |
| **W08: 독립 검토·통합 검증** | 각 구현 agent와 다른 agent가 diff/요구사항/기존 검사/운영 경계를 검토. 전체 작업의 누락 및 종료 기준 재확인 | 각 workstream의 리뷰 가능한 산출물 | 모든 ID에 완료 또는 명시적 blocker, PR/merge SHA와 검사 근거가 있음 |

### 7.3 권장 실행 순서와 중단 없는 진행

1. 상위 세션이 최신 main과 보존 검증 파일을 확인한다. W00, W01, W04의 로컬 증거 조사, W05의 기존 provenance 조사를 서로 충돌하지 않게 시작한다.
2. W01을 W08이 검토하고 PR로 병합한다. 새 worktree의 base/작업 상태를 안전하게 갱신한다.
3. W02가 현행 운영 상태를 확인하는 동안 W04/W05는 provider/DB mutation 없는 증거 작업을 계속한다.
4. 상위 세션이 사용자 테스트의 기실행 여부를 확인한다. W03과 W07은 W02 결과와 실제 테스트 근거를 공유한다. 사용자 답변이 필요한 구간 때문에 독립적인 W04/W05 작업을 중단하지 않는다.
5. 확인된 실제 오류만 관련 작업자에게 최소 수정으로 맡기고 W08 리뷰→관련 검사→PR 병합으로 마무리한다.
6. W05의 provenance가 충족됐을 때 W06을 구체화한다. 불충족이면 W06을 원인과 함께 근거대기로 표시한다. 증거 없이 DDL을 만들지 않는다.
7. 모든 workstream의 완료/근거대기/불필요확정을 기록한다. 사용자 테스트나 실측 label 부재는 구현 완료로 바꾸지 않는다. 남은 항목에 필요한 입력과 재개 절차를 명시한다.

이 배분표는 새 세션이 수행할 오케스트레이션 지침이다. 이번 정리 세션에서 W01 이후 구현·운영·DB 작업을 실행한 것으로 해석하지 않는다.

## 8. 꼭 읽을 외부 근거

아래 경로는 이번 worktree 정리 대상 밖에 있으며 그대로 유지한다.

1. `/Users/youngminpark/.gstack/projects/0mininseoul-yeosachin-scanner/checkpoints/20260916-0808-production-ready-checkout.md`
2. `/Users/youngminpark/.gstack/projects/0mininseoul-yeosachin-scanner/reports/20260915-production-evidence-followup/activation-status.ko.md`
3. 같은 폴더의 `activation-epoch-verified-safe.json`, `activation-production-open-safe.json`, `activation-main-production-ready-safe.json`.
4. `/Users/youngminpark/.gstack/projects/0mininseoul-yeosachin-scanner/checkpoints/20260915-1610-code-db-cleanup-checkout.md`
5. `/Users/youngminpark/.gstack/projects/0mininseoul-yeosachin-scanner/reports/20260915-cleanup-review/canonical-shadow-retirement-completed.md`, `additional-db-candidates.md`, `git-cleanup-completed.md`.
6. `/Users/youngminpark/.backups/yeosachin_scanner/supabase/20260915-pre-contraction/RESTORE-PROVENANCE-REVIEW.md`와 owner-only source package. DB dump/원시 행은 채팅이나 문서에 출력하지 않는다.
7. `/Users/youngminpark/.backups/yeosachin_scanner/worktree-cleanup/20260915-urYW5t`: 이전 정리 보존본.

## 9. 이번 정리의 수용 기준

- 상세 한국어 인계와 복구 자료가 제거보다 먼저 존재한다.
- 7개 초기 Git worktree 중 root main만 활성 등록으로 남는다. Orca에서도 삭제한 카드/터미널이 남지 않는다.
- 6개 원본 checkout, tracked/untracked/ignored 파일과 고유 미병합 커밋이 복구 가능하다.
- protected migration은 root와 보존본 모두 원래 opaque hash가 같고, root `.playwright-mcp/`와 `.env.local` 원본은 유지된다.
- 기존 branch tips와 stash를 잃지 않는다. 새 feature commit, 강제 reset, remote push/branch 삭제를 하지 않는다.
- root main은 원격 main으로 fast-forward되고 tracked/staged diff가 없다. 보호된 비추적 경로는 삭제하지 않는다.
- Supabase/배포/queue/scheduler/provider/결제 등 운영 상태는 이번 정리로 변경하지 않는다.
- 실제 제거 결과와 최신 SHA는 마지막 검증 파일로 확인하고 이 문서의 실행 상태를 갱신한다.

### 실행 결과

- Git worktree **7→1**, Orca 표시 worktree **5→1**. root main만 유지한다.
- Orca 관리 대상 4개는 native 제거, Git에만 등록됐던 2개는 정확한 경로의 Git 제거로 해제했다. 모든 파일을 검증된 보존 위치로 먼저 옮겨 원래 경로에 `.git` 포인터만 남긴 후 제거했으며, 보호 파일을 삭제한 것은 아니다.
- 보존본 6개의 항목 수는 각각 63,955 / 63,853 / 2,174 / 2,283 / 2,456 / 2,588이며 이동 전후 inode·size·mode·mtime 목록의 digest가 일치했다.
- root main **`c07e3c0a`→`41473184`**, 367개 커밋 fast-forward. tracked/staged diff 없음. 의도적으로 남긴 비추적 경로는 `.playwright-mcp/`뿐이다.
- 원래 로컬 branch 10개와 기존 stash 2개를 유지했다. 이번 scoped stash 1개가 추가됐다. 원격 branch/tag를 삭제하거나 미완료 코드를 push하지 않았다.
- `repository.bundle` 크기 18,241,445 bytes, Git bundle verify와 SHA-256 재검증 통과. checkout 원본은 별도 파일 보존본에 있다.
- cormorant 과거 터미널 2개 종료 확인. cleanup shell bulk close는 한 번 `terminal_close_incomplete`를 반환했으므로 성공으로 간주하지 않았고, 동일 host의 개별 handle close 결과 `ptyKilled=true`, native 목록 0개 및 해당 OS PID 부재로 종료를 재확인했다. main 세션은 유지했다.
- 이번 검증은 Git/파일/보존 검증이다. 제품 코드 변경이 없으므로 앱 전체 테스트·빌드·운영 테스트를 새로 실행하지 않았다.
