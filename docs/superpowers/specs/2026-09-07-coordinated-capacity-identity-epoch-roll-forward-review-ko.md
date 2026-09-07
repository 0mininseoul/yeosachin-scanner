# 사용자 검토용 요약본

상태: 승인 전 | 영문 원본: [영문 원본 설계](./2026-09-07-coordinated-capacity-identity-epoch-roll-forward-design.md)

## 한눈에 보는 결론

- 검토할 안은 A다. preflight와 paid 두 작업 영역의 실행 신원 8개를 한 세대로 함께 바꾼다.
- B처럼 신원 분리 보호장치를 약하게 만들지 않는다. C처럼 영구히 닫아 두는 것도 목표로 삼지 않는다. 승인하더라도 실제 활성화는 별도 실행 절차와 체크리스트를 모두 통과한 뒤에만 가능하다.
- 다만 사전 조건이나 검증이 하나라도 부족하면 C의 안전한 닫힘 상태로 남는다.
- 현재 production activation은 닫혀 있다. 이 작업에서 real canary(실제 소규모 확인)를 실행하면 안 된다.

## 왜 지금 막혔는가

- 현재 preflight 쪽에 있던 실행 신원이 paid 쪽에서 쓰려는 신원과 겹친다.
- 실행 신원은 작업을 호출하거나 등록하거나 실행하거나 복구하는 데 쓰는 계정이다.
- 기존 preflight 전용 전환은 모든 작업 신원이 서로 달라야 한다는 검사에 묶여 있다.
- preflight만 먼저 바꾸면 잠시라도 역할 간 별칭이 남거나 보호장치를 약하게 해야 한다.
- 그래서 현재 동작은 외부 제공자 작업, 과금 작업, 사용자 작업, 모호한 IAM 수정 전에 즉시 중단한다.
- A는 두 역할을 하나의 epoch(같은 전환 세대)로 묶어 중간의 잘못된 상태를 만들지 않는다.

## A/B/C 선택지 비교

| 선택지 | 내용 | 판단 |
| --- | --- | --- |
| A. 함께 전환 | preflight와 paid의 실행 신원 8개를 하나의 세대로 전환하고, 양쪽을 닫은 채 검증한다. | 승인 검토 대상 |
| B. 보호장치 약화 | 역할 간 신원 중복을 허용하거나 일반 전환에서 중복 검사를 우회한다. | 거절 |
| C. 계속 닫기 | 현재의 fail-closed(문제가 있으면 닫힌 상태로 멈춤)를 유지하고 전환하지 않는다. | 실패·중단 시 안전한 결과 |

A의 장점은 두 역할의 신원 집합을 한 번에 검사하고, 하나의 잠금·기록·활성화 경계로 복구를 정한다는 점이다.
A의 비용은 두 작업 영역을 함께 멈추므로 유지보수 시간이 길고, 양쪽의 큐·스케줄러·배포 증거를 모두 준비해야 한다는 점이다.
B는 토큰이 어느 역할인지 모호해지고 일반 배포까지 예외를 물려받으므로 거절한다.
C는 단기적으로 안전하지만 원하는 preflight+paid 처리 용량을 되살리지 못한다. 설계 선택은 A이며 실패 시 C로 닫힌다.

## 승인하려는 핵심 설계

### 실행 신원 규칙

- 작업 신원은 preflight 4개와 paid 4개, 총 8개 슬롯으로 고정한다.
- 각 역할의 슬롯은 작업 호출자, 작업 등록자, 실행 환경(runtime), 복구 담당이다.
- 8개 신원은 서로 중복되면 안 된다. 같은 신원을 다른 역할이나 다른 슬롯에 두어도 실패다.
- 빌드 신원은 작업 신원 8개와 별도의 슬롯이며, 8개 모두와 달라야 한다.
- 바뀌지 않는 신원은 기존과 새 세대에서 같은 역할·같은 슬롯에 있을 때만 유지할 수 있다.
- 과거에 공유됐거나 이번에 폐기할 신원은 새 세대 어디에도 재배치하지 않는다.
- 모든 신원은 정해진 프로젝트에 속하는지 확인한다. 형식이 이상하거나 다른 프로젝트면 닫힌다.
- 기존 서비스 계정은 전환 중 삭제하지 않는다. 삭제 검토는 별도 작업이다.

### 세 가지 admission을 따로 본다

admission은 “새 작업을 받아들일지”를 정하는 문이다. 세 문은 서로 대신 증명하지 않는다.

| 구분 | 확인하는 것 | 전환 중 규칙 |
| --- | --- | --- |
| 공개 preflight/intake | 공개 분석 요청을 받는 Vercel 문 | `VERIFIED`까지 false |
| 유료 webhook 자동 접수 | 유료 webhook이 paid 작업을 자동으로 넣는 Vercel 문 | `VERIFIED`까지 false |
| Cloud Run 내부 provider admission(외부 제공자 작업 허용 문) | private worker가 외부 제공자 작업을 시작할 수 있는 내부 문 | 공개 readiness에 노출하지 않음 |

Cloud Run 내부 문은 정확한 초기 실행 manifest(전체 실행 설정 묶음)에서만 확인한다.
초기 no-traffic revision에서는 내부 문이 true일 수 있지만, 트래픽·큐·복구 스케줄러가 닫혀 있어 작업은 시작되지 않는다.
공개 readiness가 내부 문을 증명한다고 해석하지 않는다.

### readiness(준비 상태 확인) v3 규칙

- v3는 v2의 키·타입·의미·세 경로(route) 구조를 그대로 보존한다.
- v2에 Vercel boolean 두 개만 추가한다: `analysisV2AdmissionEnabled`, `earlybirdWebhookAutoAdmissionEnabled`.
- `ready` 계산식은 바꾸지 않는다. 두 새 boolean을 `ready` 안에 합치지 않는다.
- `VERIFIED`까지 공개 readiness는 `ready: true`이고 두 Vercel boolean은 모두 false여야 한다.
- 활성화 직전에는 공개 gate를 먼저 원하는 값으로 바꾼 뒤, paid webhook 값은 별도로 검토한 값과 일치하는지 확인한다.
- 두 boolean 중 하나를 다른 하나에서 추론하지 않는다.
- v3에는 신원, 프로젝트, URL, task, provider, 결제, 사용자 정보나 원시 오류를 넣지 않는다.

### 변경 경계

- 모든 변경은 하나의 epoch 잠금과 순서가 있는 private journal(복구용 추가 기록) 아래에서 수행한다.
- 각 변경 직전에 IAM etag(정책 버전 표식)나 Cloud Run metadata 관찰값, 또는 완전한 관찰 digest(값을 노출하지 않는 지문)를 다시 확인한다.
- 변경 직후 실제 상태를 다시 읽고, 그 결과가 맞을 때만 다음 상태를 기록한다.
- 큐와 스케줄러처럼 원래 제공되는 CAS(동시 변경 방지)가 없는 자원에는 가짜 etag나 세대를 만들어 쓰지 않는다.
- 오래된 담당자가 다시 깨어나도 새 잠금 fence가 없으면 수정할 수 없다.

## 8단계 전환 흐름

1. **PREPARED, 사전 준비 완료**
   - 보호된 기존·희망 manifest가 8개 신원과 빌드 신원을 모두 포함하는지 확인한다.
   - 신원 중복, 프로젝트, 소스, producer 지문, 큐·스케줄러, 보존 설정, IAM을 읽기 전용으로 검증한다.
   - readiness는 `ready: true`, 두 Vercel admission은 false여야 한다.
   - 하나의 epoch 잠금을 잡고, 이 단계에서는 배포나 IAM·큐·스케줄러 변경을 하지 않는다.
2. **STAGED, 무트래픽으로 준비**
   - 두 역할의 정확한 새 revision(배포 버전)을 무트래픽으로 만들거나, 입력이 완전히 같은 기존 revision만 재사용한다.
   - 내부 provider admission은 각 초기 revision에서 요구된 true여야 한다.
   - 아직 트래픽, 큐 재개, 스케줄러 재개, 외부 provider 호출은 없다.
3. **PRODUCERS_CLOSED_ALIGNED, 생산자 닫힘·정렬**
   - 공개 preflight/intake와 paid webhook 자동 접수 gate를 모두 false로 유지한다.
   - 두 producer(작업 생산자)의 소스와 역할별 지문이 희망 manifest와 같은지 확인한다.
   - task를 만들거나 signed/manual 경로를 시험하지 않는다.
4. **QUEUES_ALIGNED, 큐 정렬**
   - 두 큐가 모두 PAUSED이고 실제 목록이 비어 있는지 확인한다.
   - 두 복구 스케줄러도 PAUSED이며 충분히 오래 멈춰 최근 시도가 없어야 한다.
   - 보존 기능은 계속 켜 둔다. 비어 있지 않으면 삭제·재생성하지 않고 안전한 drain(남은 작업의 정상 처리) 또는 중단을 기다린다.
5. **INVOKERS_ROTATED, 호출 권한 교체**
   - 새 역할별 OIDC(서비스 간 인증), 등록, 실행 환경, 복구, 대리 실행(actAs) 권한을 fresh etag와 함께 추가한다.
   - 읽어 온 정책이 정확히 맞는지 확인하고, 이전 호출·등록 권한은 아직 임시로 남겨 둔다.
   - 이 단계에서 트래픽이나 어떤 admission도 열지 않는다.
6. **SERVICES_PROMOTED, 서비스 승격**
   - STAGED에서 잡은 정확한 revision만 preflight와 paid에 각각 승격한다.
   - 두 승격이 모두 정확하다고 읽어 온 뒤에만 폐기 대상의 이전 호출·등록 권한을 fresh etag로 제거한다.
   - 기존 서비스 계정은 삭제하지 않고, 최신 별칭이나 추측한 revision도 사용하지 않는다.
7. **VERIFIED, 전체 검증 완료**
   - revision, 소스, runtime 신원, IAM, 지문, 큐·스케줄러, 보존, 빌드 분리를 다시 확인한다.
   - readiness v3가 `ready: true`이고 두 공개 Vercel admission이 false인지 반복 확인한다.
   - 인증 뒤 malformed body(형식이 일부러 잘못된 요청) 확인 요청만 보내고, 검토된 4xx가 provider·task·과금·사용자 작업 전에 나오는지 확인한다.
8. **ACTIVATED, 활성화**
   - 공개 preflight/intake gate를 먼저 원하는 값으로 설정하고 readiness를 확인한다.
   - paid webhook gate는 별도로 검토한 값을 확인한다. 둘을 같은 값이라고 가정하지 않는다.
   - 복구 스케줄러 두 개를 먼저, 그 다음 큐 두 개를 고정 순서로 재개한다: preflight 스케줄러, paid 스케줄러, preflight 큐, paid 큐.
   - 네 자원을 모두 읽어 온 뒤에만 활성화를 기록한다.

## 실패 시 안전장치

- 활성화 전 실패는 두 공개 Vercel gate를 즉시 false로 두고, 두 큐와 두 복구 스케줄러를 PAUSED로 유지한다.
- 활성화 중 일부만 재개됐다면 두 gate를 즉시 닫고 이미 재개한 자원을 pause한다.
- 이미 큐에 들어온 task는 삭제·purge·replay하지 않는다. 비어 있지 않으면 운영자가 안전하게 drain한 뒤 재시도한다.
- IAM이 일부만 바뀌어도 예전 정책으로 자동 복구하지 않는다. 잘못된 복구가 신원 충돌을 되살릴 수 있다.
- 원하는 IAM이 남아 있어도 시스템을 닫은 채 운영자가 확인하고 같은 epoch를 이어가거나 새 검토 epoch를 만든다.
- 잠금이 만료된 담당자는 갱신·변경할 수 없다. 새 담당자는 모든 현재 상태를 다시 읽는다.
- 기록 누락, 순서 오류, 관찰값 변화, 오래된 etag, 트래픽 불일치가 있으면 재검증 후 닫힌 상태로 멈춘다.
- 공개 gate를 연 뒤 실패하면 새로 들어온 task를 보존하고, provider·과금·사용자 작업 기록을 운영자가 검토한다.
- 모호한 provider 실행을 취소하거나 결제 상태를 바꾸거나 다른 역할을 대신 재개하지 않는다.

### 테스트에서 허용·금지하는 것

- 테스트는 가짜 신원·가짜 자원·가짜 provider만 사용하고 보호된 값이 출력·journal에 없는지 확인한다.
- 인증된 malformed body 확인 요청이 검토된 4xx를 내는지까지만 테스트한다.
- Apify, Gemini, Vertex, RapidAPI, 실제 Instagram, B-lite, 실제 payment, `0_min._.00 canary`는 호출하지 않는다.
- 실제 task, 실제 provider, 실제 과금, 실제 사용자 작업, production credential도 사용하지 않는다.
- 현재 production activation은 닫힌 채로 둔다. real canary는 승인 후에도 별도 운영 절차에서 사용자가 판단한다.

## 바뀌는 것/바뀌지 않는 것

### 바뀌는 것

- 두 역할을 함께 처리하는 coordinator, 하나의 epoch 잠금, 추가 전용 전환 기록을 추가한다.
- 두 역할의 완전한 기존·희망 manifest와 8개 신원 중복 검사를 사용한다.
- readiness v3에 두 Vercel admission boolean을 추가하고, 두 공개 문을 독립적으로 읽는다.
- 무트래픽 staging, IAM 추가 후 양쪽 승격, 승격 확인 후 이전 권한 제거 순서를 고정한다.

### 바뀌지 않는 것과 범위 밖

- 일반 역할별 check/apply의 보호장치와 기존 preflight 전용 예외 경로는 바꾸지 않으며, paid가 이를 빌려 쓰지 않는다.
- provider 예산, 결제 상태, retention, 업무 처리 흐름과 업무 로직은 다시 설계하지 않는다.
- Docker cleanup, credential rotation, secret 변경, Supabase 변경, admin dashboard 변경은 범위 밖이다.
- 기존 서비스 계정 삭제도 범위 밖이며 이번 전환에서 하지 않는다.
- 실제 유료 provider 호출, 실제 Instagram canary, production 데이터 변경은 범위 밖이다.

## 승인 체크리스트

- [ ] A가 preflight와 paid 실행 신원 8개를 한 세대로 전환한다는 점을 이해했다.
- [ ] B는 보호장치 약화라서 거절하고, C는 실패·중단 시 안전한 닫힘 상태임을 확인했다.
- [ ] 8개 실행 신원이 서로 다르고, 빌드 신원도 8개와 다르다.
- [ ] 기존 서비스 계정 삭제가 전환 계획에 포함되지 않았다.
- [ ] 공개 preflight/intake, 유료 webhook, Cloud Run 내부 provider admission을 서로 독립적으로 검증한다.
- [ ] v3가 v2를 그대로 보존하고 두 Vercel boolean만 추가하며, `ready`와 admission을 섞지 않는다.
- [ ] `VERIFIED`까지 `ready: true`와 두 공개 gate false 조건을 지킨다.
- [ ] 두 큐·두 복구 스케줄러가 PAUSED이고 비어 있거나 충분히 오래 조용하며, retention이 켜져 있다.
- [ ] staging revision은 무트래픽이고, 정확한 입력과 내부 gate 증거가 있다.
- [ ] IAM 변경은 fresh etag로 하고, 이전 권한 제거는 두 revision 승격 뒤에만 한다.
- [ ] 인증된 malformed body의 검토된 4xx 외 테스트를 하지 않는다.
- [ ] 금지된 provider·canary·payment·실제 task·production credential을 사용하지 않는다.
- [ ] 일부 실패 때 gate 닫기, 재개 자원 pause, task 보존, unsafe IAM rollback 금지를 확인했다.
- [ ] production activation은 닫혀 있고 real canary를 지금 실행하지 않는다.

## 승인 후 순서

1. 구현 PR과 CI에서 가짜 자원·가짜 provider 기반 테스트를 먼저 통과시킨다.
2. readiness v3를 배포하되 두 공개 Vercel gate는 false로 둔다.
3. 보호된 기존·희망 manifest, 소스·revision, 큐·스케줄러, IAM, 지문 증거를 준비한다.
4. coordinator로 PREPARED부터 VERIFIED까지 순서대로 진행하고, 각 변경 전후 상태를 확인한다.
5. VERIFIED 증거와 zero-work 결과를 사용자가 다시 검토한다.
6. 공개 preflight gate를 먼저 확인하고 paid webhook gate를 별도로 확인한 뒤 ACTIVATED 단계로 이동한다.
7. preflight 스케줄러, paid 스케줄러, preflight 큐, paid 큐 순서로 재개하고 전체 결과를 읽어 온다.
8. real canary는 이 요약본의 승인만으로 실행하지 말고, 별도 운영 절차와 사용자 판단을 따른다.
