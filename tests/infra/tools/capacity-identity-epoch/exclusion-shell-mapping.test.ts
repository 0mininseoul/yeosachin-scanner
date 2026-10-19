import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

    it('keeps Cloud Tasks queue and Cloud Scheduler job validators at provider grammar limits', () => {
        const queueScripts = [
            'configure-analysis-capacity-queues.sh',
            'configure-analysis-tasks-queue.sh',
            'deploy-analysis-capacity-workers.sh',
            'deploy-analysis-v2-worker.sh',
        ];
        for (const file of queueScripts) {
            expect(readFileSync(resolve(root, file), 'utf8'), file).toContain('^[A-Za-z0-9-]{1,100}$');
        }
        const schedulerScripts = [
            'capacity-identity-epoch/exclusion-supervisor.sh',
            'configure-analysis-preflight-maintenance.sh',
            'configure-analysis-v2-maintenance.sh',
            'deploy-analysis-capacity-workers.sh',
        ];
        for (const file of schedulerScripts) {
            const source = readFileSync(resolve(root, file), 'utf8');
            expect(source, file).toContain('^[A-Za-z0-9_-]+$');
            expect(source, file).toContain('-le 500');
        }
    });

    it('validates both deploy-v2 Scheduler selectors before any raw use', () => {
        const source = readFileSync(resolve(root, 'deploy-analysis-v2-worker.sh'), 'utf8');
        expect(source).toContain('^[A-Za-z0-9_-]+$');
        expect(source).toContain('${#job} -le 500');
        expect(source).toContain('validate_scheduler_job');
        expect(source).toMatch(/validate_scheduler_job\s+"\$recovery_scheduler_job"/);
        expect(source).toMatch(/validate_scheduler_job\s+"\$retention_scheduler_job"/);
    });

    it('validates maintenance selectors while the caller holds readonly selector names', () => {
        // configure-analysis-v2-maintenance.sh declares readonly recovery_job and retention_job
        // before entering the launcher; a same-named local in the supervisor aborts bash.
        const directory = mkdtempSync(join(tmpdir(), 'exclusion-shell-'));
        try {
            const caller = join(directory, 'configure-fixture-maintenance.sh');
            writeFileSync(caller, [
                'set -euo pipefail',
                'source "$1"',
                'readonly recovery_job=analysis-v2-recovery',
                'readonly retention_job=analysis-v2-preflight-retention',
                'enter() { capacity_exclusion_validate_selector_atoms paid-maintenance paid; }',
                'enter',
                'echo validated',
            ].join('\n'));
            const result = spawnSync('bash', [caller, resolve(root, 'capacity-identity-epoch/exclusion-supervisor.sh')], {
                encoding: 'utf8',
                env: {
                    ...process.env,
                    ANALYSIS_V2_TASKS_PROJECT: 'fixture-project',
                    ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE: 'fixture-service',
                    ANALYSIS_V2_TASKS_CLOUD_RUN_REGION: 'fixture-region',
                },
            });
            expect(result.stderr).toBe('');
            expect(result.stdout.trim()).toBe('validated');
            expect(result.status).toBe(0);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
