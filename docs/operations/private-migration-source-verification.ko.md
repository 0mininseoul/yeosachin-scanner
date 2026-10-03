# 비공개 migration 원본 검증 운영 안내

이 도구는 저장소 밖에서 보존하는 정확한 여섯 원본을 복사하지 않고, 승인·검토된 metadata manifest와 저장소 source를 대조한다. 실제 저장소의 local-only/remote-only 6대6 차이는 유지한다. local-only 성공은 source·Git attestation의 검증이며 원격 상태는 미관측이다. dry-run 성공만 해당 manifest와 관측 시점의 원격에 pending migration이 없다는 뜻이며 빈 DB bootstrap·전체 프로젝트 복구·실제 migration 적용·history repair·DROP 허가가 아니다.

승인된 [설계](../superpowers/specs/2026-10-03-private-migration-verifier-design.ko.md)와 [구현 계획](../superpowers/plans/2026-10-04-private-migration-verifier.ko.md)을 함께 읽는다. 사용자는 2026-10-04 설계를 승인했다. 일반 검증 CLI는 설치 Supabase **2.114.0** 계약을 사용하며 기존 owner credential conduit의 **2.102.0** 계약은 바꾸지 않는다.

## 명령과 인증

```text
node --import tsx scripts/verify-supabase-private-source.ts verify --manifest <private metadata manifest> --local-only
node --import tsx scripts/verify-supabase-private-source.ts verify --manifest <private metadata manifest> --dry-run
node --import tsx scripts/verify-supabase-private-source.ts verify --manifest <private metadata manifest> --dry-run --auth=root-env
```

`--local-only`는 Supabase child 호출 없이 원본·source·Git attestation을 검증한다. root main은 Git common dir의 부모를 기존 owner resolver로 찾고 동일 저장소·main·owner·안전한 디렉터리 권한을 확인한다. 삭제된 canonical worktree를 다시 만들거나 feature 연결 설정을 대신 사용하지 않는다.

`--dry-run`의 기본 인증은 현재 owner의 Keychain CLI다. `--auth=root-env`는 root `.env.local`을 비실행 parser로 읽어 `SUPABASE_ACCESS_TOKEN` 한 값만 child 환경에 메모리로 전달한다. 이 옵션은 dry-run에만 허용한다. token·환경 파일·Authorization 헤더는 argv·임시 파일·stdout/stderr·문서에 남기지 않는다. 환경 파일을 `source`하지 않는다.

일반 조회와 dry-run 모두 root의 linked project-ref와 비밀번호 없는 공식 pooler metadata 및 같은 Supabase origin을 확인한다. root `.env.local`·연결 설정의 권한을 바꾸거나 초기화하지 않는다. 인증 실패나 지원 버전 차이를 feature 환경·connector·비밀번호 URL로 우회하지 않는다.

설치 실행 파일은 Homebrew symlink chain과 최종 regular file의 owner(0 또는 실행 uid)·group/other 쓰기 없음·실행 권한을 검증한다. native executable ancestor에 한해서 macOS의 정확한 `/opt/homebrew/bin` 또는 `/opt/homebrew/Cellar` 경로가 owner0/uid·gid80(admin)·mode0775·정규 nonsymlink directory인 표준 설치 경계는 허용한다. 다른 경로·그룹·world-write는 거절한다. SQL/manifest/root 환경·연결 metadata의 no022 경계에는 이 예외를 적용하지 않는다. 기존 권한이나 설치 파일은 변경하지 않는다.

## 비공개 manifest 계약

manifest는 저장소 밖의 동일 owner 디렉터리 **700**, regular file **600**이다. 기존 원본 package도 해당 파일600/parent700을 그대로 유지한다. private source·manifest에 symlink, 경로 탈출, 저장소 내부 private 원본을 허용하지 않는다. root의 비밀 없는 project-ref/pooler metadata는 same-owner regular file·symlink 없음·no group/other write이며 기존0644를 허용한다. root `.env.local`은 same-owner regular file·symlink 없음·600이다.

manifest에는 SQL 본문·사용자 UUID·token·cookie·password·project 연결값을 넣지 않는다. 필수 필드는 다음과 같다.

| 위치 | 필수 metadata |
| --- | --- |
| 상위 | `schemaVersion: 1`, `attestationBaseGitSha`, `localSources`, `excludedLocalSources`, `privateSources` |
| local source | `version`, `filename`, `bytes`, `sha256` |
| 제외 source 6개 | local과 같은 구조이며 전체 local entry와 정확히 일치 |
| private source 6개 | local 구조 + `path`, `statementCount`, `canonicalLength`, `canonicalMd5` |

version은 기존 legacy `001`~`010` 또는14자리 숫자이며 원본을 zero-pad·개명하지 않는다. private/excluded 여섯 버전은14자리다.  filename은 version으로 시작하는 basename SQL, byte/count/length는 양의 안전 정수, SHA-256은64자리·MD5는32자리 소문자 hex다. 전체 local 파일 집합·byte/hash는 attestation base의 Git blob과 현재 root source 모두에 정확히 일치해야 한다. base는 root main의 ancestor여야 한다. unknown/duplicate JSON key·중복 version/filename/path·누락·추가 source·불일치 값을 거절한다.

local-only 여섯 개를 제외한 저장소 원본과 private 여섯 개를 temporary symlink로 연결한다. 최초 검토 집합은 **386 + 6 = 392**이나 미래 source count는 manifest에 묶이며 이 숫자를 이용해 drift를 무시하지 않는다. private SQL byte SHA와 기존 검토 statement count/canonical length/MD5를 함께 고정한다. 새 SQL parser를 통해 역사 원본을 재작성하거나 정규화하지 않는다.

새 migration 또는 원본/manifest 변경이 필요하면 새로운 source 근거와 독립 리뷰를 먼저 확보한다. 기존 manifest를 현재 상태에 맞추기 위해 자동 갱신하지 않는다. 고정 식별자를 가린 SQL, placeholder, 역사 파일 개명·삭제, include-all/history repair로 mismatch를 지우지 않는다. manifest 자체는 Git에 추가하지 않는다.

## 원격 검증과 cleanup

원격 호출은 순차적으로 진행한다. CLI가 이 실행의 owner-only 임시 `.temp`에 생성하는 `linked-project.json`만 optional metadata로 허용한다. 같은 owner의 bounded regular·nonsymlink·no022 파일을 strict JSON으로 읽고 decoded duplicate key를 거절하며 `ref`, `name`, `organization_id`, `organization_slug` 네 키와 root ref 일치·문자열 경계를 확인한다. 다른 추가 파일·키·credential 키·ref 차이는 거절한다. 이 cache를 root 연결 근거로 대체하지 않으며 내용을 DTO·로그·문서에 복사하지 않는다. 원래 입력의600/700 경계는 유지하고 CLI 생성 metadata만 parent700 안의600/0644를 허용한다. owner-only 임시 workdir에 비밀 없는 metadata와 격리 state 디렉터리를 먼저 둔 뒤, 그 cwd/state에서 CLI version 및 query/push 필수 flag 지원을 확인한다. query는 고정 `--agent=no`로 공식 CLI의 JSON bare array를 선택하고 이를 strict projection으로 검증한다. wrapper·unknown row key·본문 prefix/suffix·duplicate key는 거절한다. 고정 SELECT는 migration version 집합과 private 여섯 statement의 count/length/MD5만 반환한다. statement 본문·함수 본문·업무 행을 가져오지 않는다.

exact remote source-set parity와 attested metadata가 통과할 때만 `db push --dry-run --skip-vault`를 한 번 호출한다. `--include-all`, roles, seed, apply, repair, reset, bootstrap 및 임의 SQL 인자는 지원하지 않는다. exit0과 명확한 up-to-date/pending0 응답만 통과한다. 실제 migration을 적용하지 않는다. 공식 CLI의 제한된 임시 login-role 인증 준비 외 업무 스키마·데이터·history 및 수동 auth-role SQL은 실행하지 않는다.

child는 shell 없이 실행하며 최소 환경·timeout·output cap과 private pipe를 사용한다. native child의 HOME은 현재 owner로 유지하되 `DO_NOT_TRACK=1`과 이 실행의 parent700 임시 `cli-state`를 `SUPABASE_HOME`으로 고정한다. query/push는 지원 확인한 `--profile=supabase`를 명시하여 기존 profile 파일 대신 공식 Supabase origin을 사용한다. macOS Keychain의 기존 service/account 조회와 명시 root-env token의 메모리 전달은 유지하며 기존 token/profile/telemetry 파일을 복사하거나 수정하지 않는다. 모든 native child의 cwd는 만든 임시 workdir다. CLI state는 빈 디렉터리 또는1KiB 이하 `telemetry.json` 정규 파일 하나만 허용하고 same-owner/nonsymlink/no022를 lstat의 비참조 identity·타입·권한·크기와 state 디렉터리 identity를 재확인한다. CLI가 만드는 새 anonymous state는 경로·타입·권한·크기 metadata만 확인하고 본문을 읽거나 DTO·로그로 복사하지 않으며 종료 확인 후 해당 임시 디렉터리와 함께 제거한다. native CLI 전용 process group과 정상 후손을 함께 종료하고 child/pipe close가 확인된 뒤 원본 검사·cleanup을 진행한다. `CHILD_TERMINATION_UNCONFIRMED`이면 원본 불변·cleanup을 false로 두고 정리를 생략한다. 종료를 확인한 뒤에만 보존된 임시 workdir를 제거할 수 있으며 같은 원격 호출을 반복하지 않는다. raw stdout/stderr와 exception message를 출력·파일에 저장하지 않는다. 실패는 고정 error enum으로 반환하며 같은 원격 호출을 자동 재시도하지 않는다. pending/불일치/오염/timeout/cleanup 실패를 성공이나 비용0으로 치환하지 않는다.

source·root 연결·사용한 환경 파일의 실행 전후 byte/hash/stat 불변을 확인하고 finally에서 해당 실행이 만든 임시 workdir만 제거한다. SQL 복사본·환경 복사본은0개이며 source symlink만 제거된다. 사용자 `.playwright-mcp/`·보호 migration·기존 backup는 cleanup 대상이 아니다.

## 검사와 결과 해석

```text
npx vitest run tests/operations/tools/verify-supabase-private-source.test.ts tests/infra/tools/capacity-identity-epoch/owner-production.test.ts
npx tsc --noEmit --pretty false
```

새 검사에서 CLI/manifest·권한·symlink·변조 경계, source-set·remote parity·출력 오염·timeout·pending·인증 전달·불변·cleanup을 fake child로 확인한다. 전체 migration·앱 테스트나 사용자 분석을 실행하는 명령이 아니다.

결과 DTO는 관측시각·도구/CLI 버전·local/private/remote count·parity/hash match·planned count·원본 불변·cleanup·고정 error enum만 포함한다. 실제 private source path·project-ref·credential·SQL·UUID는 결과에 포함하지 않는다. source-set PASS를 사용자 분석 성공이나 Vertex 품질 gate·절감 승격으로 해석하지 않는다. 이 도구는 Apify API·actor와 AI generation을 호출하지 않는다.
