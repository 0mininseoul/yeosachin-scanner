import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLocalSupabaseCliPathForOwner, resolvePrimaryRepositoryRootForOwner, resolveRoleSelectorFromCloudRun } from '../../../../scripts/capacity-identity-epoch/owner-production';

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

function installSupabaseCliFixture(worktree: string, options: Readonly<{ version?: string; bin?: string } & { targetMode?: number }> = {}): void {
    const packageDirectory = join(worktree, 'node_modules', 'supabase');
    const binDirectory = join(worktree, 'node_modules', '.bin');
    const distributionDirectory = join(packageDirectory, 'dist');
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(distributionDirectory, { recursive: true });
    writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({
        name: 'supabase',
        version: options.version ?? '2.102.0',
        bin: { supabase: options.bin ?? 'dist/supabase.js' },
    }));
    const target = join(distributionDirectory, 'supabase.js');
    writeFileSync(target, '#!/usr/bin/env node\n');
    chmodSync(target, options.targetMode ?? 0o755);
    symlinkSync('../supabase/dist/supabase.js', join(binDirectory, 'supabase'));
}

describe('owner production queue selector boundary', () => {
    it('resolves the fixed canonical Supabase workdir from the Git common repository', () => {
        const container = mkdtempSync(join(tmpdir(), 'owner-production-git-'));
        const primary = join(container, 'primary');
        const linked = join(container, 'linked');
        mkdirSync(primary);
        mkdirSync(join(primary, '.worktrees'));
        runGit(primary, ['init', '--quiet']);
        runGit(primary, ['config', 'user.email', 'fixture@example.invalid']);
        runGit(primary, ['config', 'user.name', 'Fixture']);
        writeFileSync(join(primary, 'README.md'), 'fixture\n');
        runGit(primary, ['add', 'README.md']);
        runGit(primary, ['commit', '--quiet', '-m', 'fixture']);
        const canonical = join(primary, '.worktrees', 'final-main-20260725');
        runGit(primary, ['worktree', 'add', '--quiet', '--detach', canonical, 'HEAD']);
        runGit(primary, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
        installSupabaseCliFixture(linked);

        expect(resolvePrimaryRepositoryRootForOwner(linked)).toBe(realpathSync(canonical));
        expect(resolveLocalSupabaseCliPathForOwner(linked)).toBe(join(linked, 'node_modules', '.bin', 'supabase'));
        expect(resolveLocalSupabaseCliPathForOwner(linked)).not.toBe(join(primary, 'node_modules', '.bin', 'supabase'));
    });

    it('requires the owner-installed pinned package and its exact executable link', () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-production-cli-'));
        installSupabaseCliFixture(directory);
        expect(resolveLocalSupabaseCliPathForOwner(directory)).toBe(join(directory, 'node_modules', '.bin', 'supabase'));

        chmodSync(join(directory, 'node_modules'), 0o775);
        expect(() => resolveLocalSupabaseCliPathForOwner(directory)).toThrow('OWNER_AUTH_UNAVAILABLE');
        chmodSync(join(directory, 'node_modules'), 0o755);

        const wrongVersion = mkdtempSync(join(tmpdir(), 'owner-production-cli-'));
        installSupabaseCliFixture(wrongVersion, { version: '2.101.0' });
        expect(() => resolveLocalSupabaseCliPathForOwner(wrongVersion)).toThrow('OWNER_AUTH_UNAVAILABLE');

        const nonExecutable = mkdtempSync(join(tmpdir(), 'owner-production-cli-'));
        installSupabaseCliFixture(nonExecutable, { targetMode: 0o644 });
        expect(() => resolveLocalSupabaseCliPathForOwner(nonExecutable)).toThrow('OWNER_AUTH_UNAVAILABLE');
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
