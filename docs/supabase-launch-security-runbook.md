# Supabase 출시 보안 체크리스트

이 문서는 SQL 마이그레이션으로 처리할 수 없는 Supabase Auth 설정과
`20260714020318_harden_internal_data_api_boundary.sql` 적용 후 검증 절차를 정리한다.
운영 프로젝트에 마이그레이션을 적용하기 전에는 데이터베이스 백업과 변경 창을
확보한다.

## 1. OAuth 전용 인증 설정

현재 제품 로그인 화면은 Google과 Kakao OAuth만 제공한다. Email provider가 켜져
있으면 화면에 노출되지 않아도 외부에서 Supabase Auth API를 직접 호출해 이메일과
비밀번호로 가입할 수 있다.

출시 전에 Supabase Dashboard의 **Authentication > Providers > Email**에서 Email
provider를 비활성화한다. Google과 Kakao provider, 신규 OAuth 가입은 활성 상태로
유지한다.

변경 후 공개 Auth settings 응답과 Dashboard에서 아래 상태를 교차 확인한다.

- `external.email`: `false`
- `external.google`: `true`
- `external.kakao`: `true`
- `disable_signup`: `false`

이 확인은 읽기 전용으로 수행하며 테스트용 이메일 사용자를 생성하지 않는다. 향후
비밀번호 로그인을 제품 기능으로 도입한다면 Email provider를 켜기 전에 Pro 이상
플랜의 leaked-password protection, 최소 8자 이상의 비밀번호 정책, CAPTCHA와 Auth
rate limit을 별도 출시 조건으로 검증한다.

Email provider를 끈 뒤에도 advisor가 leaked-password protection 경고를 표시하면
공개 Auth settings에서 `external.email=false`를 다시 확인하고 OAuth-only 예외로
운영 점검표에 기록한다. 경고를 없애기 위해 사용하지 않는 Email provider를 다시
활성화하지 않는다.

## 2. 내부 테이블 Data API 경계

보안 마이그레이션은 다음 테이블이 존재할 때만 적용된다.

- `public.payments`
- `public.payment_orders`
- `public.users`
- `public.ai_analysis_cache`

각 테이블은 RLS를 활성 상태로 보장하고 `PUBLIC`, `anon`, `authenticated`의 테이블
권한을 제거한다. 기존 `FORCE ROW LEVEL SECURITY` 값은 변경하지 않는다.
`service_role`의 기존 명시적 테이블 권한은 취소하지 않으므로 서버의 Supabase Admin
경로는 유지된다. `payments`의 레거시 client INSERT/SELECT 정책은 제거한다.

`public.update_updated_at_column()`이 존재하면 동일한 trigger 함수 시그니처로
교체한다. 기존 trigger 의존성은 유지하면서 빈 `search_path`, `pg_catalog.now()`,
`SECURITY INVOKER`를 적용하고 함수 실행 권한은 `service_role`에만 남긴다.

## 3. 적용 전후 검증

로컬 계약 테스트를 먼저 실행한다.

```bash
npx vitest run lib/services/analysis/internal-data-api-boundary-migration-contract.test.ts
```

운영 반영 후에는 SQL Editor 또는 읽기 전용 점검 연결로 다음을 확인한다.

```sql
SELECT
    table_name,
    has_table_privilege('anon', pg_catalog.format('public.%I', table_name), 'SELECT') AS anon_select,
    has_table_privilege('authenticated', pg_catalog.format('public.%I', table_name), 'SELECT') AS authenticated_select,
    has_table_privilege('service_role', pg_catalog.format('public.%I', table_name), 'SELECT') AS service_select
FROM (VALUES
    ('payments'),
    ('payment_orders'),
    ('users'),
    ('ai_analysis_cache')
) AS expected(table_name)
WHERE pg_catalog.to_regclass(pg_catalog.format('public.%I', table_name)) IS NOT NULL;

SELECT
    c.relname,
    c.relrowsecurity,
    c.relforcerowsecurity
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('payments', 'payment_orders', 'users', 'ai_analysis_cache');

SELECT
    p.polname,
    p.polcmd
FROM pg_catalog.pg_policy AS p
WHERE p.polrelid = pg_catalog.to_regclass('public.payments');

SELECT
    p.prosecdef,
    p.proconfig,
    has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
    has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
FROM pg_catalog.pg_proc AS p
WHERE p.oid = pg_catalog.to_regprocedure('public.update_updated_at_column()');
```

기대 결과는 다음과 같다.

- 공개 두 역할의 모든 내부 테이블 권한은 `false`다.
- `service_role`의 앱에 필요한 기존 권한은 `true`다.
- 네 테이블의 `relrowsecurity`는 `true`이며 `relforcerowsecurity`는 적용 전과 같다.
- `payments`에 두 레거시 client 정책이 없다.
- 함수는 `SECURITY INVOKER`, 빈 `search_path`이며 공개 역할 실행 권한이 없다.

마지막으로 `/api/user/me`, AI 분석 캐시 조회와 upsert, V1/V2 분석 시작 RPC,
Google/Kakao 로그인을 smoke test한다. 공개 anon key로 네 테이블을 REST/GraphQL에서
조회하거나 수정하는 요청은 권한 오류로 실패해야 한다.

## 참고 문서

- [Supabase: Securing your API](https://supabase.com/docs/guides/api/securing-your-api)
- [Supabase: Password security](https://supabase.com/docs/guides/auth/password-security)
