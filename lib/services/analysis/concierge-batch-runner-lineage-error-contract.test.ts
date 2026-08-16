import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runner = readFileSync(
    new URL('../../../scripts/run-concierge-batch.ts', import.meta.url),
    'utf8',
);

describe('concierge batch lineage-repair compatibility', () => {
    it('accepts the two observed terminal V2 failure codes in frozen snapshots', () => {
        expect(runner).toContain("'ANALYSIS_V2_JOB_HANDLER_FAILED'");
        expect(runner).toContain("'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'");
    });

    it('reads the RPC-only provider artifact ledger instead of bypassing its ACL', () => {
        expect(runner).toMatch(/rpc\(\s*'list_concierge_batch_target_profile_artifacts'/);
        expect(runner).not.toContain(".from('analysis_preflight_provider_runs')");
    });
});
