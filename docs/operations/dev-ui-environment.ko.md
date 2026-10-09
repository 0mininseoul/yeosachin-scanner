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
3. clean 후보 HEAD의 tracked 파일만 `git archive`로 새 0700 임시 업로드 디렉터리에 추출한다. **그 임시 디렉터리에서만** 승인된 `vercel.dev.json` 바이트를 표준 `vercel.json`으로 적용하고, 검증한 후보의 Dev `.vercel/project.json`만 0600으로 넣는다. 실제 checkout의 Production `vercel.json`과 root link는 유지한다. `.env.local`·브라우저/비추적/ignored 자료를 복사하지 않는다. 후보 SHA와 Dev 설정 SHA256을 별도로 기록한다.
4. 임시 디렉터리에서 native project inspect로 정확한 `yeosachin-dev` project/owner를 다시 확인한 뒤 `npx vercel deploy --prod --local-config vercel.json --scope 0minseouls-projects --non-interactive`로 **Dev 프로젝트의 production 슬롯**에 배포한다. `--prod`는 연결된 Dev 프로젝트를 뜻한다. 등록 결과가 불명확하면 같은 배포를 반복하지 않고 native 상태·metadata부터 확인한다. 업로드가 끝나면 자신이 만든 임시 디렉터리만 정리한다. `.vercelignore`는 credential·브라우저·로컬 실행 자료를 제외한다. Dev 환경변수는 Dev DB/Auth와 역할/allowlist만 사용한다.
5. Aside CLI에서 로그인·사전 점검·모의 결제·진행·결과·보관함·관리자, 모바일/데스크톱, 실패/빈 결과/권한 부족을 확인한다. 후보 commit/tree와 런타임 소스 fingerprint, 배포 identity, DB 기준점, 안전한 검증 영수증을 연결한다.
6. 코드/SQL이 바뀌면 관련 검사를 다시 하고 새 후보를 배포해 영향을 받는 UI를 재검증한다. 문서만 달라진 경우 동일 런타임 fingerprint와 배포 원본 commit을 명시한다.
7. exact-head PR 검사와 독립 리뷰 통과 뒤 main에 병합한다. main은 직접 push하지 않는다. canonical root main을 fetch/fast-forward하고 `main == origin/main`을 확인한다.

Dev 검증은 Production migration 적용 허가나 실제 worker/결제/provider 검증을 대체하지 않는다. 운영 schema 변경은 정확한 migration allowlist·dry-run·독립 리뷰·원격 history 검증을 별도로 수행한다.

### 원격 빌드 설정과 cron 확인

10월 9일 CLI 54.7.1에서 `--local-config vercel.dev.json`만 사용한 첫 배포는 native project에 기존 cron 2개를 남겼다. CLI가 빈 배열을 제거했다는 증거는 없고, 업로드된 표준 파일과 원격 builder 선택의 차이가 원인이라는 가설을 뒷받침한다. 서버 내부 우선순위는 직접 확인하지 못했다. 위 절차는 업로드 표준 파일 자체를 Dev 설정으로 맞춘다.

Dev-only native `PATCH /v1/projects/{검증한 Dev project ID}/crons`의 stdin body `{"enabled":false}`로 자동 실행을 중단하고, 재배포 후 native project의 `crons.disabledAt`과 **`crons.definitions.length === 0`**를 각각 확인한다. 비활성화만으로 정의가 삭제되지는 않는다. 실제 production cron은 변경하지 않는다. [공식 cron 관리 문서](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [공식 provider 구현](https://github.com/vercel/terraform-provider-vercel/blob/main/client/project_crons.go).

a299eb34 후보를 Dev 설정 SHA `bceed793e1df0880076af0e5ad43951fee31ada3ee4bb310bdafe13d737d9358`로 배포한 `dpl_Aw1pZzD5WENkCKu7XoVx9C9EhF4Y`는 exact Dev project·READY·cron 비활성·정의 0개·Git 자동 배포 없음·임시 자료 정리를 확인했다. 후보 source SHA·tree와 761개 runtime 파일의 source/effective hash를 함께 기록한다. 후속 문서만 바뀐 HEAD는 runtime hash 동등성을 확인해 이 배포와 연결하며, runtime 변경은 새 배포와 실제 검증을 요구한다.

실제 SSO와 fresh Dev 계정의 별도 sensitive allowlist 등록을 확인했고, a299에서 로그아웃→관리자 deep link→카카오 로그인→Dev 콘솔 복귀·user-me/관리자 조회 HTTP 200을 재확인했다. [Vercel 영수증](../../supabase/dev-ui/vercel-configuration.safe.json)과 [OAuth 영수증](../../supabase/dev-ui/kakao-configuration.safe.json)은 계정 식별자와 credential을 담지 않는다. [실제 UX 감사](2026-10-09-dev-ui-ux-audit.ko.md)와 [브라우저 영수증](2026-10-09-dev-ui-browser.safe.json)에 확인 범위·미적용 후속 제안·검증 한계를 기록한다.

2026-10-09 사용자 결정으로 **결과 페이지는 기존 버전을 유지하고 결과 시안 1/2/3은 미채택**한다. 검토 대상은 분석 중(progress) 화면이며 해당 UX 검토는 별도 후속으로 분리한다. [결과 시안 문서](../superpowers/specs/2026-10-09-analysis-result-ux-review.ko.md)는 미채택 참고 제안으로 보존한다. 기존 5개 finding과 공통 개선은 미승인·미적용 후속 제안이며 삭제·해결 처리하지 않는다. 결과 점수·수집 문구 변경도 승인되지 않았다. 결과 시안이나 공통 제안의 승인을 기다리는 조건은 폐기하며 이 미채택을 Dev 인프라 PR의 병합 blocker로 두지 않는다.

Root 전달 기준 PR #602는 사용자가 main `cdf3c4ed10c3f9a793ca7758eeb1d354b9e13e05`에 병합했고 Root가 Dev 후보 브랜치에도 merge했다. 런타임 변경은 없다. D5 기본 흐름 검증은 존재하지 않는 주문 조회404·안전한 입력 복귀까지 완료했다. 문서 관측 시점에는 PR #603이 Draft·기존 검사 PASS·최종 출하 조건 독립 검토 중이며 병합은 아직 수행하지 않았다. D5의 현재 상태는 **Dev 구축 최종 검토·PR 승격 진행**이다. 실제 병합·동기화의 최종 상태는 [PR #603 최종 기록](https://github.com/0mininseoul/yeosachin-scanner/pull/603)과 상위의 종료 검증으로 확인한다. 이 기록은 영구적인 Draft blocker나 기능 미완료를 뜻하지 않으며 전체 UX PASS도 선언하지 않는다.

## DB 기준점과 유지보수

운영 데이터를 복사하지 않은 schema 기준점과 Dev 전용 private control schema를 사용한다. [초기화 자료와 예외](../../supabase/dev-ui/README.ko.md)를 확인한다. 기준 public 테이블은 150개이며 과거 22-table 목표를 다시 시작하지 않는다. Auth 알림 trigger 생략·사고 복구 함수 4개 비활성화·관리형 GraphQL 버전 차이는 명시된 환경 예외다.

기존 schema 보안 metadata는 유지된다. 현재 advisor가 보고한 기존 정의의 WARN 26개는 이번 Dev control의 새 경고가 아니며 전체 보안 PASS로 표현하지 않는다. 과거 6대6 migration 이력 차이, 원본 보존 자료와 보호 파일은 유지한다. `history repair`, `--include-all`, Production reset은 실행하지 않는다.

Free Supabase는 휴면으로 pause될 수 있다. 재개 때 Dev identity·Auth·배포/도메인 상태와 필요한 UI 검사를 새로 확인한다. 무료 quota 초과 또는 유료 전환은 별도 비용 승인 대상이다. 실제 계정 분석은 사용자가 Production에서 수행하며 Vertex 실측은 별도 예산·과금 상한 검증 후 진행한다.
