# Dev 실제 사용자 화면 UX 감사

상태: **감사 보고서 초안 · 시안 선택과 공통 개선 승인 대기 · 최종 Dev 수용 검증 진행 중**. 2026-10-09, Asia/Seoul. 전체 UX PASS를 선언하지 않는다.

## 목표와 범위

원래 목표는 실제 사용자가 화면을 보고 결과를 이해하고 다음 행동을 찾을 수 있는지, 흐름과 UI/UX가 충분히 깔끔한지 확인하는 것이다. 별도 Dev에서 합성 프로필과 모의 결제로 로그인부터 결과·보관함까지 재현했다. 코드 검사만으로 화면 감사를 대체하지 않는다.

검정·혈색 빨강·CASE FILE 계열 서류형 표식·Paperlogy의 기존 브랜드를 유지한다. `app/page.tsx`의 확정 마케팅 카피는 변경 대상이 아니다. 결과 화면 재구성은 생성 시안 선택과 공통 개선 범위 승인 후 구현한다. 이 보고서는 UI 변경이나 새 승인 자체를 수행하지 않는다.

기준 문서는 [실제 분석 화면 UX 개선 검토 한국어 명세](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/docs/superpowers/specs/2026-10-09-analysis-result-ux-review.ko.md)다. 한국어 원본이며 별도 영어 승인 문서는 없다.

## 근거의 종류와 후보 경계

| 근거 구분 | 확인 범위 | 해석 경계 |
| --- | --- | --- |
| 화면 근거 | 최초 감사자가 19개 PNG를 직접 열어 시각 확인했고, Root가 추가 30·31 PNG를 직접 확인했다. | 보이는 문구·배치·잘림·행동의 발견 가능성에 대한 근거다. 이미지에 없는 영역이나 버튼 실행 결과를 추정하지 않는다. |
| Root 조작·측정 근거 | 실제 Aside에서 모의 흐름을 조작했고, 모바일 Chromium 반응형 보기에서 `innerWidth=390`, `innerHeight=844`, 가로 overflow 없음으로 확인했다. | 감사자가 별도로 브라우저를 조작한 결과가 아니다. PNG 픽셀 크기로 CSS viewport를 추정한 것도 아니다. 실물 기기 검증은 아니다. |
| 명세·소스 근거 | 위 한국어 명세의 현재 수집 범위 필드·점수 의미·후보 소스 설명과 독립 코드 검토를 참조한다. | 점수 계산이나 fixture 상태를 화면만으로 입증했다고 표현하지 않는다. 최초 보고서 작성은 코드·DB·provider 조회 없이 수행했고, 후속 페이지 이동 조사는 다른 agent가 관련 소스와 기존 검사를 확인했다. |

최초 e21 Dev 캡처에는 기존 immersive 성별 확인·미리보기를 생략했던 화면이 포함된다. 후속 a299eb34 후보는 기존 Production immersive UI와 callback을 Dev에서도 재사용한다. 19·20·21은 입력·성별 확인·미리보기의 추가 화면 근거다. 명세에 따르면 e21과 a299의 결과 화면 소스는 동일하다. 추가로 Root는 a299 alias READY 뒤 저장한 partial 결과 경로를 fresh page.goto로 다시 열어 같은 route의 공개 여성 12·비공개 8과 가로 overflow 없음을 확인했다. 따라서 이 부분 결과 읽기 범위에서 이전 후보와 새 후보의 혼합 SPA 한계는 해소됐지만, 과거 PNG를 a299 전체 흐름의 새 수용 검증으로 간주하지 않는다.

Root는 a299 Dev READY 이후 390×844에서 성별 확인 → 미리보기 → 플랜 → 모의 결제 성공 → 의도한 failed 분석 fixture 화면을 확인했다. 이어 empty fixture에서 아니오 선택 → 상세 분석 보기 → 플랜 → 모의 결제 성공 → 진행 → 완료·빈 결과를 확인했다. 진행·결과 새로고침과 비공개 탭의 빈 안내도 Root가 확인했다. 24·26·27·28과 아래 조작 기록으로 남기며, 이 사례들을 전체 D5 수용 검증 완료로 확대하지 않는다.

캡처 번호는 원본 파일명과 같이 고정한다. **16·17·22는 최종 근거에서 제외한다.** 특히 22는 화면 전환 중 캡처이므로 모바일 플랜의 완성 화면 증거로 채택하지 않는다.

## 캡처별 직접 확인

| 번호·근거 | 실제 화면에서 확인한 내용 | 평가와 한계 |
| --- | --- | --- |
| [01 로그인](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/01-login.png) | 검정 격자 배경, 브랜드 표식, 중앙 제목과 노란 Kakao 로그인 CTA가 보인다. | 로그인 행동은 찾기 쉽다. 작은 정책 링크의 밝기는 상대적으로 낮다. 로그인 성공 자체와 정량 대비는 이 이미지로 판정하지 않는다. |
| [02 대상 입력](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/02-analyze.png) | Dev 합성 안내, Instagram 대상 입력, 시나리오 선택, 공개 계정 안내가 순서대로 보인다. 빈 입력의 CTA는 비활성 상태다. | 입력 순서가 명확하다. 기존 첫 캡처이므로 새 immersive 화면의 근거와 구분한다. |
| [03 권한 거절](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/03-permission-denied.png) | 등록된 테스트 계정만 보관함을 이용할 수 있다는 안내 뒤에 빈 영역이 이어진다. | allowlist 등록 전의 정상 거절이다. 화면 안에서 안전한 홈·로그인 복귀 행동을 찾기 어렵다. 권한을 넓히는 개선을 뜻하지 않는다. |
| [06 플랜](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/06-plans.png) | 대상 요약과 Basic 플랜·가격·선택 표시가 보이며 다음 플랜 일부가 아래로 이어진다. | 비교 구조는 보인다. 첫 화면에 구매 CTA가 없다는 사실만으로 구매 동작이 깨졌다고 판단하지 않는다. 모바일 최종 플랜 캡처를 대체하지 않는다. |
| [08 모의 결제](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/08-checkout.png) | 실제 카드 과금이 없는 테스트 결제 안내, 대상·플랜, 성공·취소·실패 조작 버튼과 복귀 링크가 보인다. 상태에는 “결제 대기 · 완료”가 이어진다. | 테스트 도구의 역할은 명확하다. 결제 상태와 선택 시나리오의 이름을 구분하기 어렵다. Production 결제창의 UX 검증은 아니다. |
| [10 모의 결제 실패](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/10-payment-failure.png) | “모의 결제 실패 · 완료”, 분석 실행이 생성되지 않았다는 안내, 새 사전 점검·보관함 링크가 보인다. | 의도한 payment 실패 화면이다. 분석 실패와 구분해야 한다. “완료”가 실행 완료로 읽힐 위험이 있다. |
| [11 진행](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/11-progress.png) | 전체 원형 진행과 단계별 진행률, “약 5분”, 화면을 나가도 계속된다는 안내가 보인다. | 이탈 후 계속된다는 안내는 유용하다. 전체·단계 진행률과 예상 시간의 의미를 더 쉽게 구분할 여지가 있다. 실제 소요 시간이나 백그라운드 완료를 이 이미지로 입증하지 않는다. |
| [12 완료 결과](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/12-result-complete.png) | 고위험 수, 공개·비공개 탭, 성별 분포, 첫 인물 설명, `85%`와 막대, 프로필 행동이 보인다. | 점수 옆에 지표명이 없다. 첫 인물 설명이 길어 목록을 빠르게 훑기 어렵다. 실제 발생 확률로 해석할 수 있다는 위험을 기록한다. |
| [13 결과 상세](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/13-result-detail.png) | 합성 인물의 사진·이름·핸들·닫기 행동과 설명 문단을 가진 모달이 보인다. | 상세 진입 화면은 확인했다. 합성 fixture 설명의 제한을 Production 근거 정보 부족으로 일반화하지 않는다. 모달 focus 복구는 이미지로 확인할 수 없다. |
| [14 보관함](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/14-archive-filled.png) | 성공·실패·취소 주문, 합성 실행 상태, 주문·실행 확인 링크가 보인다. 결제 상태 뒤에 “완료”가 이어지고 `completed`가 노출된다. | 재방문 진입 행동은 찾을 수 있다. 결제·분석 실행·선택 시나리오의 상태 이름이 섞인다. backend 상태가 잘못됐다는 증거는 아니다. |
| [15 관리자](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/15-admin-detail.png) | 밝은 Dev 읽기 전용 콘솔의 주문 카드와 상세 링크가 보인다. 대상명은 흰 배경에서 매우 옅게 보인다. | 대상 식별의 화면 대비 위험을 확인했다. 이 캡처는 상세 링크가 있는 목록이며, 별도로 열린 상세 패널을 증명하지 않는다. Production 운영 raw UI 검증도 아니다. |
| [18 부분 결과 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/18-result-partial-mobile.png) | 대상·고위험 수·분포·탭·첫 인물이 모바일 폭 안에 보인다. 요약은 “모든 공개 계정들을 판독했습니다”라고 표시된다. 보이는 영역에 부분 결과·수집 제한 안내가 없다. | Root와 명세가 확인한 partial fixture에 필요한 범위 안내가 없다. 점수와 다음 행동은 아래 캡처 밖이므로 18만으로 점수 지표명·CTA 누락을 확정하지 않는다. 점수 지표명 finding의 직접 근거는 12다. |
| [19 입력 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/19-analyze-mobile.png) | 합성 프로필 안내, 입력값, 실패 시나리오 선택, 다음 CTA가 화면 안에 표시된다. | 이 캡처에서 입력·선택·CTA의 가로 잘림을 발견하지 못했다. 실제 키보드 표시나 긴 입력값은 미검증이다. |
| [20 성별 확인 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/20-gender-confirm-mobile.png) | 남성 여부를 묻는 확인 화면과 예·아니오 버튼이 보인다. 이유에는 합성 프로필·게시물 설명과 “실제 계정의 성별을 판정한 결과가 아닙니다”가 표시된다. | 합성 안내와 실제 판정이 아니라는 안내는 확인했다. 고정 합성값이라는 명시는 없고 공통 본문의 “1차 추론·고신뢰 판독” 표현이 남아 있다. 별도 후속 제안으로만 기록한다. |
| [21 미리보기 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/21-precheckout-preview-mobile.png) | 합성 단서로 구성한 미리보기 안내, 관계 신호 목록, 분석 후보 예상 범위가 보인다. | 기존 미리보기 UI 재사용의 실제 화면 근거다. 다음 CTA는 이미지 아래에 있어 이 캡처로 노출·동작을 판단하지 않는다. Root의 후속 플랜 이동 조작 근거와 구분한다. |
| [24 분석 실패 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/24-analysis-failed-mobile.png) | “판독에 실패했습니다”, “판독 처리 중 오류가 발생했습니다”, “다시 시도하기” 버튼이 보인다. 내부 오류·식별자·stack은 보이지 않는다. | 모의 결제 성공 뒤 의도한 failed 분석 fixture의 오류 화면이다. 버튼의 입력 화면 복귀는 아래 Root 조작 기록으로 확인했으며, payment 실패와 구분한다. |
| [26 아니오 선택 후 미리보기 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/26-precheckout-no-mobile.png) | 대상 확인 화면에 “4단계 관계 판독 완료”, 전체 판독에서 상세 결과를 확인할 수 있다는 설명과 “상세 분석 보기” CTA가 보인다. | Root가 empty fixture의 성별 확인에서 아니오를 선택한 뒤 확인한 화면이다. 이미지의 완료 문구를 실제 provider·AI 실행 완료로 해석하지 않는다. 플랜 이동은 Root 조작 근거다. |
| [27 진행 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/27-analysis-progress-mobile.png) | 원형 진행률 `51%`, 단계별 `90%`·`54%`·대기, “약 5분”과 이탈 후 계속된다는 안내가 보인다. | 합성 진행 화면의 직접 근거다. 새로고침 후 `73%`로 이어졌다는 사실은 이 이미지의 수치가 아니라 Root의 별도 관측이다. 실제 AI 작업·소요 시간 실측으로 해석하지 않는다. |
| [28 빈 결과 모바일](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/28-result-empty-mobile.png) | 고위험 `0`, 공개·비공개 탭 각각 `0`, 성별 분포 각각 `0`과 “판독된 여성 계정이 없습니다”가 보인다. | 공개 빈 결과 안내가 보이는 완료 화면이다. 비공개 탭의 문구·completed 여부·응답 상태·새로고침 URL 유지는 Root의 별도 확인이며 이미지 자체에서 추정하지 않는다. |
| [30 실패한 실행 재접속 데스크톱](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/30-failed-run-revisit-desktop.png) | 실패 결과 경로에 다시 접속한 뒤 실패 진행 화면과 “다시 시도하기”가 표시된다. | Root가 직접 확인했다. GET의 HTTP 404·DEV_UI_RUN_FAILED와 이후 입력 화면 복귀는 별도 조작 기록이며 이미지 하나에서 추론하지 않는다. |
| [31 보관함 경유 완료 결과 데스크톱](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/31-complete-revisit-desktop.png) | 완료 결과의 대상 제목·고위험 1·맞팔 84·공개 여성 60·비공개 20과 목록이 표시된다. | Root가 공개 페이지 2→1로 이동한 뒤 상단으로 스크롤해 직접 확인했다. complete fixture의 분포이며 partial fixture의 24·12·8과 혼동하지 않는다. |

## 완료된 모의 흐름과 진행 중 검증

| 흐름 | 현재 확인 | 근거와 경계 |
| --- | --- | --- |
| 로그인·대상 입력·플랜 | 실제 Dev 화면을 관측했다. | 01·02·06 및 Root 조작 보고. 실제 Instagram 수집이 성공했다는 뜻은 아니다. |
| 모의 결제 취소·실패·성공 | Root가 각각의 모의 조작을 관측했다. 결제 실패 화면에는 분석 실행이 생성되지 않았다고 표시된다. | 08·10 및 기준 명세의 실제 조작 기록. 실제 카드·결제사 호출 검증은 아니다. |
| 진행·완료·부분 결과·상세 | 합성 결과를 실제 화면에서 확인했다. | 11·12·13·18. 부분 수집과 점수 의미의 표시 문제는 해결되지 않았다. |
| 보관함·Dev 관리자 읽기 | 주문·실행 진입 화면을 관측했고, a299에서 보관함의 완료 실행 링크로 결과 재접속을 확인했다. | 14·15·31. allowlist 등록 전 거절 화면은 03이며 정상 권한 경계다. 완료 사례의 실제 재방문을 모든 상태·경로의 검증으로 확대하지 않는다. |
| a299 성별 확인·미리보기·플랜 | Dev READY 뒤 390×844에서 Root가 순서대로 이동했다. | 19·20·21의 직접 시각 확인과 Root 후속 조작 보고. 22는 전환 중 이미지라 미채택했다. |
| a299 모의 결제 성공 → 의도한 분석 실패 → 입력 화면 복귀 | Root가 failed fixture를 확인하고 “다시 시도하기”를 키보드 Enter로 실행한 뒤 fresh snapshot에서 `/analyze` 입력 화면 복귀를 확인했다. | 24의 오류 화면은 감사자도 직접 확인했다. 결제는 모의 성공했고 분석은 의도한 실패다. provider 장애나 결제 실패로 기록하지 않는다. |
| a299 empty fixture 완료 | Root가 아니오 선택 → 상세 분석 보기 → 플랜 → 모의 결제 성공 → 진행 → 완료·빈 결과를 확인했다. | 26·27·28은 감사자도 직접 확인했다. Root의 브라우저 내부 same-origin GET에서 progress·result 모두 HTTP 200, completed=true, public·screened 각각 0이었다. 해당 안전 상태·집계만 기록하며 실행 식별자나 응답 원문은 기록하지 않는다. |
| a299 empty 진행·결과 새로고침 | Root가 진행 refresh 후 같은 실행 URL에서 73%로 이어지고, 결과 refresh 후 같은 결과 URL을 유지하는 것을 확인했다. | URL 원문은 저장하지 않는다. 27 PNG는 refresh 전 51%이며, 73%와 동일 URL 여부는 Root 조작·측정 근거다. 이 사례는 새로고침 복구의 확인된 범위다. |
| a299 empty 비공개 탭 | Root가 비공개 탭에서 “비공개 계정이 없습니다”를 확인했다. | 28은 공개 탭 캡처다. 비공개 빈 안내는 Root의 실제 조작 보고이며 감사자가 이미지에서 직접 확인한 항목으로 표현하지 않는다. |
| a299 partial fresh 재접속 | Root가 alias READY 뒤 저장한 partial 결과 경로에 fresh page.goto로 접속해 같은 결과 route, 공개 여성 12·비공개 8, 가로 overflow 없음을 확인했다. | 앞선 SPA 화면만으로 새 후보를 검증했을 가능성을 이 결과 읽기 범위에서 해소했다. URL 원문과 식별자를 기록하지 않으며 보관함 경유 전체 흐름과 구분한다. |
| a299 partial 비공개 프로필 dialog·focus 복구 | Root가 비공개 탭의 8명 렌더링을 확인하고 첫 프로필 행동을 내부 dialog로 열었다. “닫기”를 Enter로 실행한 뒤 같은 트리거로 focus가 복구됐다. | Root의 fresh snapshot focused 표시, activeElement=BUTTON·동일 문구, dialogAbsent=true로 확인했다. 실제 외부 프로필 조회나 전체 modal·스크린리더 검증으로 확대하지 않는다. |
| a299 관리자 Kakao 재로그인·목록·상세 | Root가 로그아웃 후 관리자 deep link의 Kakao 로그인으로 Dev 콘솔에 돌아왔다. user/me와 관리자 목록은 HTTP 200이고, 합성 주문 6건은 성공 4·취소 1·결제 실패 1이었다. | 별도 Dev principal과 allowlist를 사용했다. 취소·결제 실패 주문의 run과 runStatus는 null이었다. 빈 결과 완료 주문의 상세를 실제 열어 확인했으며 원문·주문 식별자는 기록하지 않는다. |
| a299 실패 결과 재접속·복귀 | 소스에서 확인한 소유자 결과 GET은 HTTP 404·DEV_UI_RUN_FAILED였다. Root가 실제 결과 경로로 이동했을 때 실패 진행 화면으로 복구됐고 다시 시도하기 Enter로 입력 화면에 돌아왔다. | 30은 Root가 직접 확인했다. 실제 503·네트워크 단절 주입은 Aside REPL에 request interception이 없어 수행하지 않았다. |
| a299 완료 결과 공개 페이지 1→2→1 | 보관함 링크로 완료 결과를 열어 50행에서 51–60위의 10행으로 이동한 뒤 50행으로 복귀했다. 2페이지의 다음 버튼은 비활성이고 이전 버튼은 작동했다. | 동일 결과 route·가로 overflow 없음·DOM의 대상 및 요약 보존을 확인했다. 상단으로 다시 스크롤한 31에서 제목과 고위험·분포를 직접 확인했다. 모든 비공개·상태별 페이지 경로를 검사했다는 뜻은 아니다. |

Root의 fresh partial client resource timing은 total 35·same-origin 35·Dev API 1이었다. Apify·AI·Instagram·RapidAPI·실제 결제·telemetry·Production host·B-lite·execution으로 분류된 브라우저 리소스는 모두 0이었다. 이는 **해당 브라우저 관측에서 해당 분류의 요청이 보이지 않았다는 근거**다. 서버 내부 egress 전체나 실제 provider·AI 품질을 입증하는 자료가 아니며 리소스 URL 원문은 기록하지 않는다.

## 확인된 P2 사항

여기서 P2는 결과 이해와 다음 행동을 방해하는 UI 문제를 뜻한다. 운영 장애·데이터 손상·WCAG 부적합 판정이 아니다. 공통 최소 개선은 기준 명세에 제안되어 있으며 **사용자 승인 대기**다.

| 고정 finding 번호 | 실제 문제·근거 | 명세의 제안과 검증 조건 |
| --- | --- | --- |
| P2-01 부분 결과 범위 안내 | 18은 partial fixture인데 첫 화면에 수집 제한이 없고 모든 공개 계정을 판독했다고 표시한다. | 기존 DTO의 declared·collected·coverageRatio·meetsCoverageGate·exactCountMatch를 runtime 검증 후 표시한다. 부분 수집·수량 불일치·gate 미달을 구분하고 “수집한 공개 계정 기준입니다”와 범위를 안내한다. 원시 수집 행을 추가하지 않는다. |
| P2-02 점수 지표명 | 12의 `85%`와 막대 옆에 지표명이 없어 값의 의미를 알기 어렵다. | 명세·소스 설명상 1–10 분석 점수의 0–100 환산이며 실제 발생 확률·정확도가 아니다. “위험 지표”와 환산값 설명을 제공하되 계산·순위·등급을 바꾸지 않는다. 18의 캡처 밖 점수를 별도 관측했다고 주장하지 않는다. |
| P2-03 Dev 관리자 대상 대비 | 15의 흰 카드에서 대상명이 매우 옅어 주문 대상을 읽기 어렵다. Root가 실제 목록 대상 글자의 computed style을 측정한 결과 글자 rgb(243,239,234)·배경 rgb(255,255,255)·14px·대비 약 1.14:1이었다. | 기존 밝은 콘솔의 Dev 영역에 어두운 글자 토큰을 한정 적용하는 제안이다. 해당 글자 조합의 측정이며 WCAG 전체 부적합 판정은 아니다. 구현 후 목록과 상세의 실제 대비를 다시 측정한다. |
| P2-04 Dev 상태 이름 혼합 | 08·10·14에서 결제 상태 뒤에 시나리오 “완료”가 이어지고 실행 상태 `completed`가 표시된다. | 모의 결제 상태·합성 실행 상태·선택 시나리오를 이름으로 구분하고 실행 상태를 한국어로 표시한다. 결제·분석 backend 상태를 바꾸는 제안이 아니다. |
| P2-05 권한 거절 복귀 | 03에서 안내 이후 안전한 다음 행동을 찾기 어렵다. | 홈·로그인 복귀 행동을 제공한다. 정상 allowlist 거절을 보존하며 권한이나 식별자 노출을 늘리지 않는다. |

명세에 기록된 partial fixture의 수집량은 317/320와 297/300이다. 이는 명세·소스 근거이며 18 이미지 자체에 표시된 숫자가 아니다. 99% 수집 기준 통과와 정확한 수량 일치는 다르고, 이를 성별 신뢰도·정확도·전체 공개 계정 판독률로 바꾸어 설명하지 않는다.

페이지 이동 후 한 snapshot에 대상·요약이 빠진 현상은 수정 finding으로 채택하지 않았다. Root의 실제 DOM에는 대상과 고위험 요약이 남아 있었고, 자동 목록 스크롤 후 scrollY는 456.5였다. 별도 agent가 직접 caller와 페이지 merge를 읽고 기존 관련 5파일·47검사와 파일을 저장하지 않은 메모리 재현 1검사를 통과했다. 제목·대상 링크·요약 DOM 노드가 유지됐으며 31의 상단 캡처도 이를 확인했다. 변경 파일 0개이며 코드 측 blocker는 없다.

후속 조작·집계와 후보 지문은 [안전한 브라우저 검증 receipt](/Users/youngminpark/.codex/worktrees/continuation-20261003/yeosachin_scanner/docs/operations/2026-10-09-dev-ui-browser.safe.json)에 기록했다. 사용자 UUID·쿠키·토큰·응답 원문·리소스 URL 원문은 포함하지 않는다.

## 유지할 부분과 별도 후속 제안

브랜드 표식, 검정 격자 배경과 빨간 주요 행동, 로그인 CTA, 대상 입력 순서, 공개·비공개 탭은 현재 방향을 유지할 가치가 있다. Dev 상단 테스트 배너와 여러 화면의 합성·모의 결제 안내는 실제 서비스 동작과 테스트를 구분하는 데 도움이 된다. 진행 화면의 이탈 후 계속된다는 안내, 보관함의 주문·실행 링크, 분석 실패의 복귀 버튼, 공개·비공개 빈 결과 안내도 유지한다. a299 empty 진행·결과 새로고침 복구는 Root가 실제로 확인한 동작이다.

20에는 실제 성별 판정이 아니라는 설명이 보이지만, Dev에서 고정된 합성값을 쓰는 사실을 더 직접 안내하는 개선은 **기준 승인 문서의 공통 최소 개선에 자동 포함되지 않은 후속 제안**이다. 공통 본문의 추론 표현과 Dev 안내 정합성을 사용자에게 별도로 제안할 수 있으며, 이 보고서가 해당 문구 변경을 승인하지 않는다.

11의 전체·단계 진행률과 예상 시간 의미, 06의 플랜 첫 화면 밀도도 추가 관측 후보다. 플랜의 큰 구조 변경은 현재 결과 시안 선택 범위에 포함하지 않는다. 이미지 밖 행동이 실패한다고 추정하거나 임의로 재설계하지 않는다.

## 시안 1·2·3과 승인 대기

세 시안은 이미 독립 imagegen 호출로 생성되어 실제 대화에 각각 표시됐다. 번호는 표시 순서와 일치하며 바꾸지 않는다. 아래 구성 설명은 기준 명세의 제안이다. 생성 시안은 작동하는 UI나 구현 후 검증 근거가 아니다.

| 선택 번호 | 이미지 | 제안 구성 |
| --- | --- | --- |
| 1 | [시안 1](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/mock-dossier-scan.png) | 요약과 수집 범위를 앞에 두고 여러 인물을 짧은 행으로 훑어보기. |
| 2 | [시안 2](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/mock-first-finding.png) | 첫 고위험 인물의 해석·지표·프로필 행동을 먼저 확인하기. |
| 3 | [시안 3](/Users/youngminpark/.codex/visualizations/2026/10/09/yeosachin-dev-ux-audit/mock-evidence-ledger.png) | 수집 범위와 요약을 간결하게 묶고 인물 설명을 펼쳐 읽기. |

**사용자의 시안 선택 또는 수정 요청이 아직 도착하지 않았다. 공통 최소 개선 범위도 승인 대기다.** 현재 결과 재설계는 구현하지 않았다. 시안 1에 남아 있는 “모든 공개 계정” 문구를 완전 수집 보장으로 승인하는 것이 아니며, 실제 범위 안내는 명세를 따른다. 시안 일부를 조합하거나 수정한다면 수정 시안을 먼저 보여준 뒤 구현한다.

기능·정보의 최소 개선은 P2-01~05와 기존 DTO 검증이다. 시각 승인 대상은 선택한 결과 화면의 정보 순서·행 밀도·펼치기 행동과 점수 설명 배치다. 점수 계산·가격·주문 상태·소유자 권한·Dev allowlist·DB·provider·worker 계약과 랜딩 마케팅 카피는 이 승인 범위로 바꾸지 않는다.

## 미검증과 남은 blocker

- 시안 1·2·3 선택 또는 수정 요청과 공통 개선 범위 승인이 남아 있다. 승인 전에는 결과 재설계를 구현하지 않는다.
- a299 empty의 완료·비공개 탭·진행과 결과 새로고침, failed의 재접속·입력 화면 복귀, partial의 fresh 재접속·비공개 탭·프로필 dialog 닫기·focus 복구, complete의 보관함 경유 재방문·공개 페이지 1→2→1, 관리자 Kakao 재로그인·목록·상세는 확인됐다. 전체 D5 수용 검증은 아직 완료하지 않았으며 일부 사례나 이전 결과 캡처로 이를 완료 처리하지 않는다.
- 긴 프로필 이름·긴 입력값·모바일 키보드·여러 viewport·세로 스크롤 뒤 CTA·모든 탭·페이지 이동·잘못된 DTO·모든 상태의 새로고침 복구는 포괄적으로 검증하지 않았다. Root의 empty 새로고침·비공개 탭, failed Enter 복귀, partial dialog Enter 닫기·focus 복구 사례는 확인된 범위로 유지하며 전체 키보드·복구 검증으로 확대하지 않는다.
- 실물 모바일 기기, 모바일 CPU·느린 네트워크, 스크린리더, 전체 focus 순서와 모든 모달의 focus 복구는 미검증이다. Dev 관리자 목록 대상 글자의 대비만 정량 측정했으며 전체 화면의 대비·눌림 영역은 별도 확인이 필요하다. WCAG 전체 적합성을 선언하지 않는다. Aside REPL의 request interception이 없어 실제 503·네트워크 단절은 주입하지 못했다.
- Dev 모의 결제 성공은 Production 결제사·실제 카드 과금 성공의 증거가 아니다. 합성 결과는 실제 Instagram provider 수집·AI 성별 추론·AI 품질·실제 계정 분석 성공의 증거가 아니다. Dev checkout·보관함·관리자 읽기는 Production 결제창과 운영 raw UI의 대체 검증이 아니다.
- 구현 후 새 Dev 후보에서 complete·partial·empty·failed·잘못된 응답, 범위·점수·상태 안내, 관리자 대비와 안전한 복귀를 다시 확인해야 한다. 390×844와 데스크톱의 넘침·잘림·CTA 겹침 및 키보드 동작을 검사하고, 미검증 경계는 그대로 명시한다.

## 보고서 작성 검사

최초 작성 agent의 권한은 이 한국어 보고서 한 파일에만 있었다. 기준 한국어 명세와 19개 캡처를 직접 확인해 기존 화면 관측과 Root 조작·측정을 구분했다. Root가 30·31 직접 확인, 관리자 재로그인·대비와 페이지 이동 추가 측정, 독립 조사 결과를 이어 기록했다. 캡처·finding·시안의 번호를 고정하고 미채택 16·17·22를 관측 근거에서 제외했다. 승인 상태·후속 제안·진행 중 검증을 완료나 자동 승인으로 바꾸지 않았다.

최초 읽기 전용 문서 검사는 로컬 링크 23개·캡처 19개·P2 5건·시안 3개를 확인했다. Root 추가 후 이 보고서의 로컬 링크 26개·캡처 21개, 관련 5문서의 로컬 링크 총 65개가 존재함을 확인했다. 두 안전 receipt의 JSON parse, UUID·JWT·키 접두사·private key 패턴, 줄 끝 공백과 diff check도 통과했다. 캡처 중복 번호와 미채택 16·17·22 연결은 없었다. runtime 761파일의 source/effective 지문은 현재 a299 Dev 배포와 같고 runtime 변경 파일은 0개였다. 승인 대기·전체 UX PASS 유보·고정 합성값 문구의 별도 후속 제안 구분을 유지한다.

구현·문서 작성자와 다른 dev_store_spec_review agent가 후속 7개 문서·receipt를 읽기 전용으로 검토했다. JSON 2개·로컬 링크 65개·캡처 21개·민감값 패턴·RGB 대비 재계산을 확인했으며 P1/P2 finding 0, 독립 문서 리뷰 PASS였다. 원격·브라우저·보호 파일을 조회하거나 새 코드 검사를 실행하지 않았다. 이 PASS는 문서의 일관성에 대한 판정이며 사용자 승인이나 전체 UX 수용을 대신하지 않는다.

최초 작성 agent는 애플리케이션 소스·baseline·DB·Git·원격 환경·브라우저·키를 수정하거나 조회하지 않았다. Root의 실제 Aside 조작·safe API 집계와 별도 agent의 소스·검사 실행은 위와 같이 구분했다. 문서 검사는 실제 UI 실행 검사나 credential 전체 탐지를 대신하지 않는다.
