# 관리자 카카오 로그인·Dev 재개 검증

확인일2026-11-18 KST. [PR #608](https://github.com/0mininseoul/yeosachin-scanner/pull/608)에서 관리자 진입과 인증 복구를 변경하고 Dev 검증 및 비용 후속을 기록한다.

## 원인 조사와 처리

사용자가 제공한 `invalid_request/bad_oauth_state`와 `OAuth state not found or expired`는 Supabase Auth가 provider 콜백의 OAuth 상태 행을 찾지 못할 때 반환한다. 이 경로는 앱의 `/auth/callback` 전에 Supabase가 SiteURL로 이동하므로 관리자 목적지가 소실됐다. [Supabase Auth 상태 조회](https://github.com/supabase/auth/blob/387e91f37e00b64b9060352988066bbb685f6e45/internal/api/external.go#L535-L582), [오류 리다이렉트](https://github.com/supabase/auth/blob/387e91f37e00b64b9060352988066bbb685f6e45/internal/api/external_oauth.go#L29-L57).

Root는 Aside u0의 해당 오류가 남은 Production 루트 탭을 확인했다. 그 상태에서 기존 관리자 주소를 열었을 때 이미 운영자 세션이 유효했다. 로그아웃 후 새 로그인은 성공했다. 완료된 콜백 재사용 등으로 같은 오류가 날 수 있지만 과거 상태 행이 사라진 직접 계기는 확인하지 못했다.

새 관리자 주소는 `https://yeosachin.com/admin0min`이다. 기존 주소는 유효한 단일 상세 목적지만 검증해 새 주소로 이동한다. 루트의 정확한 오류 값과 유효한 관리자 로그인 목적지 쿠키가 함께 있을 때 원시 설명을 제거하고 새 관리자 화면을 복원한다. 화면에서 수동으로 새 카카오 로그인을 시작한다. 콜백 오류도 목적지를 보존하며 같은 렌더 주기의 이중 클릭은 동기 가드로 차단한다. 권한·OAuth state·PKCE 검증과 noindex/리플레이 제외를 유지한다.

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

최초 코드 후보 `836ac58331706f0e40b9708e27bdd51fe6fe4e92`에서 Root가 관련22파일356검사·타입체크·diff를 재실행해 통과했다. 구현 agent는 수정14파일ESLint도 통과했고 비구현자 리뷰는9파일309검사를 독립 재실행해 P1/P2 0건을 보고했다.

Dev 배포 `dpl_9epBXsLZiiaChPzqgnPMt34Hv8MX`는 exact project/owner·후보 SHA·READY·dev 도메인 연결을 native CLI로 확인했다. clean tracked archive를 임시 디렉터리에 만들고 그곳에서만 승인 Dev 설정을 표준 vercel.json으로 덮어 배포했다. 업로드 임시 자료는 정리했고 실제 checkout과 Production link는 유지했다. 배포 뒤 cron 비활성·정의0·자동Git연결 없음도 재확인했다.

복원된 Dev Supabase는 ACTIVE_HEALTHY다. Aside 최신 CLI는 실제390×844 viewport 설정을 지원해 Dev 인증과 화면 흐름을 직접 확인한다. 사용자는 이번에 실물 iPhone 대신 Dev 모바일 viewport 범위를 선택했다. 상세 브라우저 동작과 최종 PR 검사/병합·main 동기화는 종료 검증에 기록한다.

## 비용 후속과 남은 근거

[Cloud Run 비용 보고서](2026-11-18-cloud-run-cost.ko.md)는 Monitoring 사용량과 프로젝트로 필터링한 Billing Reports 집계를 함께 기록한다. PT완료7일의 사용 비용7,158→1,512원, 소계는 두 기간0원이다. KST정가 환산 감소율은79.0%이고 두 자료의 일별 경계가 다르다. 인보이스 수준 세금·조정과 현금 결제액은 미확인이다.

11/13에 집중된 preflight5xx100건은 앱·provider 분류까지 확인했고 이후 maintenance는 정상화됐다. 실제 사용자 worker 성공 기록과 구체적 UNKNOWN 예외 정보가 부족해 현재 코드 결함이나 완전 해결로 단정하지 않는다. 재현 실행의 안전한 오류 분류·provider 가용성이 조사의 재개 조건이다.

실제 Instagram 분석·Apify actor·AI 생성·실제 결제는 실행하지 않았다. Production 실제 계정 분석은 사용자 실행 경계와 기존 별도 Vertex 예산 승인 조건을 따른다. 보호 파일·보존 refs·backup 자료는 유지한다.
