-- public.users 의 users_phone_number_provenance_check 는 정규화 helper 를 호출한다.
-- CHECK 제약은 SECURITY DEFINER 경계 없이 DML 을 실행한 role 로 평가되므로,
-- rollout 1단계가 helper 실행 권한을 service_role 에서까지 회수하자
-- service_role 의 public.users 쓰기가 42501 로 실패했다.
--
-- Postgres 는 이 제약의 OR 분기를 단축 평가하지 않는다. 따라서 영향 범위는
-- 카카오 전화번호 저장에 그치지 않고 provider 와 전화번호 유무를 가리지 않았다.
-- /auth/callback 의 프로필 동기화와 /api/user/me 의 사용자 행 생성·갱신이 모두 막혔다.
-- 배포 후에는 두 경로를 함께 확인한다.
--
-- 이 migration 은 그 실행 권한만 되돌린다. 다른 어떤 role 에도 부여하지 않는다.
-- 전화번호 검증 정책(주문 snapshot trigger, checkout 가드, Kakao REST 출처와
-- 검증 신선도 기준)은 그대로 두며, 스키마 변경이나 데이터 보정도 하지 않는다.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

GRANT EXECUTE ON FUNCTION public.normalize_kr_mobile_e164(TEXT) TO service_role;
