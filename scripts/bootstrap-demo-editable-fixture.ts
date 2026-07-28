/**
 * Deliberate, server-only operator bootstrap. This is never imported by app
 * routes and refuses to replace a dashboard-edited row.
 */
import { createDemoFixture, DEMO_FIXTURE_VERSION } from '../lib/services/demo-analysis/demo-analysis';
import { supabaseAdmin } from '../lib/supabase/admin';

export const OPERATOR_EDITABLE_DEMO_FIXTURE_VERSION = 'operator-editable-fixture-v1';

export function createBootstrapDemoFixturePayload() {
    const fixture = createDemoFixture('operator-bootstrap', DEMO_FIXTURE_VERSION);
    return {
        target: {
            username: 'junho_dem',
            fullName: '모의 분석용 공개 계정',
            bio: '산책과 사진을 기록하는 데모 프로필입니다.',
            profileImage: '/demo-avatars/demo-v3-target-000.webp',
            followersCount: 600,
            followingCount: 580,
            isPrivate: false,
        },
        summary: fixture.summary,
        public: fixture.publicAccounts,
        private: fixture.privateAccounts,
    };
}

type BootstrapClient = {
    from(table: string): {
        select(columns: string): { eq(column: string, value: string): { maybeSingle(): Promise<{ data: unknown; error: unknown }> } };
        insert(value: unknown): Promise<{ error: unknown }>;
    };
};

export async function bootstrapDemoEditableFixture(client: BootstrapClient = supabaseAdmin as unknown as BootstrapClient): Promise<void> {
    const table = client.from('demo_analysis_fixtures');
    const existing = await table.select('version').eq('version', OPERATOR_EDITABLE_DEMO_FIXTURE_VERSION).maybeSingle();
    if (existing.error) throw new Error('Could not check the demo fixture bootstrap state.');
    if (existing.data) throw new Error('The operator editable demo fixture already exists; refusing to overwrite it.');
    const { error } = await table.insert({
        version: OPERATOR_EDITABLE_DEMO_FIXTURE_VERSION,
        status: 'draft',
        payload: createBootstrapDemoFixturePayload(),
    });
    if (error) throw new Error('Could not create the demo fixture draft.');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    bootstrapDemoEditableFixture().then(
        () => process.stdout.write('operator-editable demo fixture draft created\n'),
        () => { process.stderr.write('operator-editable demo fixture bootstrap failed\n'); process.exitCode = 1; },
    );
}
