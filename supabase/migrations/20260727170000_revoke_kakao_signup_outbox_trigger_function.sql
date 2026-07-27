-- Trigger functions should not be directly callable by client roles.
REVOKE EXECUTE ON FUNCTION public.enqueue_kakao_signup_discord_outbox() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enqueue_kakao_signup_discord_outbox() FROM anon;
REVOKE EXECUTE ON FUNCTION public.enqueue_kakao_signup_discord_outbox() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_kakao_signup_discord_outbox() TO service_role;
