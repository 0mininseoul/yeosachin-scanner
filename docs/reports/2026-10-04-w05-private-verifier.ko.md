# 2026-10-04 W05 비공개 원본 검증 도구와 W08 통합 기록

판정: **W05 검증 도구·실제 제한 검증 완료, W08 명세·품질 및 로컬 회귀 PASS**. PR 검사·병합·main 동기화는 이 변경의 GitHub 최종 기록과 종료 보고로 확인한다. 사용자가 10월4일 한국어 설계를 승인했고, 최신 fetch에서 root main/origin/main이 `a46a0e1ba5fc4d5379de510c48ed3116e5a3d4b9`임을 확인했다. 기존 Codex 관리 worktree의 `codex/private-migration-verifier-20261004`에서 구현했다. 사용자 테스트는 제외하며 Apify API/actor·AI generation 호출은0회다.

## 변경과 보존 경계

새 `scripts/verify-supabase-private-source.ts`는 엄격한 두 실행 모드와 안전 DTO만 제공한다. `scripts/supabase-private-source.ts`가 기존 owner root resolver를 재사용해 Git common dir의 부모 main, source/Git attestation, root 연결/인증, 고정 조회·dry-run·임시 symlink 수명을 검증한다. 기존 owner2.102.0 계약과 앱·DB·package·lock·마케팅 카피는 변경하지 않는다.

manifest는 저장소 밖에 새 metadata만 생성했다. local392, excluded6, private6, effective386+6=392이며 base Git blob·실제 root source·기존 private 원본 byte SHA와 검토된 count/length/MD5를 고정했다. manifest SHA-256은 `00961231f0b042b3a9003028640a8ddd8fbc838e93363c41d90690815cd481e6`, 95,065bytes, parent700/file600이다. 기존392 local과6 private 원본을 다시 저장하지 않았고 SQL·환경 복사본은0개다.

6대6 source/history 차이를 임의 정렬·삭제·repair하지 않는다. 현재 함수 효과 대조는 [10월3일 provenance 조사](./2026-10-03-w05-w06-provenance.ko.md)의 근거이며 이번 도구가 최신 함수 본문이나 사용자 행을 다시 조회한 것은 아니다. 빈 DB bootstrap·실제 migration apply·전체 복원·DROP 권한도 검증 결과에 포함하지 않는다.

## 실제 제한 실행

| 실행 | Asia/Seoul 관측 | 결과 |
| --- | --- | --- |
| local-only | 04:52:13 | local392/private6·hash match·원본 불변·cleanup PASS, remote/parity/planned count는null |
| 최초 native 설치 preflight | 04:52:20 | `CLI_UNAVAILABLE`, CLI version/원격 단계 진입 전 중단, 원본 불변·cleanup PASS |
| 검토 후 제한 원격 검증 | 05:27:36 실행 시작 | CLI2.114.0·local392/private6/remote392·hash/parity PASS·planned0·원본 불변·cleanup PASS |

[local-only DTO](./2026-10-04-w05-private-local-only.safe.json)와 [최초 preflight 실패 DTO](./2026-10-04-w05-private-cli-preflight.safe.json) [최종 dry-run DTO](./2026-10-04-w05-private-dry-run.safe.json)를 별도 보존했다. 각 DTO의 `observedAt`은 실행 시작시각이다. 실패는 성공으로 치환하지 않는다. 최초 중단 뒤 원격 조회를 반복한 것이 아니며 그 시점의 원격 호출은0이다.

표준 Homebrew `bin`·`Cellar`의 실제 같은 owner·admin gid80·0775 권한을 확인해 native executable ancestor의 정확한 두 경로만 허용한다. symlink 최종 regular/owner·no022·실행 권한·identity는 각 child 전에 재검증한다. 입력 source/manifest/env 정책과 원본·설치 파일 권한을 바꾸지 않는다.

CLI가 자신의 parent700 임시 `.temp`에 생성하는 optional `linked-project.json`만 strict4key/root-ref metadata로 검증한다. 기존 실제 관측과 [CLI2.114.0 공식 source](https://github.com/supabase/cli/blob/v2.114.0/apps/cli-go/internal/telemetry/project.go)의 형식에 따른다. cache를 연결 근거나 공개 DTO로 사용하지 않으며 다른 파일·unknown/duplicate key·오염·ref drift·unsafe mode·symlink는 거절한다.

기존 CLI telemetry의 owner 식별자가 재직렬화되는 것을 피하기 위해 fixed opt-out과 임시 CLI state/cwd를 함께 사용한다. [공식 상태 구현](https://github.com/supabase/cli/blob/v2.114.0/apps/cli/src/legacy/telemetry/legacy-telemetry-state.layer.ts)과 [인증 구현](https://github.com/supabase/cli/blob/v2.114.0/apps/cli/src/legacy/auth/legacy-credentials.layer.ts)을 독립 확인했다. HOME/owner Keychain은 유지하고 explicit Supabase profile과 root-env memory token을 사용한다. 새 임시 anonymous state 본문은 도구에서 열거나 읽거나 공개하지 않는다. 최종 state 허용 집합은 빈 디렉터리 또는1KiB 이하 `telemetry.json` 정규 파일 하나이며 lstat metadata·owner/no022·디렉터리 identity로 검증한다.

## 편집권·검사·독립 리뷰

- 구현자 `w05_verifier_impl`: core/entrypoint/grouped tests만 편집했다. 구현자와 다른 `w05_spec_review`가 명세를 검토했다. 입력의 sticky ancestor 예외를 root-owned1777의 정확한 `/tmp`·`/private/tmp`로 좁힌 뒤 명세 PASS를 받았다.
- 독립 `w05_quality_review`: 직계 child만 종료하던 P2를 재현했다. 전용 POSIX group SIGKILL 및 그룹 ESRCH·leader·양 pipe close 확인 후 원본 검사·cleanup으로 수정해 재검토 PASS를 받았다. 종료 불확립은 `CHILD_TERMINATION_UNCONFIRMED`, 원본 불변/cleanup false·planned null·정리 생략이다. timeout/outputcap/nonzero-exit 실제 fake 후손 PID 종료를 검사한다.
- 같은 품질 리뷰어가 정상 query 후 CLI-generated cache 때문에 pre-push 검사가 중단되는 P2도 fake로 확인했다. 또한 설치된 Bun CLI의 [공식 query JSON 계약](https://github.com/supabase/cli/blob/v2.114.0/apps/cli/src/legacy/commands/db/query/query.format.ts)을 확인해 고정 `--agent=no`·strict barearray로 수정했다. 정상 cache 전환과 wrapper/행 오염 거절을 검사하고 최종 독립 재검토 PASS를 받았다.
- 상위 세션: 계획·운영 안내·상태판·`tests/README.md`·이 보고서와 안전 receipt를 편집한다. source 조사자는 private metadata manifest만 새로 만들었다. 서로 다른 소유 파일을 편집하며 동료 변경을 되돌리지 않았다.

최종 core 보완 commit은 `20703f42`다. 구현자 신규159/159, 상위 신규159+기존owner35=194/194, 독립 품질 리뷰어 같은194/194 PASS이며 상위·구현자·명세 리뷰어의 타입체크(`--incremental false`)도 exit0다. 명세 및 품질 최종 PASS, 남은 actionable finding은 없다. 상위 작성 문서·receipt는 다른 `w05_spec_review`의 최종 독립 통합 리뷰 PASS다. 호출 예시·순서 P3를 정정했고 safeJSON3의13필드/KST·산술·로컬 링크22개·민감값 부재·공백 검사를 통과했다. 사용자 분석·전체 앱 테스트·전체 migration/DB bootstrap을 실행하지 않는다. 관련 기본 CI와 Vercel preview도 정확한 PR head에서 확인한 뒤 병합한다.

실제 실행은 고정 metadata 조회 CLI1회와 `db push --dry-run --skip-vault` CLI1회다. 업무 행·SQL/함수 본문을 반환하지 않고 raw stdout/stderr·exception은 출력·파일에 남기지 않았다. 공식 제한 login-role 인증 준비 외 실제 apply·history repair·include-all·DDL·업무 데이터 변경은0이다. temporary symlink·비밀 없는 연결 metadata·격리 CLI state는 종료 확인 뒤 제거했다. 원본398개와 manifest/root 연결/사용한 환경은 tool의 전후 byte/hash/stat 검사 PASS다. 상위의 별도 보존 비교에서도 root 환경 stat·보호 migration hash·기존 refs/stash·`.playwright-mcp/` 유지가 모두true다. CLI 설치나 기존 권한도 변경하지 않았다.

## W00~W08 처리와 재개 조건

W00/W01/W02/W06/W07의 기존 불필요확정·병합 결과를 유지한다. W05는 승인된 비공개 source 접근·검증 도구를 마무리한다. W08은 구현자와 다른 명세·품질·문서 리뷰 및 관련 검사·PR 병합·최종 main 동기화로 관리한다.

W03은 사용자가 실제 분석과 allowlisted 관리자 확인 후 단계·시각·오류 코드만 공유할 때 재개한다. W04의 보존 비용 조사는 완료됐으나 실제 high-risk label·동일 cohort baseline/proposed·정책/가격 provenance 및 route mix/retry/unknown 집계가 없어 승격은 근거대기다. 사용자 실행·유료 호출을 이번 승인 범위에서 대신 시작하지 않는다. W06은 새 측정 이득 또는 기능 종료 목적, W07은 실제 상한 병목 근거가 있을 때만 재검토한다.

새 변경은 PR 생성→관련 검사와 독립 리뷰→main 병합으로 반영한다. 직접 main push는 없다. root main을 fetch/fast-forward하고 main/origin/main/원격 SHA·tracked clean, root 환경/보호 migration/기존refs·stash/`.playwright-mcp/` 보존을 확인한다. PR·병합·최종 동기화의 실행 결과는 GitHub PR와 종료 보고에 남긴다.
