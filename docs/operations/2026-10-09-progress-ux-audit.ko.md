# 2026-10-09 진행 화면 UX 감사

이번 감사는 사용자가 요청한 **분석 중 화면**을 Dev에서 직접 확인하고 개선 범위를 정하는 작업이다. 결과 페이지는 기존 버전을 유지한다. 진행 화면의 기능 흐름은 아래 범위에서 확인했으나 전체 UX·접근성 PASS를 선언하지 않는다. [진행 화면 개선 승인안](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/docs/superpowers/specs/2026-10-09-progress-ux-design.ko.md)의 세 시안은 모두 미승인·미구현이며, 문서 PR 병합도 디자인 승인이나 구현 완료를 뜻하지 않는다.

## 기준점과 증거 구분

- Root 종료 기록 기준 main `962d1776`, PR603 병합·동기화 완료. 실제 검수 런타임은 Dev `a299`이며 이후 차이는 문서뿐이다. 이번 작성자는 Git·원격·브라우저·키 조회를 하지 않았다.
- Root는 Aside에서 합성 완료 실행 1회와 의도한 실패 실행 1회를 확인했다. 작성자는 아래 채택 캡처 11개를 직접 보았다. 이미지 관찰과 Root의 조작·측정 결과를 구분한다.
- 실제 화면은 CSS 1440×900, 캡처는 2880×1800픽셀이다. 이번 모바일 크기 재측정은 Aside REPL viewport API 미지원 및 단축키 전환 미확인으로 완료하지 못했다.
- 실제 카드 결제·Apify·Vertex·앱 분석 AI 호출을 수행하지 않은 합성 흐름과 모의 결제 검수다. 생성 시안 제작은 앱 분석 호출과 별개다. 청구 내역이나 브라우저·서버 egress 전수 감사의 증거는 아니다. 반복 인물 사진은 Dev fixture이며 Production 오류로 해석하지 않는다.
- 이번 새 자산만 감사 근거로 채택한다. 02는 checkout 전환 전, 09는 실패 전 75% 화면이므로 제외한다. 이전 결과 UX 감사의 5개 finding을 이 작업으로 해결 처리하지 않는다.

## 실제 화면 기록

번호는 원본 파일 번호다. 비율과 문구는 이미지 관찰이며, URL·키보드·HTTP 상태는 Root의 직접 조작 기록이다.

| 번호·캡처 | 단계 | 관찰상 상태와 확인 범위 |
| --- | --- | --- |
| [01-checkout-ready](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/01-checkout-ready.png) | 모의 결제 대기 | 테스트 결제창·합성 시나리오·모의 성공/취소/실패 버튼이 보인다. 실행 진입 준비 상태이며 실제 결제사 검증은 아니다. |
| [03-progress-first](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/03-progress-first.png) | 완료 fixture 초기 | 원형 2%, 첫 작업 4%, 현재 4/100. 나머지 두 작업은 대기. 진행 화면과 이탈 안내가 표시된다. |
| [04-progress-middle](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/04-progress-middle.png) | 완료 fixture 중간 | 원형 25%, 첫 작업 49%, 두 번째 18%, 현재 49/100. 두 작업이 함께 진행 중이므로 순차 단계라고 단정할 수 없다. |
| [05-progress-late](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/05-progress-late.png) | 완료 fixture 후속 | 파일명과 달리 이미지의 전체 값은 47%다. 첫 작업 90%, 두 번째 54%, 현재 90/100이 함께 보인다. |
| [06-progress-reloaded](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/06-progress-reloaded.png) | 새로고침 뒤 | 원형 91%, 앞 두 작업 완료, 마지막 작업 63%, 현재 63/100. Root가 동일 실행 URL의 reload와 진행 지속을 확인했다. |
| [07-complete-landing](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/07-complete-landing.png) | 완료 자동 이동 | 기존 결과 화면이 표시된다. Root가 자동 결과 이동을 확인했다. 결과 판독 품질·결과 재구성의 근거로 사용하지 않는다. |
| [08-failure-run-progress](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/08-failure-run-progress.png) | 실패 fixture 진행 중 | 원형 27%, 첫 작업 49%, 두 번째 18%, 현재 49/100. 종료 오류 이전의 정상 합성 진행 표시다. |
| [10-analysis-failed](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/10-analysis-failed.png) | 의도한 실행 실패 | “판독에 실패했습니다”와 처리 오류 안내, “다시 시도하기” 버튼이 보인다. 실제 provider 장애가 아니다. |
| [11-failure-return](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/11-failure-return.png) | 실행 실패 뒤 복귀 | 빈 분석 입력 화면과 기본 시나리오가 보인다. Root가 오류 버튼 Enter → /analyze 복귀를 확인했다. 같은 실행 재시도는 아니다. |
| [12-progress-not-found](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/12-progress-not-found.png) | 미존재 요청 조회 | “분석 요청을 찾을 수 없습니다.”와 “다시 시도하기” 버튼이 보인다. Root가 같은 endpoint 추가 읽기의 HTTP404를 확인했다. 실행 실패와 다른 조회 오류다. |
| [13-lookup-return](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/13-lookup-return.png) | 조회 실패 뒤 복귀 | 빈 분석 입력 화면이 보인다. Root가 미존재 요청 버튼 Enter → /analyze 복귀를 확인했다. |

### 대표 실제 화면

04: 전체 진행률과 두 작업의 동시 진행

![실제 진행 중 화면](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/04-progress-middle.png)

10: 합성 실행의 의도한 실패

![실제 분석 실패 화면](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/10-analysis-failed.png)

12: 미존재 요청의 조회 오류

![실제 조회 오류 화면](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-progress-ux-audit/12-progress-not-found.png)

## 확인한 문제와 유지할 점

검정·혈색 빨강·격자·Paperlogy·CASE FILE 브랜드, 원형 진행 표시, 세 작업 상태는 기존 화면의 일관성을 만든다. 이탈해도 판독이 계속된다는 안내와 완료 자동 이동, 같은 URL 새로고침 지속도 유용하다. 개선은 이 구조의 수치 의미·가독성·다음 행동을 정리하는 범위가 적절하다.

| 우선순위 | 확인된 근거 | 개선 판단 및 근거의 한계 |
| --- | --- | --- |
| P2 | 03~06에서 전체 %, 작업별 %, n/100이 병렬로 표시되고 원형 안에는 작업명이 있다. | 전체 값을 명시하고 현재 활동과 작업 상태를 구분한다. 숫자가 틀렸다는 증거가 아니며 실제 사용자 혼동은 측정하지 않았다. |
| P2 | 03~06·08의 시간 문구는 계속 “약 5분”이다. Root 소스 조사상 Dev 합성 실행 설정은 45초다. | Dev 전용 시간 안내를 분리한다. Production 300초 목표 모델은 실측이 아니므로 정확한 종료 시각·카운트다운으로 바꾸지 않는다. |
| P2 | 작은 시간·설명 문구가 어두운 격자 위에 표시된다. Root 측정은 시간 11px/RGB(95,86,79), 설명 12px/RGB(140,130,123), 기본 배경 RGB(12,10,11)이다. | 본문 14~16px와 대비 강화를 제안한다. 격자 오버레이가 있어 최종 대비비·WCAG 실패를 확정하지 않는다. |
| P2 | Root DOM 측정은 role=progressbar 0개, main h1 0개, aria-live 1개다. | 진행 값의 의미와 주제목을 프로그램에서도 제공한다. 스크린리더 사용성·전체 접근성 적합성은 미검증이다. |
| P2 | 10과 12의 “다시 시도하기”는 모두 /analyze로 복귀한다. 실행 실패와 미존재 조회 오류는 서로 다르다. | 실제 동작에 맞는 “새 분석 시작하기”와 유효한 일시 조회 오류의 다시 조회를 분리한다. 같은 run 재실행이나 환불 기능을 추가하지 않는다. |

진행 중 이탈 안내에는 보관함 링크가 없다. 기존 진행·완료 내역 조회가 가능한 범위에서 보관함 CTA를 제안하되, Production mypage에 실패 내역이 노출되지 않으므로 실패 실행을 보관함에서 복구할 수 있다고 약속하지 않는다. 대상 고정 표식은 확인할 DTO 계약이 없어 1차 개선에서 제외한다. 현재 활동의 합성 프로필을 결과 판정이나 고정 분석 대상으로 표현하지 않는다.

## 소스 조사와 시안의 경계

Root의 읽기 전용 조사 근거는 [진행 페이지](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/app/progress/[requestId]/page.tsx), [owner 표현](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/lib/services/analysis/owner-view-presentation.ts:97), [진행 표시](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/lib/services/analysis/v2-progress-display.ts:236), [진행 hook](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/hooks/useAnalysisProgress.ts)이다. Production ETA는 목표 모델이며 실제 지연 측정이 아니다. hook의 기존 유효 refetch 경로를 활용할 수 있으나 HTTP404와 일시 조회 실패의 행동은 구분해야 한다.

[승인안](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/docs/superpowers/specs/2026-10-09-progress-ux-design.ko.md)은 기존 원형을 정리하는 1안을 우선 권고하고, 가로 바 중심 2안과 작은 원형·상태 중심 3안도 비교한다. 세 이미지의 25%는 배치 예시이며 계산 변경 요청이 아니다. 853×1844픽셀 이미지는 390×844 비율의 생성 시안일 뿐 실제 모바일 렌더링 검증이 아니다. 실패·조회 오류의 별도 시각 시안은 생성하지 않았다.

남은 조건은 사용자 시안 선택·공통 요구 승인과 승인 후 구현 검증이다. 실제 모바일·스크린리더·HTTP503/네트워크 오류 주입·Production 분석 시간은 미검증이다. 결과 UI·결과 점수/수집 문구·결제·provider·DB·랜딩 카피 변경은 범위에 없다. 이번 변경은 감사·승인안과 상태판 문서이며 앱 코드를 바꾸거나 앱 검사를 실행하지 않았다.
