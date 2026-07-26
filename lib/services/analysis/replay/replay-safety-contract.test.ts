import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const liveSource = new URL('./replay-live-source.ts', import.meta.url);
const stagedAdapter = new URL('./replay-staged-ai-adapter.ts', import.meta.url);
const runner = new URL('./replay-runner.ts', import.meta.url);
const cli = new URL('../../../../scripts/replay-analysis-v2.ts', import.meta.url);

describe('analysis V2 replay safety contract', () => {
    it('cannot start, mutate, abort, or delete an Apify Actor run', async () => {
        const source = await readFile(liveSource, 'utf8');
        expect(source).not.toMatch(/\.(?:actor|start|update|delete|abort)\s*\(/);
        expect(source).toContain('client.run(runId).get()');
        expect(source).toContain('client.dataset(datasetId).listItems(input)');
    });

    it('keeps paid AI replay stateless and disconnected from result/provider persistence', async () => {
        const adapterSource = await readFile(stagedAdapter, 'utf8');
        const source = `${adapterSource}\n${await readFile(runner, 'utf8')}`;
        const imports = source.split('\n').filter(line => line.startsWith('import ')).join('\n');
        expect(source).toContain('statelessReplay: true');
        expect(source).toContain('AI_STAGE_POLICY_LATEST_VERSION');
        expect(adapterSource).not.toContain('sourceLineage');
        expect(imports).not.toMatch(/supabase|provider-run|result-store|archive|cloudflare|R2/i);
    });

    it('labels capture as AI-only source evidence without Standard relabeling', async () => {
        const source = await readFile(cli, 'utf8');
        expect(source).toContain("benchmark_scope: 'ai-only-exact-replay'");
        expect(source).toContain('source_plan: descriptor.sourceLineage.selectedPlanId');
        expect(source).toContain('source_ai_policy: descriptor.sourceLineage.policyVersions.aiStage');
        expect(source).toContain('full_e2e_evidence: false');
        expect(source).not.toContain("source_plan: 'standard'");
    });
});
