# 서울 유료 Standard 용량 전환

이 절차는 운영 `analysis-paid-worker`의 **검토한 코드가 기존 크기에서 이미 배포된 후** 같은 이미지의 용량만 바꾼다. 운영자에게 필요한 입력은 canonical main에 연결된 운영 GCP 프로젝트, 검토한 커밋 SHA, 해당 커밋과 이미지 다이제스트가 짝을 이루는 배포 증빙, 새 리비전 접미사다. 별도 서비스·큐를 만들지 않는다.

| 대상 | 현재 이 절차가 받는 시작 구성 | 선택할 구성 |
| --- | --- | --- |
| 유료 Cloud Run 서비스 전체 최대 | 10 | 18 |
| 유료 리비전 최대·컨테이너별 자원·HTTP 동시성 | 8개·2 vCPU·2 GiB·1 | 18개·1 vCPU·2 GiB·3 |
| 유료 Cloud Tasks 동시 전달·초당 시작 | 8·8 | 40·32 |
| PostgreSQL의 승인된 유료 Standard용 Vertex | 기존 입구 8슬롯 | 전체 128·특징 80·추가 판독 48·분당 240 |

서비스와 큐는 다른 유료 플랜도 공유한다. 128슬롯 대상은 결제·작업·소유권이 검증된 운영 Standard다. 이 구분은 [워커의 유료 경로 선택](../../lib/services/analysis/paid-standard-capacity.ts)과 [DB 승인·최종 전송 예약](../../supabase/operations/20261126_expand_paid_standard_vertex.sql)이 집행한다. 기본 구성의 인스턴스당 특징 슬롯은 3개로, 18개 인스턴스가 최대 54개를 사용한다. `18i-40q`는 이를 반영한 [부하 시험 구성](../../tests/analysis/execution/fixtures/standard-shared-capacities.mjs)이다.

`18i-40q-f4` 비교 구성은 동일한 워커 리비전에 `PAID_STANDARD_PROCESS_FEATURE_SLOTS=4`를 명시한다. 승인된 v2.11 유료 Standard 프로필 배치가 인스턴스당 네 번째 특징 슬롯을 사용할 수 있어 18개 인스턴스에서 최대 72개다. 전체 모델 호출은 인스턴스당 8개이며 DB의 전체·특징·추가 판독 한도는 각각 128·80·48이다. 분석 시작부터 모든 소유자 이미지 수신까지 60분 이내이고 주문별 추가 판독 완료율이 99% 이상인 동시성 측정값을 해당 구성에만 사용한다.

유료 Standard 프로필 배치가 같은 후보의 특징 체크포인트를 읽은 뒤 첫 추가 판독을 시도할 때는 금액 예약 전에 워커의 추가 판독 슬롯과 공용 슬롯을 합산 최대 15초 기다린다. 실제 작업 마감까지 송신과 정산을 끝낼 여유가 더 짧으면 그만큼만 기다린다. 두 슬롯을 받으면 기존 예산·DB 입장 검사와 최초 송신을 진행한다.

## 전환 전

1. 기존 [유료 워커 배포기](../../scripts/deploy-analysis-capacity-workers.sh)의 일반 배포 절차로 검토한 커밋을 활성 유료 워커에 반영하고 운영 manifest로 `--role=paid --check`를 통과한다. 같은 출시에서 사전점검 워커·공개 생산자·공급자 연동을 별도로 변경하는 경우 해당 변경과 검증을 먼저 마친다. 계획 생성부터 최종 승격 또는 원복 검증까지 이 서비스·큐에는 배포 담당자 한 명만 쓴다. 그동안 기존 배포기, 자동 배포와 콘솔 수동 변경을 배제한다. LATEST 전환도 같은 단독 변경 창에서 수행한다.
2. [예산 예약 분류 마이그레이션](../../supabase/migrations/20261126100004_classify_open_vertex_budget_reservations.sql)의 적용 이력과 함수 권한을 확인한다. 기존 요청별·주문별·일별 상한을 사용한다. 진행 중인 예약만 정리되면 다음 호출이 들어갈 때 워커가 송신 전에 대기한다.

   승인된 운영 Supabase 연결에서 active 요청·작업·provider lease를 집계한다. 수동 [운영 SQL](../../supabase/operations/20261126_expand_paid_standard_vertex.sql)은 설치 시 유휴 상태, 기존 함수·권한·8슬롯·120 RPM을 직접 확인한다. 등록된 운영 프로젝트 한 곳에 적용한 뒤 128개의 슬롯, global budget `max_active=128`·`rate_limit_per_minute=240`, 전용 RPC의 역할 제한과 검토한 함수 지문을 대조한다. 기존 8슬롯 호출자와 80/48 단계 상한은 SQL이 검사하는 함수 및 [네이티브 회귀](../../tests/analysis/execution/fixtures/paid-standard-capacity.test.ts)의 범위다. 이미 설치된 SQL은 설치 이력과 함수 지문으로 검증한다.
3. DB의 `public.paid_analysis_capacity_policy` 단일 행에서 `max_active`, `validation_ref`, `expected_basic_max_minutes`, `expected_standard_max_minutes`를 읽고 복원용 값을 보존한다. 이전 정책과 전환할 정책을 같은 출시 기록에 둔다. 신규 주문을 받기 전에 같은 코드·후보 범위·큐·DB·워커 구성에서 검증한 동시 주문 수 N을 `max_active`에, 검증 근거를 `validation_ref`에 반영한다. 시간 측정 근거가 있는 플랜의 ETA만 해당 `expected_*_max_minutes`에 넣는다. N은 인스턴스 수나 큐 동시성과 독립적이다. NULL인 `max_active`는 기존 무제한 입장 경로다. 접수를 닫으려면 기존 출시 제어를 사용한다. [결제 대기 정책](../../supabase/migrations/20261126100000_add_paid_analysis_capacity_queue.sql)
4. 현재 서울 할당량과 다른 서비스의 점유를 관측한다. 18개 유료 인스턴스가 모두 동작할 때 18 vCPU·36 GiB를 사용한다. 프로젝트 할당량과 실제 분당 요청 한도는 같은 시점에 조회한다.

## 후보와 롤백 명령 만들기

아래 플래너는 로컬 Git에서 검토 SHA의 유료 소유권·송신 예약 코드 경로를 확인하고 기존 서비스와 큐에 각각 한 번씩 `describe`만 수행한다. 환경 변수, IAM 구성원, 자격 증명은 결과에 포함하지 않는다. 입력 `$verified_release_json`은 기존 출시 검증에서 확정한 `project`, `service`, `sourceSha`, `image` 네 필드를 담는다. `image`에는 저장소 경로와 `@sha256:…`가 모두 필요하다. [Cloud Build 검증기](../../scripts/capacity-identity-epoch/cloud-build.ts)는 저장소 커밋 또는 GCS 소스의 검토 SHA·고정 세대와 성공한 빌드의 결과 이미지를 대조한다. 이 확인을 거친 기존 출시 기록에서 네 값을 추출한다. 해당 기록이 없으면 먼저 이 검증을 마친다. 서비스 라벨과 현재 이미지의 단순 조회만으로는 두 값의 연결을 증명할 수 없다. 명령의 인수는 JSON 배열로 저장한다. 같은 커밋, 단일 100% 리비전과 원래 트래픽 방식(최신 자동 추적 또는 리비전 고정), 고정 이미지 다이제스트, 유료 역할·큐·지역, 원래 수치와 플래그가 일치해야 명령이 생성된다.

```bash
umask 077
node scripts/plan-paid-standard-regional-capacity.mjs \
  --plan-paid-standard-18i-40q "$prod_project" "$reviewed_sha" "$verified_release_json" "$new_suffix" > "$release_dir/paid-shape.json"
```

인스턴스당 특징 4개로 검증을 마친 구성을 선택할 때는 같은 명령에서 `--plan-paid-standard-18i-40q-f4`를 사용한다. 계획의 `stage`에서 `PAID_STANDARD_PROCESS_FEATURE_SLOTS=4`를, `restoreTemplate`에서 그 설정의 제거를 확인한다.

다음 함수는 출시 담당자가 **지정한 한 단계**의 인수 배열을 그대로 실행한다. 실행 직전에 계획과 현재 리비전·트래픽·큐가 일치하는지 확인한다. 해당 접미사의 기존 리비전이 있으면 배포 결과를 먼저 조회한다. 이전 요청이 성공했으면 그 결과를 검증해 다음 단계로 진행한다.

```bash
candidate=$(jq -er .candidate "$release_dir/paid-shape.json")
run_shape_step() {
  python3 - "$release_dir/paid-shape.json" "$1" <<'PY'
import json, subprocess, sys
from pathlib import Path
steps = json.loads(Path(sys.argv[1]).read_text())
allowed = {'stage', 'raiseServiceCap', 'promote', 'raiseQueue', 'restoreQueue',
           'restoreTraffic', 'restoreServiceCap', 'restoreTemplate', 'promoteRestoredTemplate'}
if sys.argv[2] not in allowed:
    raise SystemExit('unknown release step')
subprocess.run(steps[sys.argv[2]], check=True)
PY
}
```

1. `run_shape_step stage`가 동일 이미지로 **무트래픽 후보**를 만든다. 기존 서비스 최대 10과 큐 8/8은 이 단계에서 유지된다. `gcloud run revisions describe "$candidate" --region=asia-northeast3 --project="$prod_project" --format=json`의 Ready, 이미지 다이제스트, 1 vCPU·2 GiB·HTTP 3·리비전 최대 18, `PAID_STANDARD_VERTEX_CAPACITY_MODE=expanded128`와 admission 활성화를 허용 목록으로 비교한다. 원래 리비전이 계속 100%인지 확인한다. IAM·서비스 계정·비밀 참조·다른 환경 설정은 원래 리비전과 메모리 안에서 비교하고 일치 여부만 출력한다.
2. `run_shape_step raiseServiceCap` 후 서비스의 **최상위** `metadata.annotations["run.googleapis.com/maxScale"]`이 18인지 확인한다. 리비전의 `autoscaling.knative.dev/maxScale`도 18이어야 한다. `run_shape_step promote` 후 선택한 후보가 트래픽 100%를 받는지 확인한다.
3. `run_shape_step raiseQueue` 후 정확한 `analysis-v2-pipeline`의 `rateLimits.maxConcurrentDispatches=40`, `maxDispatchesPerSecond=32`와 기존 재시도·OIDC 설정을 검증한다. 이 단계까지 완료되고 DB 정책과 검증 근거가 일치할 때 접수를 연다. 운영 측정에서는 주문별 결제 대기, 자리 배정부터 발행·이행까지 걸린 시간, 소유자가 결과와 이미지를 읽을 수 있게 된 시점을 각각 기록한다. 동일 조건의 QA에서는 소유자가 마지막 WebP 본문을 받은 시각까지 포함해 1시간 달성 여부를 판단한다.

## 실패와 복구

변경 호출이 타임아웃되면 서비스·지정 리비전·큐를 다시 조회해 실제로 반영된 단계부터 식별한다. 실행 중인 주문과 미결 공급자 원장은 유지한다. 어느 단계에서 멈췄든 DB 정책을 변경했다면 신규 유입을 제어한 상태에서 보존한 네 필드를 모두 복원하고 조회값으로 확인한다. 후보 생성 직후나 Cloud 변경을 시작하기 전의 실패도 여기에 포함된다.

1. 후보만 만들어진 직후에도 롤백 절차를 완료한다. `--no-traffic`은 새 서비스 템플릿을 만들고 기존 최신 자동 추적(LATEST)을 이전 리비전으로 고정할 수 있다. 이전 리비전 100%를 확인한다. 서비스 최대·큐가 그대로라면 3단계로 진행한다.
2. 서비스 최대나 트래픽·큐가 바뀌었다면 신규 유입을 제어하고 기존 주문의 이행을 확인한다. 변경된 항목에 대해 `restoreQueue`, `restoreTraffic`, `restoreServiceCap` 순서로 `run_shape_step`을 실행한다. 이전 리비전 100%, 큐 8/8, 전체 최대 10을 각각 다시 조회한다. 미결 attempt·lease·비용 행, 슬롯 테이블과 이미 설치된 SQL은 보존한다.
3. `restoreTemplate`으로 같은 이미지·원래 크기·원래 환경의 무트래픽 리비전을 만든다. 원본과 복원 후보의 환경·권한·다이제스트 및 2 vCPU·2 GiB·HTTP 1·최대 8을 대조한다. 서비스의 `status.latestCreatedRevisionName`이 계획의 `restored`이고, 해당 리비전의 Ready가 True이며, 트래픽은 이전 리비전 100%인지 확인한다. 사이에 다른 리비전이 생긴 경우 승격을 중단한다.
4. `promoteRestoredTemplate`을 실행한다. 원래 최신 자동 추적이었다면 `--to-latest`, 리비전 고정이었다면 검증한 복원 리비전 이름을 사용한다. 원래 생략된 트래픽 설정은 Cloud Run의 기본인 최신 자동 추적으로 복구한다. 복원 리비전 100%와 `spec.traffic`의 이전 방식이 맞는지 확인한 뒤 기존 `--role=paid --check`를 실행한다.

확장 중인 서비스에는 기존 8/16 전용 worker·queue 래퍼를 다시 적용하지 않는다. 코드 리비전 변경 시에는 이 절차로 기본 구성을 회복하고 기존 소스·IAM·큐 배포 검증을 거친 뒤, 새 검토 커밋에 대해 명령을 다시 생성한다.
