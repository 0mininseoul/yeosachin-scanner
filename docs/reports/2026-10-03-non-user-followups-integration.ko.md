# 2026-10-03 사용자 테스트 제외 후속 통합 기록

이번 후속은 main `4638b2251429e87ddd141ea940e414cb3b85496c`에서 시작했다. 사용자가 사용자 테스트를 제외하고 Apify 유료 비용이 발생하지 않는 선에서 진행하도록 지정했다. 이를 따라 Apify API·actor와 AI generation 호출은 **0회**이며 분석·replay·capture·결제·운영 재활성화를 실행하지 않았다.

## 처리 결과

- **W04:** [보존 비용 조사](./2026-10-03-w04-retained-cost-followup.ko.md)와 [안전 DTO](./2026-10-03-w04-retained-cost-followup.safe.json)를 추가했다. 16:34 조회의 보존 attempt 12,207개에서 요청 정책상 v2.12 연결과 최신 비용 provenance 자격 충족은 모두 0개다. 기록된 estimate는 청구서 실액이나 품질 절감 증거가 아니며 두 ledger 금액을 합산하지 않는다. 보존 자료 조사는 완료, 코드 변경은 불필요, 실제 label·동일 cohort 비교·비용 provenance 없이는 승격 근거대기를 유지한다.
- **W06:** [크기 조사](./2026-10-03-w06-size-followup.ko.md)와 [안전 DTO](./2026-10-03-w06-size-followup.safe.json)를 추가했다. 16:31 catalog 조회에서 후보 9개 합계는 384 KiB, public base table 총량 대비 약 0.493%다. 기존 실행·복구 의존성 대체에 비해 공간 이득이 작으므로 현재 추가 축소는 불필요로 종료한다. 현재 행 수나 dependency를 새로 확인한 것은 아니며 DROP 권한이 생긴 것도 아니다.
- **W05:** [비공개 검증 도구 설계](../superpowers/specs/2026-10-03-private-migration-verifier-design.ko.md)를 작성·독립 리뷰했다. 기존 원본을 유지하고 metadata hash와 임시 symlink만으로 local-only 및 zero-pending dry-run을 반복하는 방식이다. 사용자 설계 승인 대기이며 CLI 구현은 없다. 앞선 392/392 격리 검증을 이번 시점에 재실행했다고 주장하지 않는다. 실제 source의 6대6 차이와 빈 DB bootstrap 미검증 범위는 유지한다.
- **W00~W03/W07:** 앞선 처리 결과와 사용자 실행 경계를 유지한다. 새벽 운영·요청 집계는 그 관측 시각의 근거이며, 이번 16시 조회가 웹/GCP 상태나 전체 사용량을 갱신한 것은 아니다. 16:34 budget의 별도 보존 2행은 요청 정책에 연결되지 않아 전역 AI 활동 부재라는 결론을 내릴 수 없다.

## 편집권과 독립 리뷰

상위 세션은 읽기 전용 안전 집계, 상태판, 설계 및 이 통합 기록을 담당한다. `w00_w04_evidence`는 W04 보고서만 작성했고 `w05_w06_provenance`는 W06 보고서만 작성했다. 모든 담당자는 공유 파일을 되돌리지 않았으며 추가 원격·provider 실행 없이 바꾼 파일·로컬 검사·blocker를 보고했다.

구현자와 다른 `supabase_config_probe`가 W05 설계와 W06 보고서를 검토해 PASS했다. W05 설계 리뷰의 file-kind 권한 구분과 공식 CLI 인증 준비 예외를 반영한 뒤 재검토 PASS를 받았다. W04 보고서도 같은 독립 리뷰어의 재계산·경계 검토에서 PASS했다. W04와 W06의 작성자는 해당 리뷰어와 다르다. 상위 세션이 작성한 상태판·통합 기록은 작성자와 다른 `w05_w06_provenance`가 검토했다. 개별 근거의 관측 시각 표현 지적을 수정했으며, 나머지 판정·링크·W00~W08 누락 없음·민감값 부재 검사는 PASS했다.

## 실행한 검사와 한계

새 앱 동작·SQL·package 변경은 없다. 이번 문서·안전 DTO 7개에 JSON 구조·산술·후보 집합·비용 합계·링크·UUID 값/credential 패턴 부재·공백 검사를 실행해 PASS했다. 이전 단계의 167개 앱 검사와 타입체크 PASS는 PR #596/#597의 근거이며 이번에 재실행한 수치로 전사하지 않는다. 새 PR의 기본 CI 타입체크와 Vercel preview 검사는 GitHub에서 확인 후 병합한다.

집계 SELECT는 업무 행 원문 없이 server-side aggregate와 catalog metadata만 반환했다. 검증한 root main의 인증을 메모리와 private child pipe에만 전달했고 temporary workdir는 제거했다. 공식 Supabase CLI의 제한된 인증 준비 외 업무 데이터·스키마·migration 변경, 수동 auth-role SQL, include-all/history repair는 없다. 원본 보존 파일·root 환경 및 연결 설정은 수정하지 않았다.

## 재개 조건과 종료 절차

W03은 사용자 실행 결과가 필요하며 이번 범위에서 제외한다. W04는 실제 품질·동일 cohort 및 비용 provenance 자료가 필요하다. W05는 위 한국어 설계에 대한 사용자 승인이 필요하다. W06은 새로운 측정 이득 또는 기능 종료 목적이 있을 때만 재검토한다. 별도 신규 provider 호출이 필요해지는 경우 이번 무비용 범위의 승인으로 실행하지 않는다.

이번 문서 변경은 `codex/non-user-followups-20261003`의 별도 PR → 관련 검사와 독립 리뷰 → main 병합으로 반영한다. merge 후 root main을 fetch/fast-forward하고 origin/main 및 원격 main SHA 일치, tracked diff, 보호 파일·환경·보존 refs/stash 불변을 확인한다. 실행 결과는 PR와 최종 종료 보고에 남긴다. 직접 main push는 하지 않는다.
