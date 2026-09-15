import { createSchedulerPauseProvenanceReader } from '../../../../scripts/capacity-identity-epoch/scheduler-pause-evidence';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    assertCloudRunTargetOrigin,
    assertOwnerDesiredDeployment,
    mergeOwnerResourceSelectorOverrides,
    parseOwnerDesiredDeploymentSelector,
    parseOwnerResourceSelectorOverrides,
    parseVercelDeploymentDetail,
    parseVercelDeploymentInventory,
    readVercelDeployment,
    readVercelDeployments,
    identitySlots,
    resolveLocalSupabaseCliPathForOwner,
    resolvePrimaryRepositoryRootForOwner,
    resolveRoleSelectorFromCloudRun,
    resolveOwnerBuildForImage,
    selectDeployment,
} from '../../../../scripts/capacity-identity-epoch/owner-production';
import {
    AuthenticatedProtectedTransport,
    type ProtectedHttpRequest,
    type ProtectedHttpResponse,
    type ProtectedTransport,
} from '../../../../scripts/capacity-identity-epoch/platform';
import { enqueuerIdentityFingerprint } from '../../../../lib/services/analysis/legacy-analysis-public-readiness';

class FakeVercelTransport implements ProtectedTransport {
    readonly requests: ProtectedHttpRequest[] = [];

    constructor(private readonly responder: (request: ProtectedHttpRequest) => ProtectedHttpResponse | Promise<ProtectedHttpResponse>) {}

    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> {
        this.requests.push(request);
        return this.responder(request);
    }
}

function vercelResponse(request: ProtectedHttpRequest, value: unknown): ProtectedHttpResponse {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), url: request.url };
}

function authenticatedVercel(fake: ProtectedTransport): AuthenticatedProtectedTransport {
    return new AuthenticatedProtectedTransport({ transport: fake, tokenProvider: async () => 'fixture-token', timeoutMs: 2_000 });
}

describe('owner Vercel deployment discovery', () => {
    const projectId = 'project-fixture';
    const teamId = 'team-fixture';
    const oldId = 'dpl-old';
    const desiredId = 'dpl-desired';
    const sourceSha = 'a'.repeat(40);

    it('parses v6 rows as inventory without requiring detail-only Git fields', () => {
        expect(parseVercelDeploymentInventory({ uid: desiredId, readyState: 'READY', createdAt: 200 })).toEqual({
            id: desiredId, readyState: 'READY', createdAt: 200,
        });
    });

    it('fully paginates inventory and fetches native SHA only for the selected detail', async () => {
        const fake = new FakeVercelTransport(request => {
            const url = new URL(request.url);
            if (url.pathname === '/v6/deployments') {
                if (url.searchParams.get('until') === null) {
                    return vercelResponse(request, { deployments: [
                        { uid: oldId, readyState: 'READY', createdAt: 100 },
                        { uid: 'dpl-not-selected', readyState: 'READY', createdAt: 200 },
                    ], pagination: { next: 'page-2' } });
                }
                return vercelResponse(request, { deployments: [{ uid: desiredId, readyState: 'READY', createdAt: 300 }], pagination: {} });
            }
            if (url.pathname === `/v13/deployments/${desiredId}`) {
                return vercelResponse(request, {
                    id: desiredId, readyState: 'READY', createdAt: 300, url: 'desired-fixture.vercel.app',
                    project: { id: projectId }, team: { id: teamId }, gitSource: { sha: sourceSha },
                });
            }
            throw new Error(`unexpected fixture request ${request.method} ${request.url}`);
        });
        const transport = authenticatedVercel(fake);
        const inventory = await readVercelDeployments(transport, projectId, teamId);
        const selected = selectDeployment(inventory, oldId);
        const detail = await readVercelDeployment(transport, projectId, teamId, selected.id);

        expect(selected).toEqual({ id: desiredId, readyState: 'READY', createdAt: 300 });
        expect(detail).toEqual({ id: desiredId, readyState: 'READY', createdAt: 300, origin: 'https://desired-fixture.vercel.app', sourceSha });
        expect(fake.requests.filter(request => request.url.includes('/v13/deployments/'))).toHaveLength(1);
        expect(fake.requests.some(request => request.url.includes('dpl-not-selected'))).toBe(false);
        expect(new URL(fake.requests[0]!.url).searchParams.get('target')).toBe('production');
        expect(new URL(fake.requests[1]!.url).searchParams.get('until')).toBe('page-2');
    });

    it('requires exact project/team and native detail Git SHA without metadata fallback', () => {
        const detail = { id: desiredId, readyState: 'READY', url: 'desired-fixture.vercel.app', project: { id: projectId }, team: { id: teamId } };
        expect(() => parseVercelDeploymentDetail({ ...detail, gitSource: { sha: sourceSha }, project: { id: 'other-project' } }, projectId, teamId, desiredId)).toThrow('ADAPTER_RESPONSE_INVALID');
        expect(() => parseVercelDeploymentDetail({ ...detail, meta: { githubCommitSha: sourceSha } }, projectId, teamId, desiredId)).toThrow('ADAPTER_RESPONSE_INVALID');
    });

    it('binds an explicit desired selector to the exact native deployment SHA', () => {
        const detail = parseVercelDeploymentDetail({
            id: desiredId, readyState: 'READY', createdAt: 300, url: 'desired-fixture.vercel.app',
            project: { id: projectId }, team: { id: teamId }, gitSource: { sha: sourceSha },
        }, projectId, teamId, desiredId);
        const expected = parseOwnerDesiredDeploymentSelector({ id: desiredId, sourceSha });
        expect(assertOwnerDesiredDeployment(expected!, detail)).toEqual(detail);
        expect(() => assertOwnerDesiredDeployment({ id: desiredId, sourceSha: 'b'.repeat(40) }, detail)).toThrow('SOURCE_INVALID');
    });
});

describe('owner in-memory selector boundaries', () => {
    it('allows existing non-Supabase keys and fills only unreadable values', () => {
        const production = { values: { VERCEL_PRODUCER_ALIAS: 'old-fixture.example' } };
        expect(mergeOwnerResourceSelectorOverrides(production, {
            VERCEL_PRODUCER_ALIAS: 'old-fixture.example',
            PREFLIGHT_TASKS_QUEUE: 'fixture-queue',
        })).toEqual({ VERCEL_PRODUCER_ALIAS: 'old-fixture.example', PREFLIGHT_TASKS_QUEUE: 'fixture-queue' });
    });

    it('rejects unknown, credential and conflicting selector overrides', () => {
        for (const value of [{ UNKNOWN_SELECTOR: 'fixture' }, { SUPABASE_SERVICE_ROLE_KEY: 'fixture' }, { NEXT_PUBLIC_SUPABASE_ANON_KEY: 'fixture' }]) {
            expect(() => parseOwnerResourceSelectorOverrides(value)).toThrow('ADAPTER_REQUEST_INVALID');
        }
        expect(() => mergeOwnerResourceSelectorOverrides(
            { values: { VERCEL_PRODUCER_ALIAS: 'old-fixture.example' } },
            { VERCEL_PRODUCER_ALIAS: 'different-fixture.example' },
        )).toThrow('CAPABILITY_BINDING_MISMATCH');
    });
});

describe('owner runtime identity binding', () => {
    it('accepts Vercel-only enqueuer identities when both old runtimes omit the key', () => {
        const project = 'fixture-project';
        const identityFor = (name: string) => ({ identity: `${name}@${project}.iam.gserviceaccount.com`, project });
        const selector = {
            project, location: 'fixture-location', cloudRunRegion: 'fixture-region', service: 'fixture-service',
            queue: 'fixture-queue', recoveryJob: 'fixture-recovery', maintenanceLocation: 'fixture-maintenance',
        };
        for (const role of ['preflight', 'paid'] as const) {
            const enqueuerKey = role === 'preflight'
                ? 'PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL'
                : 'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL';
            const slots = identitySlots(
                role,
                { identity: identityFor(`${role}-runtime`), environment: {} } as Parameters<typeof identitySlots>[1],
                { target: { callerIdentity: identityFor(`${role}-caller`) } } as Parameters<typeof identitySlots>[2],
                { target: { identity: identityFor(`${role}-maintenance`) } } as Parameters<typeof identitySlots>[3],
                selector,
                { [enqueuerKey]: `${role}-enqueuer@${project}.iam.gserviceaccount.com` },
            );
            expect(slots[`${role}.enqueuer`]).toEqual(identityFor(`${role}-enqueuer`));
            const callerKey = role === 'preflight' ? 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL' : 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL';
            const runtime = { identity: identityFor(`${role}-runtime`), environment: { [callerKey]: identityFor(`${role}-caller`).identity } } as Parameters<typeof identitySlots>[1];
            const queue = { target: null, httpTargetPresent: false } as Parameters<typeof identitySlots>[2];
            const scheduler = { target: { identity: identityFor(`${role}-maintenance`) } } as Parameters<typeof identitySlots>[3];
            const env = { [enqueuerKey]: identityFor(`${role}-enqueuer`).identity, [callerKey]: identityFor(`${role}-caller`).identity };
            expect(identitySlots(role, runtime, queue, scheduler, selector, env)[`${role}.task-caller`]).toEqual(identityFor(`${role}-caller`));
            expect(() => identitySlots(role, runtime, { ...queue, httpTargetPresent: true }, scheduler, selector, env)).toThrow('RESOURCE_INVALID');
            expect(identitySlots(role, runtime, queue, scheduler, selector, { ...env, [callerKey]: identityFor(`${role}-other`).identity })[`${role}.task-caller`]).toEqual(identityFor(`${role}-caller`));

            expect(() => identitySlots(
                role,
                { identity: identityFor(`${role}-runtime`), environment: { [enqueuerKey]: `${role}-other@${project}.iam.gserviceaccount.com` } } as Parameters<typeof identitySlots>[1],
                { target: { callerIdentity: identityFor(`${role}-caller`) } } as Parameters<typeof identitySlots>[2],
                { target: { identity: identityFor(`${role}-maintenance`) } } as Parameters<typeof identitySlots>[3],
                selector,
                { [enqueuerKey]: `${role}-enqueuer@${project}.iam.gserviceaccount.com` },
            )).toThrow('CAPABILITY_BINDING_MISMATCH');
        }
    });

    it('uses old alias readiness hash to select an old enqueuer across project-env divergence', () => {
        const project = 'fixture-project';
        const identityFor = (name: string) => ({ identity: `${name}@${project}.iam.gserviceaccount.com`, project });
        const role = 'paid' as const;
        const enqueuerKey = 'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL';
        const callerKey = 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL';
        const oldEnqueuer = `${role}-enqueuer-old@${project}.iam.gserviceaccount.com`;
        const desiredEnqueuer = `${role}-enqueuer-desired@${project}.iam.gserviceaccount.com`;
        const selector = {
            project, location: 'fixture-location', cloudRunRegion: 'fixture-region', service: 'fixture-service',
            queue: 'fixture-queue', recoveryJob: 'fixture-recovery', maintenanceLocation: 'fixture-maintenance',
        };
        const queue = { target: { callerIdentity: { identity: oldEnqueuer, project } } } as Parameters<typeof identitySlots>[2];
        const scheduler = { target: { identity: identityFor(`${role}-maintenance`) } } as Parameters<typeof identitySlots>[3];
        const env = { [enqueuerKey]: desiredEnqueuer, [callerKey]: `${role}-caller-desired@${project}.iam.gserviceaccount.com` };
        const oldHash = enqueuerIdentityFingerprint(role, oldEnqueuer);
        const slots = identitySlots(
            role,
            { identity: identityFor(`${role}-runtime`), environment: {} } as Parameters<typeof identitySlots>[1],
            queue,
            scheduler,
            selector,
            env,
            oldHash,
        );
        expect(slots[`${role}.enqueuer`]).toEqual({ identity: oldEnqueuer, project });
        expect(slots[`${role}.task-caller`]).toEqual({ identity: oldEnqueuer, project });
        expect(() => identitySlots(
            role,
            { identity: identityFor(`${role}-runtime`), environment: {} } as Parameters<typeof identitySlots>[1],
            queue,
            scheduler,
            selector,
            env,
            enqueuerIdentityFingerprint(role, 'unrelated@fixture-project.iam.gserviceaccount.com'),
        )).toThrow('CAPABILITY_BINDING_MISMATCH');
        expect(() => identitySlots(
            role,
            { identity: identityFor(`${role}-runtime`), environment: { [enqueuerKey]: oldEnqueuer } } as unknown as Parameters<typeof identitySlots>[1],
            { target: { callerIdentity: identityFor(`${role}-caller`) } } as Parameters<typeof identitySlots>[2],
            scheduler,
            selector,
            env,
        )).toThrow('CAPABILITY_BINDING_MISMATCH');
    });
});

describe('owner Cloud Run target-origin binding', () => {
    const canonical = 'https://worker-hash-a.run.app';
    const alternate = 'https://worker-service-1234.asia-northeast3.run.app';
    const runtime = { url: canonical } as Parameters<typeof assertCloudRunTargetOrigin>[0];

    it('accepts a provider-issued alternate service URL', () => {
        expect(() => assertCloudRunTargetOrigin(runtime, `${alternate}/api/analysis/v2/worker`, [canonical, alternate])).not.toThrow();
    });

    it('rejects an unrelated target origin', () => {
        expect(() => assertCloudRunTargetOrigin(runtime, 'https://unrelated.example.invalid/api/analysis/v2/worker', [canonical, alternate])).toThrow('RESOURCE_INVALID');
    });
});

describe('owner uploaded build discovery', () => {
    const project = 'fixture-project';
    const sha = 'a'.repeat(40);
    const image = `region-docker.pkg.dev/${project}/workers/worker@sha256:${'b'.repeat(64)}`;
    const source = { bucket: 'fixture-source-bucket', object: 'uploads/source.zip', generation: '1234567890123456' };
    const context = `${source.bucket}/${source.object}#${source.generation}`;
    const raw = {
        status: 'SUCCESS',
        serviceAccount: `projects/${project}/serviceAccounts/builder@${project}.iam.gserviceaccount.com`,
        substitutions: { _PUBLIC_BUILD_INPUT: 'fixture', _GOOGLE_TPC_HOSTNAME: '' },
        sourceProvenance: { resolvedStorageSource: source },
    };
    const proof = { reviewedSha: sha, archiveSha256: 'c'.repeat(64), sourceContext: context,
        sourceBucket: source.bucket, sourceObject: source.object, sourceGeneration: source.generation };

    it('selects the exact image before verifying its generation-pinned archive', async () => {
        const verify = vi.fn().mockResolvedValue(proof);
        const result = await resolveOwnerBuildForImage([
            { raw, images: [image.replace('worker@', 'unrelated@')] }, { raw, images: [image] },
        ], sha, image, project, verify);
        expect(verify).toHaveBeenCalledExactlyOnceWith({ source, reviewedSha: sha });
        expect(result.input).toEqual({ identity: { project, identity: `builder@${project}.iam.gserviceaccount.com` },
            sourceSha: sha, sourceContext: context, buildArguments: { PUBLIC_BUILD_INPUT: 'fixture', GOOGLE_TPC_HOSTNAME: '' } });
    });

    it('preserves empty substitutions but rejects non-string, oversized and control values', async () => {
        const verify = vi.fn().mockResolvedValue(proof);
        for (const value of [null, 0, 'x'.repeat(2049), 'bad\nvalue']) {
            await expect(resolveOwnerBuildForImage([{ raw: { ...raw, substitutions: { _INPUT: value } }, images: [image] }],
                sha, image, project, verify)).rejects.toThrow('SOURCE_INVALID');
        }
        expect(verify).not.toHaveBeenCalled();
    });

    it('rejects ambiguous images and foreign build identities before downloading sources', async () => {
        const verify = vi.fn().mockResolvedValue(proof);
        const candidate = { raw, images: [image] };
        await expect(resolveOwnerBuildForImage([candidate, candidate], sha, image, project, verify)).rejects.toThrow('DISCOVERY_AMBIGUOUS');
        await expect(resolveOwnerBuildForImage([{ ...candidate, raw: { ...raw,
            serviceAccount: 'projects/foreign-project/serviceAccounts/builder@foreign-project.iam.gserviceaccount.com' } }], sha, image, project, verify)).rejects.toThrow('PROJECT_MISMATCH');
        expect(verify).not.toHaveBeenCalled();
    });

    it('never substitutes a generation, label or mismatched archive proof for the reviewed commit', async () => {
        const candidate = { raw: { ...raw, tags: [sha] }, images: [image] };
        for (const value of [null, { ...proof, reviewedSha: 'd'.repeat(40) }, { ...proof, sourceGeneration: '999' }]) {
            await expect(resolveOwnerBuildForImage([candidate], sha, image, project, vi.fn().mockResolvedValue(value))).rejects.toThrow('SOURCE_INVALID');
        }
    });
});

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


describe('owner recovery pause audit', () => {
    it('follows empty pages and binds a successful pause to the exact recovery job', async () => {
        const project = 'fixture-project';
        const resources = ['preflight', 'paid'].map(role => `projects/${project}/locations/asia-northeast3/jobs/${role}`);
        const now = Date.parse('2026-09-16T00:00:00Z');
        const pause = new Date(now - 86_400_000).toISOString();
        let calls = 0;
        let failed = false;
        const transport = new AuthenticatedProtectedTransport({ tokenProvider: async () => 'fixture-token', transport: {
            request: async request => {
                calls += 1;
                const body = JSON.parse(request.body!);
                expect(body.filter).toContain(resources[0]);
                const value = body.pageToken === undefined ? { nextPageToken: 'next' } : { entries: [{
                    timestamp: pause, protoPayload: { methodName: 'google.cloud.scheduler.v1.CloudScheduler.PauseJob',
                        resourceName: resources[0], ...(failed ? { status: { code: 7 } } : {}) },
                    operation: { last: true },
                }] };
                return { status: 200, body: JSON.stringify(value), headers: {}, url: request.url };
            },
        } });
        const read = createSchedulerPauseProvenanceReader({ transport, project, resources, now: () => now });
        const input = { project, resource: resources[0]!, location: 'asia-northeast3' };
        const proof = await read(input);
        expect(proof.pauseEpochMs).toBe(Date.parse(pause));
        expect(calls).toBe(2);
        failed = true;
        await expect(read(input)).rejects.toThrow('EVIDENCE_UNAVAILABLE');
        await expect(read({ ...input, resource: resources[0] + '-unreviewed' })).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        await expect(read({ ...input, signal: AbortSignal.abort() })).rejects.toThrow('ADAPTER_TIMEOUT');
    });
});
