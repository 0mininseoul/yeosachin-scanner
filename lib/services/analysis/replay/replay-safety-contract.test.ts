import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const liveSource = new URL('./replay-live-source.ts', import.meta.url);
const stagedAdapter = new URL('./replay-staged-ai-adapter.ts', import.meta.url);
const runner = new URL('./replay-runner.ts', import.meta.url);

describe('analysis V2 replay safety contract', () => {
    it('cannot start, mutate, abort, or delete an Apify Actor run', async () => {
        const source = await readFile(liveSource, 'utf8');
        expect(source).not.toMatch(/\.(?:actor|start|update|delete|abort)\s*\(/);
        expect(source).toContain('client.run(runId).get()');
        expect(source).toContain('client.dataset(datasetId).listItems(input)');
    });

    it('keeps paid AI replay stateless and disconnected from result/provider persistence', async () => {
        const source = `${await readFile(stagedAdapter, 'utf8')}\n${await readFile(runner, 'utf8')}`;
        const imports = source.split('\n').filter(line => line.startsWith('import ')).join('\n');
        expect(source).toContain('statelessReplay: true');
        expect(source).toContain('AI_STAGE_POLICY_LATEST_VERSION');
        expect(source).not.toContain('sourceLineage.policyVersions.aiStage');
        expect(imports).not.toMatch(/supabase|provider-run|result-store|archive|cloudflare|R2/i);
    });
});
