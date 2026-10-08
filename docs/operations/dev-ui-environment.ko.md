# Dev UI 환경 사용과 후보 승격

2026-10-09에 승인한 1차 UI 검증 환경이다. 웹은 `https://dev.yeosachin.com`, Vercel 프로젝트는 `yeosachin-dev`, Supabase 프로젝트는 `bgamojfpkxnnumfvkron`이다. 별도 Free DB와 기존 Hobby 팀을 사용하며 새 유료 구독·GCP worker/queue를 만들지 않았다.

## 테스트 흐름

1. Dev 도메인에서 카카오로 로그인한다. Production과 다른 Dev Auth 계정으로 테스트/관리자 allowlist에 등록되어 있어야 한다.
2. `/analyze`에서 합성 대상 이름과 완료·부분 완료·실패·빈 결과 시나리오를 선택한다. 입력한 이름으로 Instagram에 접근하지 않는다.
3. 기존 사전 점검·플랜 화면을 거쳐 모의 결제창으로 이동한다. 이 단계까지 분석은 시작되지 않는다.
4. 모의 결제 성공을 선택하면 주문당 실행 1개가 생성되고 약 45초 동안 합성 진행을 보여준다. 취소·실패는 실행을 만들지 않는다.
5. 완료 결과를 다시 방문하거나 `/mypage`에서 모의 주문/실행을 확인한다. `/admin/analysis-audit`는 Dev 모의 주문의 읽기 감사만 제공한다.

실제 카드, Apify, Vertex, RapidAPI, Instagram, R2, 운영 메일·Discord·Amplitude를 사용하지 않는다. 테스트 표시는 실제 결제/수집/AI 성공을 의미하지 않는다. 미결제 주문은 30분, 완료 실행은 별도 7일 수명을 갖는다. 완료 후 응답 중단·재시도·재방문은 동일 실행과 시작 시각을 복구한다.

## 로그인과 접근 권한

Dev 전용 카카오 테스트 앱과 Dev Supabase provider를 사용한다. 앱 callback은 Dev 웹의 `/auth/callback`, provider callback은 Dev Supabase의 `/auth/v1/callback`이다. Production cookie를 옮기거나 cookie Domain을 넓히지 않는다.

`DEV_UI_TEST_USER_IDS`, `DEV_UI_ADMIN_USER_IDS`, 기존 콘솔의 `ANALYSIS_AUDIT_OPERATOR_USER_IDS`는 Dev에서 새로 생성한 Auth 계정으로 별도 등록한다. 관리자 권한은 tester와 admin의 교집합을 요구한다. 계정 식별자는 문서·커밋·터미널·채팅에 남기지 않는다. 인증된 `/api/user/me`의 기본 bootstrap은 최초 등록을 위해 allowlist 이전에도 가능하며 모의 생성/감사 권한은 부여하지 않는다.

## 후보 배포와 main 승격

장기 dev 브랜치를 함께 승격하는 대신 `codex/*` 후보를 고정 Dev 환경에서 검증한다. 한 번에 후보 하나만 배포한다.

1. 최신 `origin/main`에서 후보를 준비하고 PR을 생성한다. 대상 기능 검사·독립 명세 리뷰·다른 agent의 품질 리뷰를 수행한다.
2. 후보 worktree에서 `npx vercel project inspect --non-interactive`로 owner와 프로젝트 `yeosachin-dev`를 확인한다. root Production link나 전체 `.env.local`을 복사하지 않는다.
3. `npx vercel deploy --prod --local-config vercel.dev.json --scope 0minseouls-projects --non-interactive`로 **Dev 프로젝트의 production 슬롯**에 배포한다. `--prod`는 연결된 Dev 프로젝트를 뜻하며 운영 웹으로 승격하는 명령이 아니다. 대상이 다르면 중단한다.
4. `vercel.dev.json`은 Dev cron과 Git 자동 배포를 등록하지 않는다. `.vercelignore`는 credential·브라우저·로컬 실행 자료를 manual upload에서 제외한다. Dev 환경변수에는 Dev DB/Auth와 역할/allowlist만 등록한다.
5. Aside CLI에서 로그인·사전 점검·모의 결제·진행·결과·보관함·관리자, 모바일/데스크톱, 실패/빈 결과/권한 부족을 확인한다. 후보 commit/tree와 런타임 소스 fingerprint, 배포 identity, DB 기준점, 안전한 검증 영수증을 연결한다.
6. 코드/SQL이 바뀌면 관련 검사를 다시 하고 새 후보를 배포해 영향을 받는 UI를 재검증한다. 문서만 달라진 경우 동일 런타임 fingerprint와 배포 원본 commit을 명시한다.
7. exact-head PR 검사와 독립 리뷰 통과 뒤 main에 병합한다. main은 직접 push하지 않는다. canonical root main을 fetch/fast-forward하고 `main == origin/main`을 확인한다.

Dev 검증은 Production migration 적용 허가나 실제 worker/결제/provider 검증을 대체하지 않는다. 운영 schema 변경은 정확한 migration allowlist·dry-run·독립 리뷰·원격 history 검증을 별도로 수행한다.

## DB 기준점과 유지보수

운영 데이터를 복사하지 않은 schema 기준점과 Dev 전용 private control schema를 사용한다. [초기화 자료와 예외](../../supabase/dev-ui/README.ko.md)를 확인한다. 기준 public 테이블은 150개이며 과거 22-table 목표를 다시 시작하지 않는다. Auth 알림 trigger 생략·사고 복구 함수 4개 비활성화·관리형 GraphQL 버전 차이는 명시된 환경 예외다.

기존 schema 보안 metadata는 유지된다. 현재 advisor가 보고한 기존 정의의 WARN 26개는 이번 Dev control의 새 경고가 아니며 전체 보안 PASS로 표현하지 않는다. 과거 6대6 migration 이력 차이, 원본 보존 자료와 보호 파일은 유지한다. `history repair`, `--include-all`, Production reset은 실행하지 않는다.

Free Supabase는 휴면으로 pause될 수 있다. 재개 때 Dev identity·Auth·배포/도메인 상태와 필요한 UI 검사를 새로 확인한다. 무료 quota 초과 또는 유료 전환은 별도 비용 승인 대상이다. 실제 계정 분석은 사용자가 Production에서 수행하며 Vertex 실측은 별도 예산·과금 상한 검증 후 진행한다.
