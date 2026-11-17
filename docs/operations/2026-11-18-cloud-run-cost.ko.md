# Cloud Run 비용 절감 후속 확인

확인일은 2026-11-18 KST입니다. 저장소와 운영 설정을 변경하지 않았으며 앱 HTTP endpoint, 외부 스크래핑, AI, 결제 호출을 실행하지 않았습니다.

## 확인 결과

Cloud Monitoring에서 확인한 사용량에 공식 Cloud Billing Catalog의 해당 월 서울 Tier 2 KRW 정가를 적용하면, compute 비용은 배포 전 약 1,025.5원/일에서 배포 직후 215.1원/일로 79.0% 감소합니다. 최근 완료된 7일은 약 218.5원/일입니다. 이 값은 사용량 기반 정가 환산액입니다. 실제 청구 금액과 결제 금액은 확인하지 못했습니다.

비교 기간은 모두 KST 00시부터 다음 날 00시까지의 완료된 7일입니다. 배포 당일인 10월 19일은 비교에서 제외했습니다. 10월 12~18일과 10월 20~26일을 비교하고, 최근 11월 11~17일의 지속 효과도 확인했습니다.

| 하루 평균 | 10/12~18 | 10/20~26 | 11/11~17 |
|---|---:|---:|---:|
| paid 요청 수 | 1,728 | 576 | 576 |
| paid 과금 인스턴스 시간, 초 | 3,409.6 | 1,347.9 | 1,345.5 |
| paid CPU 할당, vCPU초 | 6,853.8 | 2,699.1 | 2,727.0 |
| paid 메모리 할당, GiB초 | 6,819.0 | 2,695.7 | 2,691.0 |
| preflight 요청 수 | 1,441.7 | 1,440.6 | 1,451.0 |
| preflight 과금 인스턴스 시간, 초 | 623.8 | 779.3 | 812.2 |
| preflight CPU 할당, vCPU초 | 1,266.5 | 1,568.7 | 1,664.2 |
| preflight 메모리 할당, GiB초 | 1,248.0 | 1,558.8 | 1,622.9 |
| auth 요청 수 | 0 | 0 | 0 |
| auth 과금 인스턴스 시간, 초 | 86,397.6 | 0 관측 | 0 관측 |
| auth 메모리 할당, GiB초 | 43,198.6 | 0 관측 | 0 관측 |

`0 관측`은 해당 기간의 시계열이 없다는 의미입니다. auth는 10/20~11/17의 29일 전체에서 요청 수, 과금 인스턴스 시간, CPU 할당 및 메모리 할당 시계열이 없었습니다. 같은 프로젝트의 나머지 Cloud Run 서비스 2개도 해당 기간의 사용량 시계열이 없었습니다. Cloud Run job 정의는 12개이며, 10/12~11/17 기간 cloud_run_job의 과금 인스턴스 시간, CPU 할당 및 메모리 할당 시계열은 모두 없었습니다. 서울 worker pool은 0개였습니다.

| 정가 환산 compute, 원/일 | 10/12~18 | 10/20~26 | 11/11~17 |
|---|---:|---:|---:|
| paid | 345.3 | 136.0 | 135.7 |
| preflight | 63.8 | 79.0 | 82.7 |
| auth | 약 616.4 | 0 관측 | 0 관측 |
| 합계 | 약 1,025.5 | 215.1 | 218.5 |

paid 요청 수 감소율은 66.7%이고, 과금 인스턴스 시간 감소율은 60.5%입니다. paid 요청 1회당 과금 인스턴스 시간은 약 1.973초에서 2.340초로 증가했습니다. preflight는 약 0.433초에서 0.541초로 증가했습니다. 처리 시간 증가가 당초 약 83% 절감 예상보다 낮은 정가 환산 절감률의 일부를 설명합니다. 처리 시간이 증가한 원인은 조사하지 않았습니다.

최근 주 preflight 10,157건 중 11월 13일 KST에 5xx 100건이 관측되었습니다. Logging 상태 코드 집계는 500 76건, 503 24건입니다. 비용 비교에 포함된 재시도 등 작업 혼합의 가능성을 남깁니다. 이 조사에서 원인 확인이나 수정은 수행하지 않았습니다.

## 배포 및 현재 설정 근거

- PR 606은 10/19 13시 59분 19초 KST, PR 607은 14시 17분 20초 KST에 병합되었습니다.
- Cloud Scheduler Audit Log에서 paid recovery schedule을 `2-59/5 * * * *`로 바꾼 UpdateJob가 10/19 14시 18분 53~54초 KST에, ResumeJob가 14시 18분 55~56초 KST에 확인되었습니다.
- auth 새 revision 생성은 10/19 14시 38분 43초 KST입니다. Run Audit Log의 ReplaceService는 14시 38분 42초 및 54초 KST입니다.
- 시간별 Monitoring에서 10/19 13시대 paid 72건, 14시대 39건, 15시대부터 24건/시간으로 바뀝니다. auth 과금 시간은 14시대까지 존재하며 15시대부터 시계열이 사라집니다.
- 현재 paid recovery와 retention은 모두 ENABLED이며 각각 `2-59/5 * * * *`, `*/5 * * * *`입니다. 둘 다 paid 서비스로 향합니다. preflight recovery는 ENABLED이며 매분 실행하고 preflight 서비스로 향합니다. Scheduler timezone은 Etc/UTC입니다.
- 현재 auth service/revision의 min annotation은 미지정이며 기본값은 0입니다. traffic은 단일 revision에 100%입니다. 이전 auth revision은 min=1입니다. CPU 1개, memory 512Mi, startup CPU boost=true입니다.
- paid와 preflight는 CPU 2개, memory 2Gi, request-based CPU throttling=true이며 startup CPU boost=true입니다.

## 정가 및 계산

공식 Cloud Billing Catalog API의 `services.skus.list`에서 KRW, 서울 Tier 2 request-based SKU를 조회했습니다. 활성 CPU 이름의 공백 표기가 2개여서 이름의 공백을 정규화한 뒤 선택했습니다.

| 단가 | 2026-10월 KRW | 2026-11월 KRW |
|---|---:|---:|
| 활성 CPU 1 vCPU초 | 0.045654 | 0.045133367 |
| 활성 메모리 1 GiB초 | 0.004755625 | 0.004701392 |
| minimum instance idle CPU 1 vCPU초 | 0.004755625 | 0.004701392 |
| minimum instance idle memory 1 GiB초 | 0.004755625 | 0.004701392 |
| 무료 구간 초과 요청 1건 | 0.0005435 | 0.000537301 |

paid 및 preflight compute는 CPU allocation time × 활성 CPU 단가 + memory allocation time × 메모리 단가입니다. 이 계산에는 startup CPU boost가 추가한 CPU allocation time도 포함됩니다.

auth는 min=1, CPU=1, memory=0.5GiB, 요청 0건에 따른 idle 비용이 대부분입니다. metric label에 active/idle 구분이 없으므로 billable time에서 작은 시작 CPU allocation을 보정한 근삿값을 썼습니다. boost 시작 시간을 CPU allocation/2로 보는 경우 약 616.435원/일, /1로 보는 경우 약 616.428원/일로 반올림 결과는 동일합니다.

이 프로젝트 관측 요청 수만으로 요청 무료 구간 소진을 가정하지 않았습니다. 만일 billing account의 무료 구간이 다른 프로젝트에서 이미 소진되었다면 요청 정가 추가액은 세 기간 각각 약 1.72원, 1.10원, 1.09원/일입니다.

free tier와 credit, 계약 할인, 세금, invoice 보정, 네트워크 전송, Cloud Scheduler, Cloud Logging, Artifact Registry 등은 이 compute 환산표에 반영하지 않았습니다. free tier는 billing account의 여러 프로젝트에 걸쳐 합산되므로 이 프로젝트 사용량만으로 실제 공제 금액을 확정할 수 없습니다.

## 실제 청구 확인의 한계

프로젝트의 billingEnabled는 true입니다. 이 프로젝트에서 `bq ls --all`로 접근 가능한 dataset은 없었습니다. 연결 billing account의 프로젝트 목록 조회는 현재 계정 권한으로 거부되었습니다. 따라서 다른 프로젝트의 기존 billing export를 발견하거나 계정 단위 비용을 조회하지 못했습니다. export가 전혀 없다는 결론은 내리지 않습니다. 새 export, dataset, 권한, 설정을 만들지 않았고 BigQuery 과금 쿼리도 실행하지 않았습니다.

실제 청구 확인에는 기존 Cloud Billing Reports의 해당 프로젝트/Cloud Run 비용 집계 또는 이미 존재하는 export의 접근 가능한 위치가 필요합니다. 사용 기간별 cost, credits, currency, invoice month를 함께 확인해야 합니다. 일별 사용량 기간과 invoice period는 서로 다를 수 있습니다.

## 재현 방법

운영 API는 로컬 gcloud의 기존 인증으로 조회했습니다. 보고서에는 기간별 집계와 설정 확인 결과만 기록했습니다.

Monitoring의 기준 filter는 `metric.type="run.googleapis.com/<metric>" AND resource.type="cloud_run_revision"`입니다. job 확인에는 `cloud_run_job`을 적용했습니다. 조회 metric은 `request_count`, `container/billable_instance_time`, `container/cpu/allocation_time`, `container/memory/allocation_time`입니다. 기간은 `2026-10-11T15:00:00Z` 이상 `2026-11-17T15:00:00Z`까지입니다. `alignmentPeriod=3600s`, `perSeriesAligner=ALIGN_SUM`, 전체 pagination을 사용했고, 각 hour의 종료 시각에서 한 시간을 빼 KST 시작 날짜에 합산했습니다. 비교된 각 날짜는 24시간이며 최근 미완료인 11/18은 제외했습니다.

조회 도구는 gcloud Run services/revisions/jobs/worker-pools list, 서비스 describe, Scheduler jobs list, Logging read, Billing project describe, Billing projects list, bq dataset list, Monitoring REST, 공식 Cloud Billing Catalog REST입니다. Catalog 전체 서비스 목록 첫 호출에서 429가 발생하여 Cloud Run service를 직접 지정하는 조회로 전환해 성공했습니다. 일부 CLI의 미지원 옵션은 정정 후 다시 읽었습니다.

## 출처

- [PR 606](https://github.com/0mininseoul/yeosachin-scanner/pull/606)
- [PR 607](https://github.com/0mininseoul/yeosachin-scanner/pull/607)
- [Cloud Run 요금 및 무료 구간](https://cloud.google.com/run/pricing)
- [Cloud Run Monitoring 지표 정의](https://docs.cloud.google.com/monitoring/api/metrics_gcp_p_z)
- [Cloud Billing Catalog API](https://docs.cloud.google.com/billing/docs/reference/rest/v1/services.skus/list)
- [Cloud Billing Reports](https://docs.cloud.google.com/billing/docs/how-to/reports)
