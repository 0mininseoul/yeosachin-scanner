-- public.users 의 users_phone_number_provenance_check 는 정규화 helper 를 호출한다.
-- CHECK 제약은 SECURITY DEFINER 경계 없이 DML 을 실행한 role 로 평가되므로,
-- rollout 1단계가 helper 실행 권한을 service_role 에서까지 회수한 결과
-- /auth/callback 의 service-role users upsert 가 42501 로 실패했다.
-- 이 migration 은 그 실행 권한만 되돌린다. 다른 어떤 role 에도 부여하지 않는다.
-- 전화번호 검증 정책(주문 snapshot trigger, checkout 가드, Kakao REST 출처와
-- 검증 신선도 기준)은 그대로 두며, 스키마 변경이나 데이터 보정도 하지 않는다.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

GRANT EXECUTE ON FUNCTION public.normalize_kr_mobile_e164(TEXT) TO service_role;
