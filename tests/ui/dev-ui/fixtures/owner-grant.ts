export const ownerGrantFixtureSql = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb);
CREATE TABLE auth.identities (user_id uuid, provider text, identity_data jsonb);
CREATE TABLE public.account_e2e_test_runners (
    account_id uuid PRIMARY KEY, runner_plan text UNIQUE, command_version text
);
CREATE TABLE public.account_classification_audit (
    account_id uuid, command_version text, reason_code text,
    next_account_class text, next_traffic_class text, next_lifecycle text
);
CREATE FUNCTION public.load_e2e_test_runner_v1(owner_id uuid) RETURNS TABLE(runner_plan text)
LANGUAGE sql STABLE AS $$
    SELECT runner.runner_plan FROM public.account_e2e_test_runners AS runner
    JOIN auth.users AS owner ON owner.id = runner.account_id
    WHERE runner.account_id = owner_id AND owner.raw_app_meta_data ->> 'analysis_test_runner_v1' = runner.runner_plan
$$;
`;

export async function seedOwnerGrantAccount(
    query: (sql: string, values: string[]) => Promise<unknown>,
    ownerId: string,
    fixtureEmail: string,
) {
    await query(`
        INSERT INTO auth.users VALUES ($1, $2, '{"provider":"kakao","analysis_test_runner_v1":"basic"}')
    `, [ownerId, fixtureEmail]);
    await query(`
        INSERT INTO auth.identities VALUES ($1, 'kakao', jsonb_build_object('email', $2::text, 'email_verified', true))
    `, [ownerId, fixtureEmail]);
    await query(`
        INSERT INTO public.account_e2e_test_runners VALUES ($1, 'basic', 'dev-live-basic-v1')
    `, [ownerId]);
    await query(`
        INSERT INTO public.account_classification_audit VALUES (
            $1, 'dev-live-basic-v1', 'DEV_LIVE_BASIC_TESTER', 'e2e_test', 'e2e_test', 'active'
        )
    `, [ownerId]);
}
