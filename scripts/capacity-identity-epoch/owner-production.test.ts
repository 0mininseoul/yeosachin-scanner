import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePrimaryRepositoryRootForOwner, resolveRoleSelectorFromCloudRun } from './owner-production';

function runGit(cwd: string, args: readonly string[]): void {
    execFileSync('git', [...args], {
        cwd,
        env: {
            PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
            HOME: '/tmp',
            LANG: 'C',
            LC_ALL: 'C',
            NODE_ENV: 'test',
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_SYSTEM: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_OPTIONAL_LOCKS: '0',
            GIT_TERMINAL_PROMPT: '0',
        },
        shell: false,
        stdio: ['ignore', 'ignore', 'ignore'],
    });
}

describe('owner production queue selector boundary', () => {
    it('resolves the Supabase workdir from the Git common primary repository', () => {
        const container = mkdtempSync(join(tmpdir(), 'owner-production-git-'));
        const primary = join(container, 'primary');
        const linked = join(container, 'linked');
        mkdirSync(primary);
        runGit(primary, ['init', '--quiet']);
        runGit(primary, ['config', 'user.email', 'fixture@example.invalid']);
        runGit(primary, ['config', 'user.name', 'Fixture']);
        writeFileSync(join(primary, 'README.md'), 'fixture\n');
        runGit(primary, ['add', 'README.md']);
        runGit(primary, ['commit', '--quiet', '-m', 'fixture']);
        runGit(primary, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);

        expect(resolvePrimaryRepositoryRootForOwner(linked)).toBe(realpathSync(primary));
    });

    it('derives a missing queue only from the exact bound Cloud Run service environment', () => {
        expect(resolveRoleSelectorFromCloudRun({
            role: 'paid',
            selector: {
                project: 'fixture-project',
                location: 'fixture-location',
                cloudRunRegion: 'fixture-region',
                service: 'fixture-service',
                queue: undefined,
                recoveryJob: 'fixture-recovery',
                maintenanceLocation: 'fixture-maintenance',
            },
            runtime: {
                resource: 'projects/fixture-project/locations/fixture-region/services/fixture-service',
                project: 'fixture-project',
                location: 'fixture-region',
                service: 'fixture-service',
                environment: {
                    ANALYSIS_V2_TASKS_PROJECT: 'fixture-project',
                    ANALYSIS_V2_TASKS_LOCATION: 'fixture-location',
                    ANALYSIS_V2_TASKS_QUEUE: 'derived-queue',
                },
            },
        }).queue).toBe('derived-queue');
    });

    it('rejects a queue disagreement between Vercel metadata and Cloud Run', () => {
        expect(() => resolveRoleSelectorFromCloudRun({
            role: 'paid',
            selector: {
                project: 'fixture-project',
                location: 'fixture-location',
                cloudRunRegion: 'fixture-region',
                service: 'fixture-service',
                queue: 'vercel-queue',
                recoveryJob: 'fixture-recovery',
                maintenanceLocation: 'fixture-maintenance',
            },
            runtime: {
                resource: 'projects/fixture-project/locations/fixture-region/services/fixture-service',
                project: 'fixture-project',
                location: 'fixture-region',
                service: 'fixture-service',
                environment: {
                    ANALYSIS_V2_TASKS_PROJECT: 'fixture-project',
                    ANALYSIS_V2_TASKS_LOCATION: 'fixture-location',
                    ANALYSIS_V2_TASKS_QUEUE: 'cloud-run-queue',
                },
            },
        })).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('does not derive a queue when the required preflight selector is missing', () => {
        expect(() => resolveRoleSelectorFromCloudRun({
            role: 'preflight',
            selector: {
                project: 'fixture-project',
                location: 'fixture-location',
                cloudRunRegion: 'fixture-region',
                service: 'fixture-service',
                queue: undefined,
                recoveryJob: 'fixture-recovery',
                maintenanceLocation: 'fixture-maintenance',
            },
            runtime: {
                resource: 'projects/fixture-project/locations/fixture-region/services/fixture-service',
                project: 'fixture-project',
                location: 'fixture-region',
                service: 'fixture-service',
                environment: {
                    PREFLIGHT_TASKS_PROJECT: 'fixture-project',
                    PREFLIGHT_TASKS_LOCATION: 'fixture-location',
                    PREFLIGHT_TASKS_QUEUE: 'preflight-queue',
                },
            },
        })).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects Cloud Run observations from another project, region, or service', () => {
        expect(() => resolveRoleSelectorFromCloudRun({
            role: 'paid',
            selector: {
                project: 'fixture-project',
                location: 'fixture-location',
                cloudRunRegion: 'fixture-region',
                service: 'fixture-service',
                recoveryJob: 'fixture-recovery',
                maintenanceLocation: 'fixture-maintenance',
            },
            runtime: {
                resource: 'projects/other-project/locations/fixture-region/services/fixture-service',
                project: 'other-project',
                location: 'fixture-region',
                service: 'fixture-service',
                environment: {
                    ANALYSIS_V2_TASKS_PROJECT: 'fixture-project',
                    ANALYSIS_V2_TASKS_LOCATION: 'fixture-location',
                    ANALYSIS_V2_TASKS_QUEUE: 'cloud-run-queue',
                },
            },
        })).toThrow('CAPABILITY_BINDING_MISMATCH');
    });
});
