import { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const liveSource = new URL('./replay-live-source.ts', import.meta.url);
const stagedAdapter = new URL('./replay-staged-ai-adapter.ts', import.meta.url);
const runner = new URL('./replay-runner.ts', import.meta.url);
const cli = new URL('../../../../scripts/replay-analysis-v2.ts', import.meta.url);
const libRoot = new URL('../../../', import.meta.url);
const replayCapability = new URL('../../ai/replay-stateless-capability.ts', import.meta.url);

async function productionTypescriptFiles(directory: URL): Promise<URL[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const files: URL[] = [];
    for (const entry of entries) {
        const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
        if (entry.isDirectory()) {
            files.push(...await productionTypescriptFiles(child));
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
            files.push(child);
        }
    }
    return files;
}

describe('analysis V2 replay safety contract', () => {
    it('can only GET Actor/run identity and list datasets without mutation', async () => {
        const source = await readFile(liveSource, 'utf8');
        expect(source).not.toMatch(/\.(?:start|update|delete|abort)\s*\(/);
        expect(source).toContain('client.actor(actorSlug).get()');
        expect(source).toContain('client.run(runId).get()');
        expect(source).toContain('client.dataset(datasetId).listItems(input)');
    });

    it('keeps paid AI replay stateless and disconnected from result/provider persistence', async () => {
        const adapterSource = await readFile(stagedAdapter, 'utf8');
        const source = `${adapterSource}\n${await readFile(runner, 'utf8')}`;
        const imports = source.split('\n').filter(line => line.startsWith('import ')).join('\n');
        expect(adapterSource).toContain('issueReplayStatelessCapability');
        expect(adapterSource).toContain('replayCapability');
        expect(source).not.toContain('statelessReplay: true');
        const capabilityIssuers: string[] = [];
        for (const file of await productionTypescriptFiles(libRoot)) {
            if ((await readFile(file, 'utf8')).includes('issueReplayStatelessCapability')) {
                capabilityIssuers.push(file.pathname);
            }
        }
        expect(capabilityIssuers.sort()).toEqual([
            replayCapability.pathname,
            stagedAdapter.pathname,
        ].sort());
        expect(source).toContain('replayAiStagePolicyVersion');
        expect(source).not.toContain('AI_STAGE_POLICY_LATEST_VERSION');
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
