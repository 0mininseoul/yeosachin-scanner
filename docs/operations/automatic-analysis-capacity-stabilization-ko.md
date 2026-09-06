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

## initial 단계 service account identity roll-forward

이미 서비스 중인 `initial` worker가 새 Cloud Tasks caller, 새 Cloud Run runtime
identity, 그리고 현재 revision에 아예 없던 role enqueuer 환경값을 한 번에
채택해야 할 때가 있다. 일반 검증은 exact이라 이 세 가지를 모두 거부하므로
`--allow-initial-identity-roll-forward`를 명시해야 한다. 이전 identity는 절대
코드에 넣지 않고 실행할 때마다 외부에서 공급한다.

**이 허용은 preflight 전용이다.** 활성 public runtime은 preflight producer
contract에 대해서만 producer configuration fingerprint를 공개한다. 따라서 회전된
caller/target/audience가 이미 라이브 producer contract임을 공개된 증거로 증명할
수 있는 role은 preflight뿐이다. paid producer에는 이에 상응하는 공개 증거가
없으므로 `--role=paid`에서는 관측이나 mutation 이전에 곧바로 거부한다. 이는 현재
공개된 증거의 한계이지 paid에 producer가 없다는 뜻이 아니다. paid identity 회전은
별도의 검토된 증거 경로가 필요하며 여기서는 범위 밖이다. 일반 paid apply 동작은
바뀌지 않고 그대로 exact이다. paid task caller, target URL, OIDC audience drift는
여전히 fail-closed다.

다음 조건이 전부 성립할 때만 허용한다.

- `--role=preflight`.
- 명시적 `--apply`와 `--reconcile-iam`. invoker binding을 새 caller로 교체해야
  하므로 check/dry-run은 거부한다.
- 대상 stage `initial`과 관측 stage `initial`. `--allow-bootstrap-initial-transition`과
  함께 쓸 수 없다.
- 완전한 외부 공급 이전 상태 단언
  `ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_OLD_TASK_SERVICE_ACCOUNT_EMAIL`,
  `..._OLD_ENQUEUER_SERVICE_ACCOUNT_EMAIL`(현재 revision에 enqueuer 값이 없으면
  리터럴 `absent`), `..._OLD_RUNTIME_SERVICE_ACCOUNT_EMAIL`, `..._OLD_SOURCE_SHA`가
  관측된 서비스와 정확히 일치해야 한다. 모든 이전 identity는 task 프로젝트의
  service account여야 하고, 8개 목표 workload identity 전부 및 build identity와
  달라야 하며, 서로도 pairwise distinct여야 한다. 이전 source SHA는 검토된 source
  SHA와 달라야 한다. 이 단언을 flag 없이 공급하면 아무것도 관측하기 전에 거부한다.
- target queue가 전체 resource 식별자
  `projects/PROJECT/locations/LOCATION/queues/QUEUE`와 정확히 일치해야 한다. 다른
  프로젝트나 리전의 동명 queue는 거부한다. 또한 `PAUSED`이고 관측상 비어 있어야
  한다. 이전 caller identity를 그대로 들고 있는 in-flight task가 남으면 안 된다.
- preflight recovery scheduler가 정지 상태임을 증명해야 한다. `PAUSED` Cloud Tasks
  queue도 `createTask`는 계속 받고, 현재 서비스 중인 recovery endpoint는 *이전*
  caller identity로 enqueue한다. 따라서 매분 도는 scheduler가 `ENABLED`로 남아
  있으면 queue를 비어 있다고 관측한 뒤에도 이전 caller task가 들어올 수 있다.
  그래서 정확한 job resource `projects/PROJECT/locations/LOCATION/jobs/JOB`가
  `PAUSED`이고 검토된 attemptDeadline/retry contract를 유지해야 하며, 외부에서
  공급한 `ANALYSIS_CAPACITY_INITIAL_ROLL_FORWARD_PREFLIGHT_RECOVERY_PAUSE_EPOCH`
  (엄격한 10진 epoch 초, 미래 값 불가)가 최소 660초 이전이어야 한다. 660초는
  배포된 Cloud Run 요청 timeout 600초에 여유를 더한 값이다. 이 epoch은 감사된
  pause 시각을 다음 정수 초로 **올림**해서 쓴다. 관측된 attempt timestamp도 같은
  방식으로 올림하므로, 소수점 이하 잔여가 최대 0.999초의 추가 경과를 벌어줄 수
  없다. job 이름과 해석된 scheduler location(`PREFLIGHT_TASKS_MAINTENANCE_LOCATION`,
  없으면 Cloud Run region으로 폴백하며 Cloud Tasks queue location이 아니다)은
  `gcloud` 인자로 전달되기 전에 검증한다. **`lastAttemptTime`
  부재는 drain을 증명하지 않는다.** 실제 시도 몇 초 뒤에도 paused job이 이 필드를
  더 이상 보고하지 않는 사례가 관측되었으므로, 나이 든 pause 단언이 필수이고
  `lastAttemptTime`이 있는데 window 안이면 그것도 거부한다. `userUpdateTime`은
  문서상 생성 시각이므로 pause 시각으로 쓰지 않는다.
- preflight와 paid의 task/enqueuer/runtime/maintenance 8개 목표 workload identity가
  모두 pairwise distinct이고, 검토된 runtime manifest가 목표 role enqueuer 값을
  이미 담고 있어야 한다.
- 공개된 Vercel 증거 체인 전체가 목표 contract와 이미 일치해야 한다. 선택된 READY
  production deployment의 Git SHA가 검토된 source SHA와 같고, public freeze origin이
  바로 그 deployment URL 또는 반환된 alias에 묶여 있으며, next-deploy production
  environment metadata가 필요한 producer key를 담고 hidden production 값이 없고,
  활성 producer fingerprint가 목표 caller/target/audience와 일치해야 한다.
- 기존 서비스 IAM에 조건 없는 `roles/run.invoker` binding이 정확히 하나 있고 그
  member가 단언된 이전 task caller와 변경되지 않은 현재 maintenance caller뿐이어야
  한다. member 추가, public/`allAuthenticatedUsers` member, IAM condition, member
  누락, invoker binding 2개 이상, invoker binding 부재는 `set-iam-policy` 이전에
  거부한다.

모든 증거는 service/IAM/deploy mutation 이전에 수집한다. (generation 기반 GCS
deploy lock은 그보다 먼저 획득한다. 이는 이 실행의 상호배제 토큰이며 service,
IAM, revision을 바꾸지 않는다.) 그리고 단 한 번의 `set-iam-policy` 직전에
**최종 mutation barrier**에서 전부 다시 증명한다. read와 write 사이의 간격이 바로
out-of-band 변경이 끼어드는 지점이기 때문이다. barrier는 정확한 paused/empty
target queue를 다시 describe하고, recovery scheduler와 나이 든 pause 단언을 다시
확인하고, Vercel 증거 체인 전체를 다시 돌리고, 서비스를 다시 읽어 동일한
`metadata.resourceVersion`과 `metadata.generation`, 단언된 이전 task/enqueuer/runtime
identity, 이전 source SHA, 그리고 포착해 둔 serving traffic 배분이 그대로인지
요구하고, 마지막으로 IAM policy를 다시 읽어 정확한 이전 invoker binding과 비어
있지 않은 `etag`를 요구한다. 목표 policy는 바로 그 최신 policy JSON에서 `etag`를
보존한 채 만들고, `set-iam-policy`를 재시도 없이 정확히 한 번 호출한 뒤 다시
읽는다. 관측된 policy는 서버가 새로 발급한 `etag`를 제외하고 의도한 policy와
같아야 한다. 무관한 binding 변경, binding/member 추가, condition 주입, policy
version 변경은 `gcloud run deploy` 이전에 실패시킨다. read 사이에 invoker binding이
이미 목표 binding으로 바뀌어 있으면 성공으로 취급하지 않고 fail-closed 한다.

이 허용은 predeploy 전용이며 위 세 identity 값만 대상으로 한다. 그 밖의 환경,
source, maintenance, target, audience, queue, stage, traffic 검사는 모두 그대로
exact이다. flag가 켜진 경우 source provenance는 문법적으로 유효한 아무 예전 SHA가
아니라 외부에서 단언한 이전 SHA와 정확히 같아야 한다. staged revision은 검토된
manifest와 runtime identity에 대해 exact하게 검증하고, 승격된 revision도 다시
exact하게 검증한다. 승격 이후 task caller, enqueuer, runtime identity drift는 각각
독립적으로 자동 rollback을 발동한다.

예외 경로 실행은 recovery scheduler를 절대 재개하지 않는다. 성공 시 job이 여전히
`PAUSED`임을 다시 증명하고 resume을 유예했다고 보고한다. 모든 실패 경로도 paused로
남긴다. 두 role 배포, Vercel, IAM, 로그, ledger, provider-free probe가 모두 통과한
뒤 외부 최종 rollout이 두 recovery scheduler와 두 queue의 유일한 resume을 담당한다.

### rollback이 실제로 하는 일

실패를 다룰 때 이 부분을 정확히 알아야 한다. **자동 rollback은 traffic만
복원한다.** 포착해 둔 배포 이전 revision으로 serving 배분을 되돌리고 일치를
검증할 뿐이며, 이전 source를 재배포하지 않고 이전 IAM policy도 복원하지 않는다.
이미 성공한 `set-iam-policy`는 그대로 적용된 채 남는다.

따라서 identity roll-forward가 실패한 뒤에는

- target queue와 recovery scheduler는 `PAUSED`로 남는다.
- invoker 회전 *이후*에 실패했다면 서비스는 이미 회전된 invoker binding으로
  동작 중이다. 이전 binding 복원은 별도의 명시적 운영 단계이며, 재시도 전에 새로
  읽은 policy와 그 `etag`에 대해 직접 검증해야 한다.
- 회전 전에 queue를 paused/empty로 만들었으므로 invoke 권한을 잃은 caller
  identity에 묶여 남는 task는 없다.

queue와 recovery scheduler 재개는 승격된 revision 검증과 최종 rollout 점검이 모두
끝난 뒤에만 한다.

## 관찰 및 중단 기준

다음 중 하나라도 발생하면 on-call에 알리고 canary를 중지한다.

- admission 손실, terminal effect 중복, ownership 중복, 잘못된 workload role이 task를 claim함;
- initial 단계에서 `maxPreflightProviderActive > 32`, `maxPaidProviderActive > 8`, Gemini active lease가 8 초과;
- `primary`, `quinary`, `senary` 이외 credential로 preflight가 시작되거나, followers/following이 secondary 이외 credential로 시작됨;
- drain되지 않는 `capacity_pending`, lease 복구 실패, DB lock timeout/deadlock, 제한 없는 retry 증가;
- target URL, OIDC audience, service account, queue, IAM drift;
- fake-provider gate에서 provider 호출 또는 예상하지 못한 provider credit 사용.

Release evidence로 fake-provider JSON, 대상/전체 test log, scheduler benchmark 결과, migration dry-run/check 결과, expiry-recovery index의 `EXPLAIN (FORMAT JSON)`, canary aggregate counter를 보관한다. B-lite redesign과 추후 Supabase table-reduction cleanup은 별도 작업이며 이 rollout의 선행 조건이 아니다.
