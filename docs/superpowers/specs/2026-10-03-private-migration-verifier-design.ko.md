# 비공개 migration 원본 검증 도구 설계

기준 main: `4638b2251429e87ddd141ea940e414cb3b85496c`. 사용자 테스트와 Apify 비용 발생을 제외한 2026-10-03 후속 작업이다.

## 목적과 근거

원격에만 있는 여섯 migration의 정확한 원본은 owner-only 보존 package에 있다. 이 중 네 원본에는 고정 식별자가 있으므로 새 tracked SQL에 복사하거나 내용을 가릴 수 없다. 기존 local-only 여섯 파일의 현행 효과와 원격 원본의 count/length/hash 비교는 완료됐고, 386개 저장소 원본과 여섯 비공개 원본을 symlink로 참조한 격리 source-set은 392/392 parity 및 pending 0 dry-run을 통과했다.

이번 도구는 이 검증 절차를 같은 안전 경계에서 반복 가능하게 만든다. 원본의 접근 경계는 저장소 밖의 owner-only package 및 metadata manifest로 정한다. 실제 저장소 migration 폴더와 원격 이력의 기존 6대6 차이, 빈 DB 전체 bootstrap의 미검증 범위는 계속 명시한다.

## 검토한 방식과 결정

1. **권장: 비공개 metadata manifest와 검증 전용 CLI.** 이미 검토한 원본과 전체 source-set의 hash를 고정하고 temporary symlink만 사용한다. 원본 재저장 없이 drift와 remote parity를 검사할 수 있다. manifest 갱신은 새 근거와 리뷰가 필요하다.
2. 공개 hash profile과 비공개 path manifest를 분리한다. 공개 diff는 검토하기 쉽지만 두 metadata 파일의 동기화 책임이 늘어난다.
3. 현재 runbook을 수동으로 반복한다. 새 코드가 없지만 allowlist·권한·출력·정리 조건을 매번 동일하게 지키기 어렵다.

기존 canonical root resolver와 CLI 응답의 안전한 오류 처리 패턴을 재사용하는 첫 번째 방식을 선택한다. SQL parser를 새로 만들지 않는다. remote statement의 count/length/MD5와 보존 byte SHA-256을 기존 provenance attestation에 대조하는 검증임을 분명히 한다.

## 입력과 명령

metadata manifest는 저장소 밖에 두고 parent mode 700, file mode 600 및 동일 owner를 요구한다. private SQL 원본도 동일 owner·file 600·parent 700이며 symlink를 거절한다. 본문·사용자 식별자·token·password·cookie·project connection 값을 manifest에 포함하지 않는다.

root의 비밀 없는 project-ref/pooler metadata는 동일 owner·regular file·symlink 없음·group/other 쓰기 없음이 기준이며 기존 0644를 허용한다. root `.env.local`은 동일 owner·regular file·mode 600·symlink 없음으로 검증한다. 이 파일들의 권한을 바꾸거나 feature 설정으로 대체하지 않는다.

필수 내용은 schema version, attestation base Git SHA, 전체 local source의 filename/version/bytes/SHA-256, 제외할 local-only 여섯 파일의 identity/hash, private 여섯 원본의 path/bytes/SHA-256 및 검토된 statement count/canonical length/MD5다. 알 수 없는 키, 중복 version/path, count 불일치, 비정상 hash/크기는 거절한다. source의 실제 경로·소유권·권한·symlink 여부를 확인하며 경로 탈출과 저장소 내부 private 원본을 거절한다.

명령은 다음 두 모드뿐이다.

```text
node --import tsx scripts/verify-supabase-private-source.ts verify --manifest <private metadata> --local-only
node --import tsx scripts/verify-supabase-private-source.ts verify --manifest <private metadata> --dry-run [--auth=root-env]
```

기본 인증은 기존 Keychain CLI다. 명시적 `--auth=root-env`는 검증한 root `.env.local`의 `SUPABASE_ACCESS_TOKEN` 하나만 비실행 parser로 읽어 child 환경에 전달한다. 기존 사용자 승인에 따른 메모리 사용이며 값·환경 파일은 복사하거나 출력하지 않는다. 다른 auth mode, command/SQL passthrough, apply/repair/include-all/seed/roles/reset/bootstrap 옵션은 없다.

## 실행 순서와 실패 처리

1. 기존 resolver로 root가 동일 저장소의 안전한 main checkout인지 검증한다.
2. manifest와 모든 source byte/hash를 검증한다. 비공개 source는 그대로 둔다.
3. local-only는 원격 호출 없이 source 검증 결과만 반환한다.
4. dry-run은 검증한 root의 비밀 없는 project-ref/pooler metadata만 owner-only temporary workdir에 둔다. password empty·같은 project·공식 pooler 경계를 확인한다. root 환경 파일을 복사하거나 shell로 source하지 않는다.
5. 임시 source-set에는 local-only 여섯 개를 제외한 local 원본과 private 여섯 원본의 symlink만 만든다. SQL 복사본은 만들지 않는다.
6. 일반 조회 CLI는 2.114.0 및 필수 help flag를 확인한다. W01 owner credential conduit의 pinned 2.102.0 계약은 바꾸지 않는다.
7. 고정 SELECT로 fresh remote version 집합과 remote-only 여섯 statement의 count/length/MD5만 가져온다. SQL 본문과 사용자 행은 반환하지 않는다. exact parity와 attested metadata가 일치해야 다음 단계로 간다.
8. `db push --dry-run --skip-vault`를 한 번만 실행한다. pending 0의 명확한 성공 결과만 통과시킨다.
9. 모든 source와 root metadata가 실행 전후 그대로인지 확인하고 finally에서 해당 실행이 만든 임시 workdir를 제거한다. CLI 실패·timeout은 재시도하지 않는다.

child 실행은 shell 없이 고정 command/argument, 최소 환경, timeout, output byte cap 및 private pipe를 사용한다. native CLI가 공식 인증 절차에서 수행하는 임시 login-role 초기화만 인증 준비로 허용한다. 업무 데이터·스키마·migration 변경 SQL과 수동 auth-role SQL은 실행하지 않는다. raw stdout/stderr 및 exception message는 외부에 출력하지 않는다.

## 출력과 검증

출력은 관측 시각, 도구/CLI 버전, local/private/remote count, parity/hash match, planned migration count, 원본 불변·cleanup 성공, 고정 error enum으로 제한한다. 원본 path·connection·credential·SQL·UUID·사용자 행은 출력하거나 report에 저장하지 않는다.

수용 기준:

- local-only에서 source 검증·symlink/권한/중복/변조 거절을 확인하고 CLI 호출이 0임을 검증한다.
- dry-run의 fake transport 검사에서 manifest drift·remote mismatch·출력 오염·timeout·pending migration이 모두 fail closed하며 apply 계열 호출이 0이다.
- 정상 fake 및 실제 read-only 검증에서 SQL 복사 0, exact source-set parity, pending 0, 원본 불변 및 cleanup을 확인한다.
- root 환경이 feature 설정으로 대체되지 않고 token이 출력·argv·파일에 포함되지 않음을 확인한다.
- 관련 검사와 타입체크, 구현자와 다른 agent의 리뷰, PR CI 이후에 main에 병합한다.
- Apify API/actor·AI generation·사용자 분석·결제·운영 재활성화·업무 스키마 DDL·수동 auth-role SQL·history repair 호출은 0이다. 공식 CLI 인증 초기화는 위의 제한된 예외에 해당한다.

## 변경 범위와 미검증 사항

새 CLI와 핵심 모듈, 중요한 실패 경계를 묶는 operations 검사 파일 하나를 추가한다. package/lock/SQL/기존 owner 구현을 변경하지 않는다. root는 `tests/README.md`, 운영 안내와 W00~W08 상태판을 통합한다.

W04는 저장된 비용·정책·usage coverage의 서버 집계를 별도로 진행하며 신규 replay/Apify/AI 호출은 없다. 실제 high-risk label·동일 cohort의 baseline/proposed 결과가 없다면 quality 승격은 계속 차단된다. W06는 현재 물리 저장공간 집계와 살아 있는 의존성으로 추가 축소 필요성을 판정한다.

이 설계는 새로운 DB 초기화·restore 전체 범위·실제 migration 적용을 승인하지 않는다. source-set 검증 결과는 해당 manifest와 관측 시점에 한정되며 미래 변경을 자동 승인하지 않는다. 구현 전에 사용자가 이 검증 전용 도구 설계를 검토한다.
