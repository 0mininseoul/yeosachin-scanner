# 자동 분석 용량 안정화 운영 런북

이 문서는 자동 분석 용량 분리 변경의 출시 게이트다. 코드베이스와 분석 엔진은 하나로 유지하고, Cloud Tasks 큐, Cloud Run 워커, DB 글로벌 provider admission 계층에서 preflight와 유료 분석을 격리한다.

## 승인된 출시 범위

| 워크로드 | 기존 큐 / 서비스 역할 | 초기 실행 동시성 | 확장 게이트 | provider 경계 |
| --- | --- | ---: | ---: | --- |
| Preflight | `analysis-preflight` / `preflight` | 32 | synthetic 검증과 canary 이후에만 64 | Apify credential은 정확히 `primary`, `quinary`, `senary` |
| 유료 full analysis | `analysis-v2-pipeline` / `paid` | 8 | 측정된 canary와 release 승인 이후에만 16 이상 | 전체 followers/following은 `secondary`; 모든 유료 Apify 시작은 DB 글로벌 budget 사용 |

Preflight는 400건 burst를 손실, 중복 terminal effect, ownership 손상 없이 받아야 한다. 유료 분석은 provider 실행이 글로벌 상한 안에 있는 동안 최소 200건을 durable하게 접수해야 한다. 기존 8-slot Gemini DB lease가 계속 권위 있는 제한이며, 추가 admission budget은 이 lease를 대체하지 않는다. 유료 worker/analysis 동시성은 task/service 실행 상한이다. 8에서 16 이상으로 확장해도 Gemini 8-slot ceiling이나 기존 Apify global/credential-slot/relationship/rate budget은 넓어지지 않는다.

## 운영 게이트

production provider를 활성화하기 전에 다음 게이트를 모두 통과해야 한다.

1. 정확한 release commit에서 deterministic fake-provider harness를 실행한다.

   ```bash
   npm run load:analysis-capacity
   ```

   Initial JSON 결과는 `accepted=600`, `terminalized=600`, `lost=0`, `duplicateTerminalEffects=0`, `eventualDrain=true`, `maxPreflightProviderActive===32`, `maxPaidProviderActive===8`, `maxGeminiActive===8`, `workerPreflightConcurrency===32`, `workerPaidConcurrency===8`이어야 한다. Expanded 실행도 provider 최대값은 정확히 32/8/8이어야 하며 worker 동시성만 `workerPreflightConcurrency===64`, `workerPaidConcurrency===16`이어야 한다. 두 결과 모두 양수인 capacity-pending, retry/recovery, fence-rotation 증거와 독립적으로 관측한 task-create, admission-wrapper, fake-provider 호출 카운터를 포함해야 한다. DB contention은 `deterministic-serial-fake`임을 표시하고 native PostgreSQL contention/EXPLAIN은 별도 release artifact로 보관한다. harness는 Apify, Gemini, Cloud Tasks, Cloud Run, Supabase 등 외부 provider를 resolve하거나 호출해서는 안 된다.

2. admission, PGlite, queue-role, worker-route, infra contract 대상 테스트를 실행한다. 이어 scheduler benchmark, 전체 test, lint, TypeScript 검사, production build, `git diff --check`를 실행한다.

3. 검토된 migration allowlist만 적용한다. 이 변경의 allowlist는 정확히 다음 한 파일이다.

   `supabase/migrations/20260831100000_add_analysis_provider_admission_leases.sql`

   dirty/mixed worktree에서는 격리된 임시 Supabase workdir에서 이 allowlist만 대상으로 dry-run을 실행한다. `--include-all`은 사용하지 않으며, 승인된 apply 뒤에는 원격 migration history를 확인한다. 이 worker 작업에서는 원격 migration을 적용하지 않는다.

4. 서비스 계정이 존재하고 활성 상태인지 확인하고, 검토된 IAM만 남아 있는지 확인한다. queue enqueuer는 queue-scoped여야 하며, 워커 runtime은 자기 역할의 private Cloud Run 서비스만 호출할 수 있어야 한다. Cloud Tasks OIDC service account, target URL, audience는 정확히 일치해야 한다. apply 전에 `--dry-run`과 `--check`를 모두 통과한다.

5. 검토된 canary runtime manifest에서만 `ANALYSIS_PROVIDER_ADMISSION_ENABLED=true`로 설정한다. workload-role 설정이 없거나 잘못되었거나 서로 다르면 fail-closed여야 한다. plaintext provider token이나 `latest` secret reference를 배포 manifest에 넣지 않는다.

Active capacity promotion은 release readiness와 동일한 공식 Vercel 증거를
배포자가 직접 확인해야 한다. `GET /v6/deployments`에서 READY production
deployment를 선택하고, 같은 token/team context로 정확한 uid/id의
`GET /v2/deployments/{uid-or-id}/aliases`를 조회해 public freeze/readiness
origin이 immutable URL 또는 반환된 alias와 일치하는지 확인한다. 관측된
Vercel Git SHA와 Cloud Run `analysis-v2-source-commit` label은 reviewed
source SHA와 같아야 하며 caller가 준 origin이나 capacity 전용 SHA는 증거가
아니다.

Bootstrap 단계는 의도적으로 gate-off다. 두 private role service를
`PREFLIGHT_TASKS_ENABLED=false`, `ANALYSIS_V2_TASKS_ENABLED=false`,
`ANALYSIS_V2_WORKER_ENABLED=false`, `ANALYSIS_PROVIDER_ADMISSION_ENABLED=false`로
배포한 후 exact ready revision, service URL/audience, resource, secret, role별
IAM을 확인한다. Initial/expanded gate-on revision 전에는 public V1 producer와
beta-prepare intake를 freeze하고 legacy queue를 pause하며 old invocation target을
차단한다. 실제 queue가 비어 있고 legacy V1/provider claim 및 ambiguous run이
0인지 확인해야 한다. Roleless fresh predecessor는 gate-off preflight drain에서만
허용한다. Admission을 켜기 전 readiness가 해당 cohort를 0건으로 증명해야
하며, gate-on 뒤 늦게 도착한 roleless fresh task는
`ANALYSIS_V2_LEGACY_FRESH_DRAIN_REQUIRED`와 `status=legacy_drain_required`를
담은 HTTP 200 acknowledgement로 terminal 처리해
retry loop를 만들지 않는다. Readiness는 promotion 후 검사가 아니라
promotion 직전의 authoritative barrier다.

## 출시 순서

### 1. Fake-provider 게이트

Harness와 대상 테스트를 clean CI checkout에서 실행한다. machine-readable 결과를 release evidence로 보관한다. 손실, 중복 terminal effect, ownership fence, provider 상한, DB contention, eventual drain 중 하나라도 실패하면 rollout을 중단한다.

### 2. Preflight 32 canary

`ANALYSIS_CAPACITY_STAGE=initial`, `ANALYSIS_WORKLOAD_ROLE=preflight`로 preflight 역할만 설정하고 배포한다. 기존 queue identity는 `analysis-preflight`다. `scripts/configure-analysis-capacity-queues.sh --role=preflight --dry-run`과 `scripts/deploy-analysis-capacity-workers.sh --role=preflight --dry-run`을 실행해 queue target, OIDC audience, runtime identity, service 이름, max instances, IAM 검사를 검토한다. Gate-on revision은 `--no-traffic`으로 배포하고 exact `latestCreatedRevisionName`/Ready revision과 provenance를 캡처·검증한 뒤 readiness를 실행한다. 캡처한 revision만 `--to-revisions=CAPTURED_REVISION=100`으로 promote하고 `latest`는 사용하지 않는다. 배포된 리소스에는 `--check`를 실행하고 승인 후에만 apply한다.

처음에는 32 미만의 제어된 provider 시작으로 확인한 다음 400건 acceptance burst를 보낸다. queue age, task retry, dispatch 실패, admission `capacity_pending`, lease 만료/복구, 역할/credential별 Apify 시작, Gemini lease 점유, DB lock/wait, terminal transition, ownership-fence 충돌을 관찰한다. Worker 상한은 initial 32, expansion 64지만 DB-global preflight Apify provider ceiling은 두 단계 모두 정확히 32다. 요청 손실, terminal effect 중복, owner fence 위반, 글로벌/slot budget 초과, bounded maintenance window 내 복구 실패가 있으면 rollback한다.

### 3. Preflight 64 확장

32 worker/provider canary의 관찰 구간을 통과하고 release evidence에 fake-provider 결과를 첨부한 후에만 `ANALYSIS_CAPACITY_EXPANSION_CANARY=true`를 설정한다. `ANALYSIS_CAPACITY_STAGE=expanded`로 같은 no-traffic staged check, exact revision readiness, captured-revision promotion 절차를 반복한다. Worker는 64로 확장하지만 preflight Apify provider ceiling은 정확히 32로 유지한다. provider budget을 늘리거나 소진된 tenth token으로 새 작업을 라우팅하지 않는다. Preflight pool은 계속 정확히 `primary,quinary,senary`다.

### 4. 유료 8 canary

`ANALYSIS_CAPACITY_STAGE=initial`, `ANALYSIS_WORKLOAD_ROLE=paid`와 유료 전용 target URL/audience/service identity로 독립 설정 및 배포한다. 기존 paid queue identity는 `analysis-v2-pipeline`이다. 새 paid `fresh_admission` task는 이 queue와 `/api/analysis/v2/worker`를 사용한다. Gate-off mixed-version window에서만 기존 roleless task를 `analysis-preflight`에서 drain하며, 해당 cohort가 0건임을 확인하기 전에는 admission을 켜지 않는다. 같은 no-traffic exact revision/readiness/captured-revision promotion 절차를 사용한다. 유료 요청을 최소 200건 durable하게 접수하되 active worker 실행은 8, paid Apify/Gemini provider ceiling도 각각 8로 유지한다. 유료 작업이 drain되는 동안 preflight queue age와 admission 성공률이 변하지 않는지 확인한다. Full followers/following은 secondary credential을 계속 사용하고 relationship 전용 budget 적용을 확인한다.

### 5. 유료 확장

측정된 유료 canary와 명시적 release 승인을 거친 뒤에만 `ANALYSIS_CAPACITY_STAGE=expanded`로 16 이상을 허용한다. 확장에는 `ANALYSIS_CAPACITY_EXPANSION_CANARY=true`, 최신 synthetic evidence, provider/DB 여유 확인이 필요하다. Worker는 16 이상이지만 paid Apify/Gemini provider ceiling은 각각 정확히 8이다. 워커 상한을 높여도 DB 글로벌 provider admission이나 기존 Gemini lease를 우회할 수 없다.

## 복구, 재시도, rollback

반복 task delivery는 durable request/job generation과 provider operation identity를 실행 전에 claim하므로 안전하다. 새 task payload는 `workloadRole`을 선언한다. Mixed-version drain 동안 기존 roleless payload는 기존 queue/service에서만 허용하고, 명시된 반대 role은 거부한다. 살아 있는 admission replay는 `already_acquired`를 반환하고, stale/expired fence는 현재 owner를 renew/release할 수 없다. bounded recovery pass가 만료 admission을 조회하고 recovery fence를 교체하며, 여전히 만료된 row만 재실행한다. provider 시작이 모호하면 admission과 provider-run checkpoint를 authoritative reconciliation을 위해 유지하고 무조건 재시작하지 않는다.

Rollback할 때는 먼저 해당 역할의 admission을 멈추고, 직전 정상 역할별 서비스와 queue 설정으로 배포한다. DB migration은 그대로 둔다. `ANALYSIS_PROVIDER_ADMISSION_ENABLED=false`이면 추가 테이블/RPC가 비활성 동작하므로 모든 lease와 provider-run reconciliation이 정리되기 전에 migration을 제거하면 안 된다. Recovery endpoint를 다시 실행하고 active/unreconciled admission 0, pending ownership fence 없음, terminal count 안정성을 확인한 뒤에만 cleanup을 검토한다.

배포 script는 기존 legacy queue script와 분리되어 있다. `--dry-run`은 `gcloud`를 호출하지 않고 mutation을 출력하며, `--check`는 변경 없이 drift를 보고한다. apply는 service account, concurrency, max scale, role, admission gate, queue target, OIDC audience를 재검증한다. 역할 간 queue, service, target URL, audience 충돌은 fail-closed다. Script 기본 동작은 check-only이며 mutation에는 `--apply`가 필요하다.

## 관찰 및 중단 기준

다음 중 하나라도 발생하면 on-call에 알리고 canary를 중지한다.

- admission 손실, terminal effect 중복, ownership 중복, 잘못된 workload role이 task를 claim함;
- initial 단계에서 `maxPreflightProviderActive > 32`, `maxPaidProviderActive > 8`, Gemini active lease가 8 초과;
- `primary`, `quinary`, `senary` 이외 credential로 preflight가 시작되거나, followers/following이 secondary 이외 credential로 시작됨;
- drain되지 않는 `capacity_pending`, lease 복구 실패, DB lock timeout/deadlock, 제한 없는 retry 증가;
- target URL, OIDC audience, service account, queue, IAM drift;
- fake-provider gate에서 provider 호출 또는 예상하지 못한 provider credit 사용.

Release evidence로 fake-provider JSON, 대상/전체 test log, scheduler benchmark 결과, migration dry-run/check 결과, expiry-recovery index의 `EXPLAIN (FORMAT JSON)`, canary aggregate counter를 보관한다. B-lite redesign과 추후 Supabase table-reduction cleanup은 별도 작업이며 이 rollout의 선행 조건이 아니다.
