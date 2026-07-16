-- users 테이블에 소셜 로그인(카카오/구글)으로 수집하는 프로필 정보 컬럼 추가.
-- 카카오 동의항목 승인: 이름(name), 성별(gender), 출생연도(birthyear), 전화번호(phone_number),
-- 닉네임(profile_nickname), 프로필사진(profile_image), 이메일(account_email).
-- /api/user/me 에서 auth user_metadata 를 매핑하여 저장한다.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS nickname VARCHAR(255),
    ADD COLUMN IF NOT EXISTS profile_image TEXT,
    ADD COLUMN IF NOT EXISTS phone_number VARCHAR(50),
    ADD COLUMN IF NOT EXISTS gender VARCHAR(20),
    ADD COLUMN IF NOT EXISTS birthyear VARCHAR(4);
