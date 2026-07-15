# Preflight Apify ambiguous start 수동 해소

이 절차는 최초 preflight 또는 fresh-admission generation별 profile fallback의 Actor 시작 응답이 유실되어
`analysis_preflight_provider_runs.status = 'starting'`이고 `run_id IS NULL`인 경우에만
사용한다. 이 상태는 Actor가 실제로 생성되지 않았다는 뜻이 아니다. 자동 worker와 비용
reconciler는 이 상태를 0원이나 실패로 추정하지 않으며, 같은 작업의 새 Actor도 시작하지
않는다.

수동 해소는 Apify에서 실행된 run이 없음을 운영자가 직접 확인한 경우에만 허용된다.
확신할 수 없으면 최대 과금 가능성을 유지한 채 row를 그대로 둔다.

## 보안 경계

- 후보 목록만 `service_role`로 조회할 수 있다. 해소 함수는 `service_role`, `anon`,
  `authenticated` 실행 권한이 모두 취소된 DB-owner 전용 경계다.
- 브라우저, Vercel client bundle, 공개 API route 또는 service-role REST 요청으로 해소를
  시도하지 않는다. 해소 SQL은 Supabase SQL Editor의 프로젝트 DB owner 세션 또는
  동일한 owner 자격의 직접 `psql` 연결에서만 실행한다.
- 테이블은 RLS와 `FORCE ROW LEVEL SECURITY`가 활성화되고 모든 역할의 직접 DML이
  취소되어 있다. SQL Editor에서 직접 `UPDATE`하지 않는다.
- 후보 목록은 Instagram ID나 원문 provider input을 반환하지 않는다. `inputHash`를
  역추적하거나 외부 문서에 사용자 식별 정보를 추가하지 않는다.
- DB에는 외부 증거의 reference 원문을 저장하지 않는다. 운영 CLI가 reference를
  SHA-256으로 변환하고 hash만 전달한다.
- 자동 retention, worker, reconciler 코드에서 수동 해소 RPC를 호출하지 않는다.

## 1. 후보 조회

서버 운영 환경에서 service-role key를 환경변수로만 제공한다. 명령행 인자로 key를
전달하지 않는다.

```bash
npx tsx --env-file=.env.local \
  scripts/resolve-preflight-ambiguous-apify-start.ts \
  --list --limit=20
```

목록은 최대 100개로 제한된다. 다음 조건을 모두 만족한 row만 나온다.

- `status = 'starting'`, `run_id IS NULL`
- provider row의 `reserved_at`과 `updated_at`이 모두 30분 이상 변경되지 않음
- 연결된 preflight가 만료됨
- 활성 lease가 없음

출력되는 `preflightId`, `operationKey`, `inputHash`, `logicalProvider`, `actorId`,
`credentialSlot`, `maxChargeUsd`, `reservedAt`은 이후 해소 요청의 불변 identity다.
`operationKey`는 최초 실행의 `target-profile-fallback` 또는 fresh generation의
`target-profile-fresh-admission:g1`~`g100`이며, 후보 조회가 반환한 값을 그대로 사용한다.

## 2. Apify 확인

1. `credentialSlot`에 연결된 정확한 Apify 계정으로 로그인한다. 다른 무료 계정이나 현재
   신규 실행용 슬롯을 대신 확인하면 안 된다.
2. Actor가 정확히 `apify/instagram-profile-scraper`인지 확인한다.
3. `reservedAt` 직전의 작은 시계 오차 구간부터 현재까지 생성된 active, succeeded,
   failed, aborted, timed-out run을 모두 조회한다. active 목록만 보고 판단하지 않는다.
4. 해당 예약과 관련되었을 가능성이 있는 run 또는 dataset이 하나라도 있으면 해소하지
   않는다. run ID를 확인했다면 별도 사고 처리로 실제 상태와 비용을 대사한다.
5. 같은 계정, Actor, 시간 범위에 run이 없다는 조회 결과를 외부 incident/ticket에
   보존한다. reference에는 provider token, Instagram ID, caption, comment 등 사용자
   데이터를 넣지 않는다.
6. resolve 명령 직전에 Apify 조회를 한 번 더 반복한다.

`credentialSlot -> Secret Manager numeric version -> Apify account` 매핑은 해당 버전을
참조하는 run이 모두 정산되거나 수동 해소될 때까지 불변으로 취급한다. 배포 스크립트는
이미 배포된 선택 슬롯을 다른 숫자 버전으로 덮어쓰는 same-slot rotation을 차단한다.
회전 전에는 별도 DB 미정산 감사와 credential-retirement 절차가 필요하며, 현재 자동
회전 절차는 제공하지 않는다. 다른 슬롯으로 전환할 때는 기존 숫자 버전 reference를
recovery-only로 보존한다.

전용 `ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET`도 진행 중인 preflight의 `inputHash`를
결정하므로 즉시 교체하면 기존 run resume가 fail-closed 된다. 회전 시 먼저 새 preflight
admission을 닫고, 기존 preflight가 모두 terminal 상태가 된 뒤 retention TTL까지 기다려
old-key identity가 남지 않았음을 감사한다. 다만 현재 deploy 경로는 이 수동 drain을 수행해도
기존 Cloud Run service의 numeric version 변경을 무조건 차단한다. drain은 향후 DB-backed
감사 migration 경로 또는 새 service 전환을 위한 선행 근거일 뿐 in-place rollout 승인이
아니다. old version은 enabled로 보존하고, 현재 service에서는 같은 numeric version만
재배포한다.

### 기존 pre-feature service의 HMAC bootstrap

`ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET` reference가 아직 없는 기존 Cloud Run
service는 일반 deploy script로 bootstrap하지 않는다. deploy script는 기존 service의
최신 template과 현재 100% traffic을 받는 revision 중 하나에라도 HMAC reference가
없으면 fail-closed 된다. override나 예외 flag는 제공하지 않는다.

최초 도입은 코드 deploy 전 별도 운영 변경으로 수행한다.

1. 현재 100% serving revision의 immutable image digest, runtime env, secret reference,
   execution gate를 기록한다.
2. 같은 image digest와 같은 runtime 설정을 유지한 채 canonical
   `ai-baram-v2-preflight-identity-hmac:<numeric-version>` reference만 추가하는
   `gcloud run services update` 변경을 별도로 실행한다.
3. 새 revision이 Ready이고 100% traffic을 받으며, service template과 active revision
   모두에 같은 canonical numeric reference가 정확히 1개인지 확인한다.
4. 이 bootstrap 검증 후에만 일반 deploy script를 실행한다.

이 절차는 이미 HMAC reference가 있는 service의 version rotation에 사용하지
않는다. 기존 reference의 secret ID나 numeric version 변경은 계속 차단된다.

외부 incident/ticket의 안정적인 reference 한 줄만 source tree 밖 파일에 둔다.

```bash
printf '%s\n' 'incident-reference-without-user-data' \
  > /secure/path/preflight-no-run-evidence.txt
```

## 3. DB owner용 해소 SQL 생성

후보 목록의 값을 변경 없이 전달한다. 아래 확인 문구는 Apify의 정확한 계정, Actor,
시간 범위를 확인했다는 운영자 선언이다.

```bash
npx tsx \
  scripts/resolve-preflight-ambiguous-apify-start.ts \
  --resolve \
  --preflight-id='00000000-0000-4000-8000-000000000000' \
  --operation-key='target-profile-fresh-admission:g4' \
  --input-hash='64-character-lowercase-sha256' \
  --logical-provider='apify' \
  --actor-id='apify/instagram-profile-scraper' \
  --credential-slot='quinary' \
  --max-charge-usd='0.002600000000' \
  --reserved-at='2026-07-15T01:02:03.000Z' \
  --evidence-reference-file='/secure/path/preflight-no-run-evidence.txt' \
  --confirm='I_VERIFIED_EXACT_APIFY_ACTOR_SLOT_AND_TIME_WINDOW_HAS_NO_RUN'
```

이 명령은 DB를 변경하지 않으며 evidence reference의 SHA-256과 후보 identity를 넣은
단일 `SELECT public.resolve_analysis_preflight_provider_run_no_run(...)` 문만 출력한다.
출력 SQL을 검토한 후 Supabase Dashboard의 SQL Editor에서 프로젝트 DB owner로
실행한다. service-role key를 사용하는 REST/PostgREST에서는 의도대로 권한 오류가 난다.

DB-owner 전용 함수는 provider row를 잠근 뒤 모든 불변 identity와 30분 quiet period를 다시
검증한다. 성공 시에만 다음 값을 원자적으로 기록한다.

- `status = 'resolved_no_run'`
- `run_id = NULL`, `actual_usage_usd = 0`
- terminal, usage reconciliation, manual resolution timestamp
- evidence reference의 lowercase SHA-256

같은 트랜잭션은 장기 `manual_no_run` 비용 이벤트도 기록한다. 이 이벤트에는 exact
provider, Actor, credential slot, 0원 사용량, evidence reference hash만 남고 raw
preflight ID, input, run ID, Instagram ID는 남지 않는다. 따라서 preflight와 provider
row가 purge된 뒤에도 어떤 Apify 계정 범위를 확인했는지 감사할 수 있다.

동일한 identity와 evidence hash의 재호출만 멱등적으로 성공한다. 다른 evidence,
다른 identity, 너무 이른 후보, `starting`이 아닌 row는 충돌로 실패한다.

## 4. 사후 확인

1. 같은 `--list` 명령에서 해당 `preflightId`가 더 이상 나오지 않는지 확인한다.
2. retention scheduler가 다음 주기에 만료 preflight를 삭제하도록 둔다. 긴급하지 않다면
   purge RPC를 수동 호출하지 않는다.
3. 다음 retention 주기 뒤 해당 tombstone이 제거됐는지 서버 운영 로그로 확인한다.
4. 외부 incident/ticket에 해소 시각과 CLI 결과의 PII-free 상태만 기록한다.

`resolved_no_run`은 실제 Apify run이 없다는 외부 증거를 운영자가 확인한 경우에만 purge
fence를 해제한다. 단순히 30분이 지났거나 Apify UI 첫 화면에 run이 보이지 않는다는
이유로 사용하면 안 된다.
