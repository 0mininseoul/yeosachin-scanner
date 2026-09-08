import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve('scripts');
const ordinaryScripts = [
    ['configure-analysis-capacity-queues.sh', 'capacity-queue'],
    ['configure-analysis-tasks-queue.sh', 'capacity-queue'],
    ['configure-analysis-v2-tasks-queue.sh', 'capacity-queue'],
    ['configure-preflight-tasks-queue.sh', 'capacity-queue'],
    ['configure-analysis-preflight-maintenance.sh', 'preflight-maintenance'],
    ['configure-analysis-v2-maintenance.sh', 'paid-maintenance'],
    ['deploy-analysis-capacity-workers.sh', 'role-deployer'],
] as const;

describe('ordinary identity-epoch shell mappings', () => {
    it('preserves all original argv when entering the fixed low-FD launcher', () => {
        for (const [file, entryPoint] of ordinaryScripts) {
            const source = readFileSync(resolve(root, file), 'utf8');
            expect(source, file).toContain('original_args=("$@")');
            expect(source, file).toContain(`capacity_exclusion_start ${entryPoint}`);
            expect(source, file).toContain('"${original_args[@]}"');
        }
    });

    it('does not require a role for direct generic task-queue mode', () => {
        const source = readFileSync(resolve(root, 'configure-analysis-tasks-queue.sh'), 'utf8');
        expect(source).toContain('if [[ -n "${ANALYSIS_CAPACITY_ROLE:-}" ]]; then');
        expect(source).toContain('if [[ "$mode" == "apply" && ("${ANALYSIS_CAPACITY_ROLE:-}" == "preflight" || "${ANALYSIS_CAPACITY_ROLE:-}" == "paid") ]]; then');
    });

    it('keeps the bridge on fixed descriptors and direct node imports', () => {
        const source = readFileSync(resolve(root, 'capacity-identity-epoch/exclusion-supervisor.sh'), 'utf8');
        expect(source).toContain('CAPACITY_EXCLUSION_READ_FD=4');
        expect(source).toContain('CAPACITY_EXCLUSION_WRITE_FD=5');
        expect(source).toContain('node --import tsx');
        expect(source).not.toContain('npx tsx');
    });

    it('forwards only child argv after removing the entry-point and role selectors', () => {
        const source = readFileSync(resolve(root, 'capacity-identity-epoch/exclusion-supervisor.sh'), 'utf8');
        expect(source).toMatch(/capacity_exclusion_start\(\)[\s\S]*?local role="\$2"[\s\S]*?shift 2[\s\S]*?for argument in "\$@"/);
    });
});
