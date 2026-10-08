# 2026-10-09 관리자 카카오 로그인·운영자 접근 수정

사용자가 관리자 콘솔에서 카카오 로그인 후 홈으로 이동해 접속하지 못한다고 보고했다. 이번 변경은 콘솔의 로그인·권한 진입 경계를 수정한다. 실제 계정 분석·결제·Apify actor·AI generation·DB migration은 실행하지 않는다.

## 확인된 원인

- 기존 서버 페이지는 비로그인 사용자를 `redirectTo` 없이 `/login`으로 보냈다. 공용 로그인 화면은 기본 분석 화면을 목적지로 사용하므로 콘솔 복귀 의도가 사라졌다.
- 운영자 판정은 `authorized / forbidden / unavailable`을 제공하지만 기존 페이지는 boolean만 사용해 권한 부족과 설정 미비를 모두 홈으로 보냈다.
- 10월 9일 aside CLI에서 현재 카카오 로그인 세션으로 콘솔 URL을 열었을 때 홈 이동을 재현했다. 같은 세션의 주문·landing lead 관리자 API는 각각 503이고 비공개 cache 정책을 유지했다.
- root main 기준 Vercel native project inspect는 `yeosachin-scanner` 연결을 확인했다. production 환경 metadata의 `ANALYSIS_AUDIT_OPERATOR_USER_IDS` 설정은 0개였다. root `.env.local`에도 해당 운영자 설정은 없었다. 값이나 사용자 식별자는 보고하지 않았다.

## 수정과 운영 설정

- 콘솔에서 직접 기존 `AuthButtons`를 이용한 관리자 전용 카카오 로그인 화면을 제공한다. 로그인 성공 후 고정 콘솔 경로로 복귀하며, 지원하는 단일 UUID 형태의 분석 상세 목적지만 보존한다. 임의 URL·반복 query·초장문 값은 제외한다.
- 명시적인 세션 부재·무효는 로그인 화면, 인증 서비스 장애·운영자 설정 미비는 이용 불가 화면, 등록되지 않은 계정은 권한 부족 화면으로 구분한다. 검증된 세션과 운영자 판정을 모두 통과한 경우만 기존 workbench를 렌더한다.
- 공용 로그인·OAuth callback·관리자 API·랜딩 문구는 변경하지 않는다. 서버 allowlist와 API의 권한 검사는 유지한다.
- 사용자는 현재 Aside에 로그인된 카카오 계정을 운영자로 사용한다고 명시했다. 해당 세션의 기존 인증 경로를 사용해 운영자 1개를 Vercel production의 sensitive 환경 설정으로 등록했다. native metadata 재조회는 설정 1개·`sensitive`·production target을 확인했다. 값은 CLI stdin과 메모리에서만 전달하며 로그·문서·파일에 기록하지 않았다. root `.env.local`은 변경하지 않았다.
- 환경 설정은 다음 웹 배포에서 적용된다. worker·queue 재배포나 운영 재활성화는 필요하지 않다.

## 관련 검증

구현자는 신규 인증 행동 검사에서 RED 18개 실패로 기존 결함을 확인한 뒤 GREEN 19개 통과를 확인했다. 실제 공유 카카오 버튼 클릭의 OAuth `next`와 browser intent, 인증 오류 분류, 권한 분기, 허용된 workbench 진입을 검증한다.

- 관리자·OAuth 관련 검사: 구현자 142개 PASS.
- 타입체크·대상 ESLint·diff 공백 검사: PASS.
- 구현자와 다른 reviewer: 직접 caller·권한/OAuth 경계 검토 PASS, 신규 19개 독립 재실행 PASS.

변경 파일은 관리자 서버 페이지, 해당 인증 행동 테스트, 이 보고서다. [PR #600](https://github.com/0mininseoul/yeosachin-scanner/pull/600)의 exact head `967320513dd0b09a5fb81809ca702ac664ffa261`에서 CI 타입체크·Vercel 검사와 독립 리뷰를 통과하고 main merge `4075fb1d38db254ae0e4fd904bafa9227586b59d`로 병합했다. 상위 세션도 관련 7개 파일의 86개 검사를 재실행해 PASS를 확인했다.

## 병합 후 실제 운영 검증

2026-10-09 01:31 KST에 완료한 aside CLI 검증과 Vercel native 배포 관측은 다음과 같다. [안전한 검증 영수증](2026-10-09-admin-kakao-access.safe.json)에 식별자·원시 행 없이 결과를 남겼다.

- Vercel native deployment list는 위 main merge를 source로 한 production 배포 `READY`를 반환했다. native `inspect yeosachin.com`은 같은 배포 URL에 production 도메인이 연결된 상태를 확인했다.
- 등록 계정의 기존 세션에서 `/admin/analysis-audit`의 `판독 운영 콘솔`과 주문·Leads·계정 운영 영역이 표시됐다.
- 사이트 UI에서 로그아웃한 뒤 콘솔 URL을 다시 열어 **관리자 콘솔 로그인**과 카카오 버튼을 확인했다. 그 버튼을 실제로 눌러 카카오 OAuth를 거친 후 `https://yeosachin.com/admin/analysis-audit`로 돌아와 콘솔이 표시됐다. 홈 redirect·권한 부족·설정 미비 화면은 나타나지 않았다.
- 새 로그인 세션의 `/api/admin/order-audit`, `/api/admin/landing-leads`, `/api/admin/apify-accounts`는 모두 HTTP 200이며 `private`·`no-store` cache 정책을 유지했다. 응답 원시 행·사용자 식별자는 출력하거나 보존하지 않았다.
- Apify 계정 GET은 기존 DB inventory 조회 경로다. 잔액 refresh·배차 toggle·분석·결제 버튼은 누르지 않았고 Apify actor·AI generation을 호출하지 않았다.

사용자가 보고한 로그인 후 홈 이동 및 콘솔 접근 오류는 새 production 배포에서 해결을 확인했다.

## 남은 경계

Apify 잔액 refresh·배차 toggle·분석 실행은 이번 검증 대상이 아니다. 읽기 콘솔 검증을 실제 provider 운영 성공으로 확대 해석하지 않는다.

실제 계정 분석 성공과 Vertex 실제 품질 gate는 별도 미검증 경계다. 별도 Dev 환경 제안의 결제·더미 분석 설계도 이 관리자 수정에 포함하지 않는다.
