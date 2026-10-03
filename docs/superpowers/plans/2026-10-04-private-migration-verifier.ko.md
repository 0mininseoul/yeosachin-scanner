# 비공개 migration 원본 검증 도구 구현 계획

> **에이전트 작업자:** `subagent-driven-development` 절차로 아래 작업을 수행한다. 명세 적합성 리뷰를 마친 뒤 코드 품질 리뷰를 진행한다. 체크박스로 실행 결과를 추적한다.

**목표:** 승인된 비공개 원본을 재저장하지 않고 local source 무결성과 remote exact parity·zero-pending dry-run만 검증한다.

**구조:** CLI는 엄격한 인자 parsing과 안전 DTO 출력만 담당한다. 핵심 모듈은 owner root resolver, private manifest/source 검증, 제한된 child transport와 temporary symlink 수명을 묶는다. fake transport 검사는 인증·출력·불변·cleanup 실패 경계를 원격 호출 없이 확인한다.

**기술:** Node 24 `fs`/`crypto`/`child_process`/`util.parseEnv`, TypeScript/tsx, Vitest, 설치 Supabase CLI 2.114.0.

사용자가 2026-10-04 [한국어 설계](../specs/2026-10-03-private-migration-verifier-design.ko.md)를 승인했다. 기준 main은 `a46a0e1ba5fc4d5379de510c48ed3116e5a3d4b9`. 기존 Codex 관리 worktree를 재사용하고 `codex/private-migration-verifier-20261004` 브랜치에서 작업한다.

## 파일과 편집권

- 구현자: 새 `scripts/supabase-private-source.ts`, `scripts/verify-supabase-private-source.ts`, `tests/operations/tools/verify-supabase-private-source.test.ts`만 편집한다.
- 상위: 이 계획, `tests/README.md`, `docs/operations/2026-10-03-continuation-status.ko.md`, 새 `docs/operations/private-migration-source-verification.ko.md`, `docs/reports/2026-10-04-w05-private-verifier.ko.md` 및 안전 receipt만 편집한다.
- provenance 조사자: 저장소 밖 새 owner-only 디렉터리의 `manifest.json`만 생성한다. 원본 package와 기존 backup는 편집하지 않는다.
- 리뷰어: 읽기 전용으로 명세 및 코드 품질을 검토하고 파일을 변경하지 않는다.

## 작업 1: manifest/source 및 CLI 경계

- [x] manifest의 키를 다음 계약으로 고정한다. 추가 키·JSON duplicate key·중복 version/filename/private path·비정상 값·빈 source·6개가 아닌 exclude/private·제외 집합 밖의 source 차이를 거절한다. local entry와 excluded entry는 동일 구조이며 excluded는 전체 local entry와 정확히 일치해야 한다. version은 기존 legacy `001`~`010` 또는 14자리 숫자(`/^(?:00[1-9]|010|[0-9]{14})$/`), filename은 version으로 시작하는 basename `.sql`, SHA-256은 소문자 64자리, MD5는 소문자 32자리, 크기와 count는 양의 안전 정수다.

```ts
type LocalSource = { version: string; filename: string; bytes: number; sha256: string };
type PrivateSource = LocalSource & {
  path: string;
  statementCount: number;
  canonicalLength: number;
  canonicalMd5: string;
};
type Manifest = {
  schemaVersion: 1;
  attestationBaseGitSha: string;
  localSources: LocalSource[];
  excludedLocalSources: LocalSource[];
  privateSources: PrivateSource[];
};
```

- [x] CLI 인자를 아래 두 형태로만 받는 failing test를 먼저 작성한다. `--auth=root-env`는 dry-run에서만 허용한다. `--help`는 승인 경계를 설명하는 static 문자열만 출력한다. 실제 실행에는 정확히 한 모드가 필요하며 중복/unknown 옵션은 고정 `INVALID_ARGUMENTS`로 실패한다.

```text
node --import tsx scripts/verify-supabase-private-source.ts verify --manifest <private file> --local-only
node --import tsx scripts/verify-supabase-private-source.ts verify --manifest <private file> --dry-run [--auth=root-env]
```

```ts
it('rejects apply and mixed modes before any child', async () => {
  const child = vi.fn();
  const result = await runPrivateSourceCli(['verify', '--apply'], { runChild: child });
  expect(result.exitCode).toBe(1);
  expect(result.receipt?.errorCode).toBe('INVALID_ARGUMENTS');
  expect(child).not.toHaveBeenCalled();
});
```

- [x] import될 새 모듈이 없는 상태에서 `npx vitest run tests/operations/tools/verify-supabase-private-source.test.ts`가 실패하는 것을 확인한 뒤 위 기능을 구현한다. test seam의 실제 dependency signature는 핵심 모듈의 고정 child transport와 일치시키며 process-global 환경을 바꾸지 않는다.
- [x] `resolvePrimaryRepositoryRootForOwner`를 `scripts/capacity-identity-epoch/owner-production.ts`에서 import한다. root main 및 동일 저장소·owner·디렉터리 권한 검증을 그대로 사용하고 기존 owner 구현을 편집하지 않는다.
- [x] 실제 local filename/version 집합과 manifest의 전체 local 집합, byte/hash를 exact 비교한다. attestation base가 같은 Git 저장소의 main ancestor이고 manifest local source가 해당 Git blob과 일치하는지 검증한다. private entry는 저장소 밖의 절대 경로와 정확한 basename이어야 하며 정규화 경로 탈출·source symlink·저장소 내부 private/manifest를 거절한다.
- [x] private manifest/file은 동일 owner·regular·600 및 parent700, public root 연결 metadata는 동일 owner·regular·no022(0644 허용), root `.env.local`은 동일 owner·regular·600을 요구한다. ancestor symlink와 안전하지 않은 경로를 거절하고 파일 크기를 제한한다. 원본 권한은 변경하지 않는다.
- [x] local-only 성공 DTO와 source tamper·권한·symlink·중복 거절 검사에서 child 호출 0을 확인한다. SQL body·원본 path·환경 값을 DTO에 포함하지 않는다.

## 작업 2: 고정 조회와 dry-run 수명

- [x] fake child의 정상/실패 시나리오를 추가한다. SQL/credential에 보이는 문자열을 stdout/stderr에 넣어도 외부에는 고정 enum만 남으며 cleanup과 원본 불변 검사를 수행해야 한다. 정상 출력에도 unknown key/본문 오염을 거절한다.
- [x] default child는 shell 없이 검증한 설치 CLI를 실행한다. argv에는 고정 SELECT 또는 dry-run만 들어가며 token은 들어가지 않는다. PATH/HOME/TMPDIR/LANG/LC_ALL, 고정 DO_NOT_TRACK=1/own SUPABASE_HOME 및 명시적 root-env token 외 ambient 환경은 전달하지 않는다. timeout·output cap·exit failure는 재시도 없이 실패한다.
- [x] root project-ref/pooler metadata를 검증한다. project는 20자리 소문자, URL은 postgres 공식 pooler host·port5432/6543·password empty·username의 project 일치, 같은 root의 Supabase origin도 일치해야 한다. default 인증은 Keychain; root-env 모드는 `util.parseEnv`로 root 환경에서 token 하나만 읽는다. feature 환경이나 secret 원본을 복사하지 않는다.
- [x] CLI version2.114.0과 `db query --help`, `db push --help`의 필수 지원 flag를 확인한다. 고정 SELECT는 `supabase_migrations.schema_migrations`의 version 전부 및 private 여섯의 statement count/`array_to_string(statements, E'\n')` character length/MD5만 반환한다. SQL array 본문은 반환하지 않는다. 고정 `--agent=no`의 bounded JSON bare array strict projection과 exact version 집합·여섯 metadata를 대조한다.
- [x] owner-only 임시 workdir/.temp/migrations를 만들고 비밀 없는 연결 metadata만600으로 둔다. source392 중 exclude6을 뺀386과 private6을 symlink로만 연결한다. 모듈은392를 universal hardcode하지 않고 manifest로 계산하되 six-for-six 경계는 고정한다.
- [x] exact remote parity·metadata match 성공 뒤 아래 호출을 한 번만 허용한다. 명확한 pending0 성공 문자열과 exit0을 확인한다. pending·오염·모호한 응답은 거절한다. apply·repair·include-all·roles·seed·reset·bootstrap·임의 SQL 전달 API는 제공하지 않는다.

```text
supabase db push --dry-run --skip-vault --linked --project-ref <검증된 ref> --workdir <created temp> --profile=supabase
```

- [x] try/finally에서 source와 root metadata byte/hash/stat 불변을 확인하고 이 실행이 만든 임시 workdir만 제거한다. cleanup 실패를 성공으로 반환하지 않는다. root 환경·연결·원본은 쓰지 않는다. 공식 CLI의 제한된 login-role 준비 외 업무 스키마·데이터·migration 또는 수동 auth-role SQL은 없다.
- [x] 안전 DTO에는 관측시각·도구/CLI 버전·local/private/remote count·parity/hash·planned0·unchanged·cleanup·고정 error enum만 포함한다. raw exception/stdout/stderr/connection/SQL/path/UUID는 출력하지 않는다.
- [x] fake success, remote mismatch, output contamination, timeout, pending, source race/tamper, cleanup failure 및 token 없는 argv/file/DTO 검사를 통과시킨다. 구현자가 변경 파일·정확한 검사 결과·남은 blocker를 보고한다.

## 작업 3: 독립 검토와 실제 제한 실행

- [x] 구현자와 다른 agent가 승인 설계 전체를 기준으로 missing/extra 동작을 검토한다. finding을 구현자가 수정하고 재검토 PASS를 받은 후 다른 agent가 코드 품질·안전 수명·검사의 실효성을 검토한다.
- [x] 상위가 focused 검사와 `npx tsc --noEmit --pretty false`를 실행한다. owner resolver import 회귀를 위해 기존 `tests/infra/tools/capacity-identity-epoch/owner-production.test.ts`만 함께 검사한다. 전체 앱·migration·DB bootstrap 검사는 실행하지 않는다.
- [x] private manifest 작성자는 기존 attestation의 여섯 byte SHA/count/length/MD5와 local 전체 SHA를 새 metadata에 넣고700/600·UUID/credential/body 부재를 확인한다. source 원문은 메모리 hash에만 사용하며 새 SQL/원본 복사본을 만들지 않는다.
- [x] 상위가 실제 local-only 실행을 먼저 통과시킨다. 이어 승인된 root-env 인증으로 remote exact parity 조회와 zero-pending dry-run을 순차적으로 한 번 수행한다. 실제 호출 실패는 raw 출력을 공개하거나 같은 명령을 반복하지 않고 고정 blocker를 기록한다.
- [x] safe DTO만 receipt에 저장한다. 원본·root 환경·보호 migration·기존 refs/stash 및 사용자 `.playwright-mcp/` 보존을 확인한다. 날짜는 Asia/Seoul 2026-10-04를 사용하며 이전 10월3일 관측과 분리한다.

## 작업 4: 운영 안내·상태판·PR 마감

- [x] `tests/README.md`의 operations 안내에 새 도구 검사를 연결한다. runbook에는 private schema, allowlist/auth/권한·출력·cleanup·실제 dry-run 실행 형태와 manifest 변경 시 새로운 attestation/review 필요 조건을 모두 설명한다.
- [x] W05를 승인→구현/검증 결과로 갱신하고 W08 독립 리뷰와 검사 근거를 연결한다. W00/W01/W02/W06/W07 처리 결과와 W03/W04 사용자/실측 경계는 유지한다. 새 도구가 빈 DB bootstrap·실제 적용·history source 공개/정렬·DROP 권한을 해결했다고 쓰지 않는다.
- [x] docs·receipt JSON·링크·UUID/credential 패턴·`git diff --check` 및 독립 통합 리뷰를 수행한다.
- [ ] 명시적 feature branch push 후 한국어 PR을 생성하고 Codex에 attach한다. 관련 CI·Vercel 및 독립 리뷰 PASS를 확인한 정확한 head만 merge한다. 직접 main push는 없다.
- [ ] root main을 fetch/fast-forward하고 main/origin/main/원격 SHA 일치·tracked clean 및 보존 불변을 확인한다. 남은 사용자/실측 blocker는 종료 보고에 기록한다.

구현 준비 중 확인한 기존 identity: 초기 migration 10개는3자리 `001`~`010`이다. 원본 보존 설계에 따라 이 정확한 예외만 허용하며 zero-pad·개명하지 않는다. private/excluded 여섯 버전은14자리다.

Native 설치 정책의 구현 확인: 설치 실행 파일은 Homebrew symlink chain과 최종 regular file의 owner(0 또는 실행 uid)·group/other 쓰기 없음·실행 권한을 검증한다. native executable ancestor에 한해서 macOS의 정확한 `/opt/homebrew/bin` 또는 `/opt/homebrew/Cellar` 경로가 owner0/uid·gid80(admin)·mode0775·정규 nonsymlink directory인 표준 설치 경계는 허용한다. 다른 경로·그룹·world-write는 거절한다. SQL/manifest/root 환경·연결 metadata의 no022 경계에는 이 예외를 적용하지 않는다. 기존 권한이나 설치 파일은 변경하지 않는다.

2026-10-04 로컬 검증 기록: 구현자 fake110/110 및 타입체크 PASS. 상위 세션의 focused110 + 기존owner35 =145/145, 타입체크(`--incremental false`) PASS. 명세·품질 리뷰와 실제 원격 검증은 이 기록 시점에 아직 남아 있다.

- [x] 품질 리뷰 P2 수명 오류: native CLI가 stdio를 상속한 후손을 만들 때 직계 child만 종료하면 후손·pipe가 남는다. CLI 전용 process group을 종료하고 pipe/child close 확인 후 원본 검사와 cleanup을 진행한다. timeout/output cap 회귀 fixture에서 후손 실제 종료·시간 상한을 확인하며, 종료 확립 실패를 cleanup/originals 성공으로 반환하지 않는다.

2026-10-04 종료 경계 수정 후 상위의 fresh 회귀 검증: 신규117 + 기존owner35 =152/152 PASS, 타입체크(`--incremental false`) exit0. timeout·출력 초과·비정상 종료의 실제 fake 후손 PID 종료와 pipe close를 확인한다. 품질 독립 재검토와 실제 제한 실행은 이 기록 시점에 남아 있다.

실제 local-only는04:52:13 KST 392/6·source hash·원본 불변 PASS. 04:52:20 KST 최초 dry-run 진입은 native 설치 `/opt/homebrew/bin`의 같은 owner·admin gid80·0775 경계에서 `CLI_UNAVAILABLE`로 중단했다. Supabase CLI/원격 호출은0이며 원본 불변·cleanup PASS다. 설치 파일 권한은 변경하지 않고 native의 두 정확한 Homebrew ancestor 경계만 fake 회귀·독립 리뷰 후 허용한다. 실패 receipt도 별도로 보존한다.

- [x] 품질 리뷰 P2 native cache 계약: query가 생성한 optional `linked-project.json` 때문에 정상 pre-push 경계가 막히는 오류를 고친다. parent700 안의 same-owner bounded regular/nonsymlink/no022, strict4key JSON/root ref 일치를 확인하며 unknown·중복·오염·ref drift·symlink·writable 파일은 거절한다. cache는 연결 기준이나 공개 DTO에 사용하지 않는다.

- [x] 실제CLI 출력 계약: 공식 Bun2.114.0 query는 human barearray 또는 agent wrapper이며 `{rows}` 단독이 아니다. 명시 `--agent=no`와 CLI capability 검사를 고정하고 strict barearray·행4key/metadata를 검증한다. wrapper·unknown row key·본문 prefix/suffix·duplicate key는 거절한다.

- [x] native CLI 상태 격리: native child의 HOME은 현재 owner로 유지하되 `DO_NOT_TRACK=1`과 이 실행의 parent700 임시 `cli-state`를 `SUPABASE_HOME`으로 고정한다. query/push는 지원 확인한 `--profile=supabase`를 명시하여 기존 profile 파일 대신 공식 Supabase origin을 사용한다. macOS Keychain의 기존 service/account 조회와 명시 root-env token의 메모리 전달은 유지하며 기존 token/profile/telemetry 파일을 복사하거나 수정하지 않는다. 모든 native child의 cwd는 만든 임시 workdir다. CLI가 만드는 새 anonymous state는 경로·타입·권한·크기 metadata만 확인하고 본문을 읽거나 DTO·로그로 복사하지 않으며 종료 확인 후 해당 임시 디렉터리와 함께 제거한다. 원격0인 단계에서 official source로 Keychain 독립성·explicitprofile·opt-out 지원을 확인했고 fake 검증과 최종 독립 리뷰 후 실행한다.

최종 구현 commit `20703f42`: 명세·품질 독립 PASS, 상위194/194(신규159+owner35)·타입체크 PASS. 실제05:27:36 KST 실행의 native CLI2.114.0 metadata 조회1회→source392/remote392 parity 및6 private attestation→zero-pending dry-run1회 PASS. 원본 불변/cleanup true, Apify·앱AI·실제apply/repair/DDL0. 최초preflight 실패를 포함한 safe receipt와 상세 결과는 [W05/W08 보고서](../../reports/2026-10-04-w05-private-verifier.ko.md)에 보존한다. 최종 문서 리뷰 및 PR CI/병합/main 동기화의 실행 증거는 GitHub PR와 종료 보고에 기록한다.

문서 통합 독립 리뷰 최종PASS. 임시 metadata/state 생성→version/help 순서와 runChild dependency/explicitprofile 예시의 P3를 정정했다. PR·병합·main 동기화 두 release 항목은 이 문서의 코드 snapshot 후 실행되므로 GitHub PR 최종 기록으로 완료 증거를 남긴다. 새 백로그나 추가 사용자 승인 대기가 아니다.
