# 2026-10-03 W06 후보 크기 측정과 추가 축소 필요성 판정

판정: **현재 범위의 추가 DB 축소는 불필요한 것으로 확정하고 W06 조사를 종료한다.** 대상 9개가 차지하는 물리 공간은 합계 **393,216 bytes = 384 KiB**, 같은 조회의 public base table 150개 총량 대비 **약 0.493%**다. 이 작은 공간 이득을 위해 기존 실행·복구·보존 의존성을 대체할 필요성은 확인되지 않았다. 현재 DROP-ready 대상은 없으며 새 DDL을 작성하거나 적용하지 않는다. 이는 이번 후보와 현재 관측에 대한 작업 필요성 판단으로, 향후 모든 DB 최적화가 불필요하다는 뜻은 아니다.

## 1. 새 관측과 이전 관측의 구분

[크기 조회 안전 DTO](./2026-10-03-w06-size-followup.safe.json)는 상위 작업에서 **2026-10-03 16:31:12.196 KST**(`2026-10-03T07:31:12.196Z`)에 수행한 읽기 전용 조회 결과다. 테이블 크기와 컬럼·타입 metadata만 포함하며 업무 행을 조회하지 않았다. 이 보고서는 해당 DTO를 읽어 계산했고 별도 원격 조회를 수행하지 않았다. DTO의 다른 컬럼 metadata는 W04용이며 W06 축소 판단의 근거로 사용하지 않는다.

[기존 provenance·의존성 보고서](./2026-10-03-w05-w06-provenance.ko.md)의 후보 9개 exact rows=0은 **같은 날 04:02:21 KST의 과거 관측**이다. 이번 16:31 조회는 행 수를 다시 세지 않았으므로 현재도 0행이라고 주장하지 않는다. main fork의 할당 크기로도 현재 행 수나 실행 여부를 추론하지 않는다. 기존 DB dependency 조회는 03:58:05 KST이며 이번 크기 조회가 그 의존성을 다시 검증한 것은 아니다.

## 2. 후보별 물리 공간

후보 9개는 모두 존재하고 `relkind=r`이다. 단위는 KiB이며 **1 KiB = 1,024 bytes**다.

| 테이블 | main fork | table | index | total |
| --- | ---: | ---: | ---: | ---: |
| `account_lifecycle` | 0 | 8 | 16 | 24 |
| `analysis_interaction_evidence` | 0 | 24 | 48 | 72 |
| `analysis_interaction_jobs` | 16 | 24 | 48 | 72 |
| `analysis_interaction_scores` | 0 | 24 | 48 | 72 |
| `analysis_provider_runs` | 8 | 16 | 16 | 32 |
| `analysis_v2_replay_capture_audit_events` | 0 | 8 | 8 | 16 |
| `analysis_v2_replay_capture_authorizations` | 0 | 8 | 24 | 32 |
| `analysis_v2_replay_capture_fragments` | 0 | 8 | 16 | 24 |
| `payment_events` | 0 | 8 | 32 | 40 |
| **합계** | **24** | **128** | **256** | **384** |

`main`은 `pg_relation_size`, `table`은 `pg_table_size`, `index`는 `pg_indexes_size`, `total`은 `pg_total_relation_size`에 해당한다. table에는 main과 보조 fork 및 TOAST 저장 공간이 포함되므로 **main을 table에 다시 더하지 않는다**. 모든 행에서 table + index = total을 확인했다.

같은 DTO의 public base table 총량은 **79,781,888 bytes = 약 76.086 MiB**이고, 비중은 `393216 / 79781888 × 100 = 0.4928637…%`다. 이 분모는 public base table과 그 부속 저장 공간이며 전체 데이터베이스·모든 schema·백업 또는 프로젝트 과금 용량을 뜻하지 않는다.

384 KiB는 현재 후보 9개의 relation과 부속 저장 공간을 전부 없앤다고 가정할 때 그 대상에서 줄일 수 있는 공간의 상한이다. 실제 제거 후 순이득은 대체 저장소·복구 자료·보존 정책과 함께 평가해야 한다. 이 수치로 Supabase 청구액 감소, I/O 감소, 쿼리 지연 또는 성능 개선을 보장할 수 없다.

## 3. 현재 추가 축소가 필요하지 않은 이유

기존 보고서는 다음 경계를 확인했다. 이 후속 작업에서는 이를 다시 구현하거나 폐기하지 않았다.

- replay capture는 replay reader, capture 등록·결합·retention routine과 FK 관계가 남아 있다.
- V1 provider와 interaction 세 테이블은 보존된 start/status/step 경로 및 완료·실패 정리 routine의 상태·증거·checkpoint로 사용된다.
- account lifecycle은 account canonical write가 활성화된 경우 삭제 단계 기록 실패 시 삭제 흐름을 중단하는 경계가 있다. payment events에는 조건부 mirror와 maintenance replay 경로가 있다. 이전 웹 환경 목록에서 관련 설정 항목이 없었다는 관측은 runtime 비활성화·worker 설정·복원 의존성 부재를 증명하지 않는다.

현재 물리 공간 상한은 384 KiB이고, 해당 후보 때문에 발생한 비용·지연·운영 장애의 새로운 증거는 없다. 반면 제거하려면 위 실행 경로와 복구·보존 경계를 별도로 대체해야 한다. 따라서 **공간 회수를 목적으로 그 대체 작업과 DDL을 시작할 실익이 없다**고 판단한다. 단순히 행 수 재조회나 추가 승인만 기다리는 상태로 남기지 않고, 이번 W06의 추가 축소 조사 자체를 종료한다. 22-table 수 목표는 사용하지 않는다.

## 4. 다시 검토할 조건

다음과 같은 새로운 목적이나 측정 근거가 생기면 정확한 후보만 다시 평가한다.

1. 후보 저장 공간이 실질적으로 증가하거나, 특정 후보가 비용·I/O·지연·운영 부담의 원인이라는 측정 근거가 생긴 경우.
2. 관련 V1/replay/commerce 기능을 제품 또는 운영 정책상 종료하여, 작은 공간 회수와 별개로 유지보수 단순화의 목적이 명확해진 경우.

그때에는 당시의 reader/writer·RPC/FK·runtime flag·잔여 실행 drain을 확인하고, 보존·복원 대체와 측정 가능한 이득을 갖춘 최소 allowlist로 검토한다. 이번 크기 값이나 이전의 0행 관측을 미래 DROP 허가로 재사용하지 않는다. W05 private source 검증 도구의 완료도 이 의존성 검토를 대신하지 않는다.

## 5. 변경과 검사

이 후속 작성자가 추가한 파일은 이 보고서 하나다. 상위 작업 소유의 safe JSON, 기존 보고서, 상태판, 코드 및 SQL은 수정하지 않았다. DB·Apify·AI 호출과 migration apply/repair는 수행하지 않았다.

로컬 검사로 DTO의 정확한 후보 집합 9개·중복 없음·relkind·비음수 정수 byte 값을 확인하고, 각 table/index 합계와 전체 384 KiB 및 0.493% 비중을 재계산했다. 문서의 UUID 형태 원시 값 부재와 공백 오류도 검사했다. 문서만 추가하므로 앱 테스트나 새 DB 검사를 실행하지 않았다.
