# 분석 진행 화면 1안 구현·검증

사용자가 선택한 큰 원형 진행률 1안과 공통 개선을 구현했다. 이어 명시한 **기존 수집 이미지 슬라이딩**을 유지했다. 관련 검사·독립 명세/품질 리뷰와 새 Dev 배포 검수를 통과했다. [PR #605](https://github.com/0mininseoul/yeosachin-scanner/pull/605)에서 exact-head 검사 후 main으로 승격한다. 병합 SHA·최종 main 동기화·Production native 배포의 최종 상태는 해당 PR과 Root 종료 검증으로 확인한다.

## 변경과 보존

- 전체 진행률에 이름·값·범위를 제공하고 현재 활동을 h1으로 표시했다. 작업 세 개는 병렬 진행을 그대로 표현하며 완료/진행 중/대기로 구분한다.
- 단위가 불명확한 track n/100과 작업별 중복 %를 숨겼다. 계약에 currentOrdinal과 totalCount가 모두 있을 때만 ‘현재 n번째 / 대상 N개’를 표시한다.
- Dev는 ‘테스트 분석은 약45초’, Production은 계정 규모·수집 상황에 따른 시간 변동을 안내한다. 새 ETA·카운트다운이나 진행률 계산 변경은 없다.
- 주요 설명은14~16px, 큰 원형은184px로 정리했다. 기존 ProgressFaces의84px 타일·안전한 이미지 처리·슬라이딩은 파일 무수정으로 유지했다.
- backgroundProcessing인 경우 기존 이탈 안내와 /mypage 보관함 CTA를 제공한다. 페이지를 닫으면 안 되는 legacy 조건은 유지한다.
- 분석 실패·확정404는 ‘새 분석 시작하기’로 /analyze에 복귀한다. 일시 조회 장애는 안전한 안내와 동일 요청 GET ‘다시 조회’를 제공한다. 이전 snapshot 유지, 중복 재조회 방지, 낮은 revision의 연결 복구, 요청 전환 race, 권한 철회 시 데이터 삭제를 검증했다.
- 결과 페이지·결과 점수/문구·랜딩 카피·실행 로직·provider·결제·DB는 바꾸지 않았다. 새 Production 분석/결제·Apify·Vertex 호출은 실행하지 않았다.

## 검사·독립 검토

구현자는 `progress_ux_implementation`, 별도 명세·품질 reviewer는 `dev_schema_bootstrap`, 모바일 검증자는 `progress_mobile_validation`이다. Root가 Git/배포·실제 Aside·시각 비교를 통합했다. 새 reviewer 생성이 thread cap으로 차단돼 비구현자 한 명이 명세 PASS 후 별도 품질 단계를 수행했다. 두 단계 모두 새P1/P2·수정 요청0건이다.

Root는 최종 코드 `309e181313f3408e964c78de49af918c81441247`에서 관련9개 파일140검사, 타입체크, 변경5파일ESLint, diff 검사를 재실행해 통과했다. 검사 묶음은 owner 표현·진행 표시·요청 계약·프로필 순수/컴포넌트·Dev client-flow·진행 hook/page·duration·v1/v2 실행 격리다. 전체 테스트·DB reset·migration push는 실행하지 않았다. 시각 QA에서 발견한390px CTA 절단은 여백24px 조정 후 해결했다.

## Dev 배포 근거

배포 `dpl_EGt3uwR6Mu4nETm2ky8MQkkLNDUg`는 위 후보 SHA, 정확한 Dev project/owner, READY, dev.yeosachin.com alias를 native CLI로 확인했다. clean tracked archive를 임시0700 디렉터리에 만들고 그곳에서만 승인된 Dev vercel.json overlay를 적용했다. source checkout·Production link는 유지했고 임시 업로드는 정리했다. 배포 뒤 cron 비활성·정의0개·Git 자동 배포 없음도 재확인했다.

후속 문서 변경은 앱을 재배포하지 않는다. [안전한 영수증](2026-10-09-progress-implementation.safe.json)에 후보 tree·source/effective fingerprint·알고리즘을 기록했다. 이번 fingerprint는 문서/검사/CI/Markdown을 제외한 tracked1373파일 기준으로, 이전 a299의761파일 알고리즘과 직접 비교하지 않는다. 최종 PR과 배포 후보의 소스 동등성은 같은 새 알고리즘으로 확인한다.

## 실제 Aside Dev 검수

CSS1440×900·DPR2·PNG2880×1800에서 새 완료 합성 실행1개와 실패 합성 실행1개를 만들었다. 실제 카드·provider·AI 실행이 없는 모의 결제/합성 흐름이다. 계정 식별자·쿠키·토큰·실행 UUID는 기록하지 않았다.

| 증거 | 확인 내용 |
| --- | --- |
| [01 초기](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/01-dev-progress-first.png), [02 병렬](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/02-dev-progress-parallel.png) | 초기에서54%까지 변화. h1/progressbar 각각1개, 가로 넘침 없음, 두 작업 동시 진행,45초 안내. |
| [03 새로고침 중 조회 오류](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/03-dev-progress-reloaded.png) | 같은 실행 URL reload 후 일시 조회 오류/조회 중 표시가 한 번 관측됐다. 자동 조회로 마지막 작업 상태까지 복구됐다. 오류 당시 HTTP·원인은 캡처하지 못했으므로503이나 서버 장애로 단정하지 않는다. 후속 progress GET은200·동일 요청·completed10000bp였다. |
| [04 완료](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/04-dev-completed-result.png) | 기존 /result 경로로 자동 이동, 결과 UI 보존. |
| [05 보관함](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/05-dev-archive.png), [06 복귀](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/06-dev-progress-after-archive.png) | 진행 중 보관함 링크 Enter→/mypage, 해당 합성 실행 링크→같은 progress URL. 복귀 후57%와 기존 진행 상태 확인. Dev 실패 기록 노출을 Production 실패 복구 약속으로 확대하지 않는다. |
| [07 실패](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/07-dev-terminal-failure.png), [08 복귀](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/08-dev-failure-return.png) | 의도한 합성 실행 실패, 새 분석 시작하기 Enter→빈 /analyze. 같은 실행 재시작이 아니다. |
| [09 미존재](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/09-dev-not-found.png), [10 복귀](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/10-dev-not-found-return.png) | 메모리에서 만든 미존재 경로, 실제 progress GET404, 새 분석 시작하기 Enter→/analyze. 주문·실행을 생성하지 않는 조회다. |

## 모바일과 남은 경계

Aside의 viewport 변경 미지원으로 사용자가 격리 Playwright 검수를 승인했다. 실제 진행 페이지/hook/슬라이딩/CSS/로컬 글꼴과 합성 응답을 사용했고 로그인 쿠키를 이동하지 않았다. [시각 QA](../../design-qa.md)와 [모바일 검증 상세](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-implementation/mobile-validation.ko.md)를 확인한다.

390×844에서 CTA 전체 표시,320px에서 가로 넘침 없는 세로 스크롤·키보드 CTA, 슬라이딩과 모션 감소, 병렬/순번/완료·실패/404·초기/간헐503·네트워크 오류의 GET 복구를 검증했다. 의미 없는 h1 반복 변경은 없었다. 의도한 주입 오류10건 외 콘솔 오류0건이다. 실제 Dev의 예기치 않은 조회 오류 관측과 격리503 주입을 서로 다른 증거로 구분한다.

실제 모바일 Dev 인증/서버 E2E·실물 기기·iOS Safari·스크린리더 낭독·실제 장기 대기시간·provider/AI 품질·결제사 과금은 미검증이다. 해당 확인이 필요할 때 실제 기기/사용자 실행 또는 별도 승인된 측정으로 재개한다. W03 실제 계정 분석은 사용자 실행 경계, W04 품질·비용은 기존 증거대기를 유지한다. W00~W08의 이미 완료·불필요 판정을 되살리지 않는다.
