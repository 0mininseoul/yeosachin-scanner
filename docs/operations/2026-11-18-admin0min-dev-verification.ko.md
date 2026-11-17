# 관리자 카카오 로그인·Dev 재개 검증

확인일2026-11-18 KST. [PR #608](https://github.com/0mininseoul/yeosachin-scanner/pull/608)에서 관리자 진입과 인증 복구를 변경하고 Dev 검증 및 비용 후속을 기록한다.

## 원인 조사와 처리

사용자가 제공한 `invalid_request/bad_oauth_state`와 `OAuth state not found or expired`는 Supabase Auth가 provider 콜백의 OAuth 상태 행을 찾지 못할 때 반환한다. 이 경로는 앱의 `/auth/callback` 전에 Supabase가 SiteURL로 이동하므로 관리자 목적지가 소실됐다. [Supabase Auth 상태 조회](https://github.com/supabase/auth/blob/387e91f37e00b64b9060352988066bbb685f6e45/internal/api/external.go#L535-L582), [오류 리다이렉트](https://github.com/supabase/auth/blob/387e91f37e00b64b9060352988066bbb685f6e45/internal/api/external_oauth.go#L29-L57).

Root는 Aside u0의 해당 오류가 남은 Production 루트 탭을 확인했다. 그 상태에서 기존 관리자 주소를 열었을 때 이미 운영자 세션이 유효했다. 로그아웃 후 새 로그인은 성공했다. 완료된 콜백 재사용 등으로 같은 오류가 날 수 있지만 과거 상태 행이 사라진 직접 계기는 확인하지 못했다.

새 관리자 주소는 `https://yeosachin.com/admin0min`이다. 기존 주소는 유효한 단일 상세 목적지만 검증해 새 주소로 이동한다. 루트의 정확한 오류 값과 유효한 관리자 로그인 목적지 쿠키가 함께 있을 때 원시 설명을 제거하고 새 관리자 화면을 복원한다. 화면에서 수동으로 새 카카오 로그인을 시작한다. 콜백 오류도 목적지를 보존하며 같은 렌더 주기의 이중 클릭은 동기 가드로 차단한다. 성공 콜백 뒤 목적지 쿠키가 소모된 경우도 처리한다. 정확한 루트 오류와 오류 없는 getUser 응답·기존 운영자 권한을 확인했을 때 새 관리자 주소로 돌아간다. Dev는 배포·tester·admin 권한을 함께 검증한다. 소비자 목적지가 남아 있거나 인증·권한 설정을 확인할 수 없는 경우 일반 탐색을 유지한다. 갱신된 인증 쿠키를 복귀 응답에 보존한다. 권한·OAuth state·PKCE 검증과 noindex/리플레이 제외를 유지한다.

## 카카오 Dev 동의항목

사용자는 서비스가 요청하는7개 항목으로 설정할 것을 확인했다. Root는 Aside의 기존 `yeosachin-dev` 테스트 앱 동의항목 화면에서 저장하고 새로고침 후 재확인했다.

| scope | 동의 단계 | 처리 |
| --- | --- | --- |
| account_email | 필수 | 기존 설정 유지 |
| profile_nickname | 선택 | 기존 설정 유지 |
| profile_image | 선택 | 기존 설정 유지 |
| name | 선택 | 회원 프로필 표시와 계정 식별 목적 저장 |
| gender | 선택 | 회원 프로필 관리와 서비스 이용 통계 목적 저장 |
| birthyear | 선택 | 출생 연도 확인과 프로필 관리 목적 저장 |
| phone_number | 선택 | 회원 연락처와 결제 계정 확인 흐름 테스트 목적 저장 |

추가4개에서 값이 없는 사용자의 강제 정보 입력 설정은 선택하지 않았다. Dev/운영 앱 요청 scope를 위7개로 맞췄다. 새 Dev 로그인에서 카카오가 추가4개 제공 동의를 표시했고 승인 후 `/admin0min`의 모의 주문 감사로 복귀했다.

## 검사와 배포

최초 코드 후보836ac583에서 Root가22파일356검사를 재실행했다. 쿠키 없는 유효 세션 복귀를 보완한 후보 `08f54895d51dc8ddd7296a1389bed22e04e7110f`에서는 Root가 관련24파일427검사·타입체크·ESLint·diff를 확인했다. 비구현자 리뷰는 최초9파일309검사와 후속proxy114검사를 독립 재실행해 각 단계 P1/P2 0건을 보고했다.

Dev 배포 `dpl_9epBXsLZiiaChPzqgnPMt34Hv8MX`는 exact project/owner·후보 SHA·READY·dev 도메인 연결을 native CLI로 확인했다. clean tracked archive를 임시 디렉터리에 만들고 그곳에서만 승인 Dev 설정을 표준 vercel.json으로 덮어 배포했다. 업로드 임시 자료는 정리했고 실제 checkout과 Production link는 유지했다. 배포 뒤 cron 비활성·정의0·자동Git연결 없음도 재확인했다.

복원된 Dev Supabase는 ACTIVE_HEALTHY다. Aside 최신 CLI는 실제390×844 viewport 설정을 지원해 Dev 인증과 화면 흐름을 직접 확인한다. 사용자는 이번에 실물 iPhone 대신 Dev 모바일 viewport 범위를 선택했다. 상세 브라우저 동작과 최종 PR 검사/병합·main 동기화는 종료 검증에 기록한다.

## 비용 후속과 남은 근거

[Cloud Run 비용 보고서](2026-11-18-cloud-run-cost.ko.md)는 Monitoring 사용량과 프로젝트로 필터링한 Billing Reports 집계를 함께 기록한다. PT완료7일의 사용 비용7,158→1,512원, 소계는 두 기간0원이다. KST정가 환산 감소율은79.0%이고 두 자료의 일별 경계가 다르다. 인보이스 수준 세금·조정과 현금 결제액은 미확인이다.

11/13 preflight 5xx 100건은 최초 보고 때 미확정으로 남겼다. 사용자 요청으로 진행한 [후속 원인 조사](2026-11-18-oauth-preflight-root-causes.ko.md)에서 용량 재시도 RPC의 65/63바이트 이름 불일치를 확인하고 PR #609에서 수정했다. OAuth는 provider 콜백·PKCE 성공 직후 상태 없음 오류가 발생한 운영 순서를 확인했다. 소비한 콜백의 재요청이 유력하며 같은 flow의 재요청 방식은 기존 로그만으로 확정하지 않는다. 배포 검증과 실제 사용자 계정 분석의 경계는 후속 문서에서 구분한다.

실제 Instagram 분석·Apify actor·AI 생성·실제 결제는 실행하지 않았다. Production 실제 계정 분석은 사용자 실행 경계와 기존 별도 Vertex 예산 승인 조건을 따른다. 보호 파일·보존 refs·backup 자료는 유지한다.

## 실제 Dev 흐름 검수

최초 배포 후보836ac583에서7scope 새 카카오 동의→관리자 복귀,390×844 로그인·합성 사전점검·성별 확인·플랜·모의 결제·진행·같은URL새로고침·자동결과 이동을 확인했다. 결과GET은200이며 viewport내 가로 넘침이 없었다. 초기 이미지 캡처는2%, 이후DOM은45%·최종 작업으로 변했으며 같은 시점으로 오해하지 않는다. 1440×900의 실패 시나리오는 종료된 실패 화면과 새 분석 버튼을 확인했다. 후속 proxy 배포의 인증 오류 복귀는 아래 최종 검수에서 확인했다.

## 최종 Dev 후보 확인

후속 코드 후보08f54895의 Dev 배포 `dpl_DBKL3AB2CHZYANsMTBFiSW16S6AS`는 READY·정확한 프로젝트·후보SHA·dev 도메인을 native CLI로 확인했다. 최초836 후보의 UI 검수 이후 proxy와 해당 검사만 변경됐다. 마지막 문서 commit은 앱 소스 동등성을 확인해 이 배포에 연결한다.

- 유효 Dev 운영자 세션에서 사용자와 동일한 오류 query를 루트에 입력해 앱 복귀 경로를 검수했다. `/admin0min`으로 복귀하고 provider 설명이 제거됐다. 이는 앱의 오류 응답 처리 확인이며 과거 Supabase 상태 소실을 실시간 재현한 검사는 아니다.
- 기존 관리자 URL도 `/admin0min`으로 이동했다.
- 로그아웃 뒤 code 없는 `/auth/callback?next=/admin0min`을 열면 새 관리자 로그인 화면과 한국어 수동 재로그인 안내가 나타났다. 카카오 버튼으로 새 로그인 후 모의 주문 감사로 복귀했으며 관리자 읽기API는200이었다.
- 최종 로그인 후390×844에서 관리자 화면의 가로 넘침이 없었다. 7scope는 카카오 추가동의까지 포함해 앞선836 배포에서 실제 확인했고 후속에서도 같은 설정으로 새SSO를 통과했다.
- 실패 화면의 새 분석 시작 버튼은 Enter로/analyze에 복귀했다. 보관함의 완료 링크는 같은 결과 resource 경로로 이동했다. 자동 이동 URL에는pipeline=v2가 있고 보관함 URL에는 없으므로 전체URL문자열 동등성으로 판정하지 않았다.
- Aside의 waitForURL에서 glob 문자열은 실제 이동 후에도 timeout을 반환했다. 이후 snapshot과 실제 pathname을 확인해 검수했다. 첫 관측의 일부 snapshot은 탐색 완료 전 화면이어서 다음 snapshot에서 결과를 확인했다.

브라우저 캡처는 [모바일 진행](/Users/youngminpark/.codex/visualizations/2026/11/18/yeosachin-admin-dev/dev-mobile-progress.png), [동일 실행 새로고침](/Users/youngminpark/.codex/visualizations/2026/11/18/yeosachin-admin-dev/dev-mobile-progress-reload.png), [모바일 결과](/Users/youngminpark/.codex/visualizations/2026/11/18/yeosachin-admin-dev/dev-mobile-result.png), [의도한 합성 실패](/Users/youngminpark/.codex/visualizations/2026/11/18/yeosachin-admin-dev/dev-desktop-terminal-failure.png), [콜백 오류 재로그인](/Users/youngminpark/.codex/visualizations/2026/11/18/yeosachin-admin-dev/dev-admin0min-no-code-retry.png), [최종 모바일 관리자](/Users/youngminpark/.codex/visualizations/2026/11/18/yeosachin-admin-dev/dev-admin0min-mobile-authenticated.png)다. checkout 상태를 찍은 예비 캡처는 진행 증거로 채택하지 않는다. Billing 행의 locator 캡처는 header만 담겨 증거에서 제외했고, 실제 snapshot에서 읽은 서비스별 집계와 기간을 안전한 JSON에 기록했다.

PR의 최종 문서 포함 HEAD 검사·독립 검토 뒤 main에 병합한다. 그 뒤 Production native 배포와 실제 새 카카오 로그인·오류 복귀·관리자 읽기를 확인해 Root 종료 기록으로 마감한다. 이 문서는 작성 시점의 관찰이며 최종 병합 상태는 PR기록과 종료 검증을 따른다.
