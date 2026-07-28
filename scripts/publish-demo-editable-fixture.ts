/** Controlled publication boundary for dashboard-edited demo fixture drafts. */
import { supabaseAdmin } from '../lib/supabase/admin';
import { demoFixturePayloadSchema } from '../lib/services/demo-analysis/fixture-store';

type PublisherClient = {
    from(table: string): { select(columns: string): { eq(column: string, value: string): { eq(column: string, value: string): { maybeSingle(): Promise<{ data: unknown; error: unknown }> } } } };
    rpc(name: string, input: Record<string, unknown>): Promise<{ error: unknown }>;
};

export async function publishDemoEditableFixture(client: PublisherClient = supabaseAdmin as unknown as PublisherClient, version: string): Promise<void> {
    if (!/^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$/.test(version)) throw new Error('Invalid operator fixture version.');
    const { data, error } = await client.from('demo_analysis_fixtures').select('version, status, payload')
        .eq('version', version).eq('status', 'draft').maybeSingle();
    if (error || !data || typeof data !== 'object') throw new Error('Draft fixture was not found.');
    const row = data as { version?: unknown; status?: unknown; payload?: unknown };
    if (row.version !== version || row.status !== 'draft') throw new Error('Draft fixture was not found.');
    const parsed = demoFixturePayloadSchema.safeParse(row.payload);
    if (!parsed.success) throw new Error('Draft fixture is invalid and was not published.');
    const result = await client.rpc('publish_demo_analysis_fixture', { p_version: version, p_expected_payload: parsed.data });
    if (result.error) throw new Error('Draft fixture changed or could not be published.');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    const version = process.argv[2];
    if (!version) {
        process.stderr.write('usage: publish:demo-fixture <operator-editable-fixture-version>\n');
        process.exitCode = 1;
    } else {
        publishDemoEditableFixture(undefined, version).then(
            () => process.stdout.write('operator-editable demo fixture published\n'),
            () => { process.stderr.write('operator-editable demo fixture publish failed\n'); process.exitCode = 1; },
        );
    }
}
