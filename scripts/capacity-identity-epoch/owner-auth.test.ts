import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    captureGoogleAccessToken,
    captureSupabaseServiceRoleKey,
    createOwnerProtectedTransports,
    loadOwnerAuthBoundary,
    parseSupabaseServiceRoleKey,
    scrubOwnerError,
    type GoogleTokenChild,
} from './owner-auth';

const PROTECTED_TOKEN = 'fixture-vercel-secret-value';
const GOOGLE_TOKEN = 'fixture-google-secret-value';

function privateFile(directory: string, name: string, value: unknown): string {
    const path = join(directory, name);
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
}

describe('owner credential boundary', () => {
    it('loads only owner-readable linked metadata and Vercel CLI credentials into memory', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-auth-'));
        const metadataPath = privateFile(directory, 'project.json', { projectId: 'linked-project', orgId: 'linked-team' });
        const credentialsPath = privateFile(directory, 'auth.json', { token: PROTECTED_TOKEN });
        const auth = await loadOwnerAuthBoundary({ linkedMetadataPath: metadataPath, credentialStorePath: credentialsPath });

        expect(auth.vercelProjectId).toBe('linked-project');
        expect(auth.vercelTeamId).toBe('linked-team');
        expect(await auth.vercelTokenProvider()).toBe(PROTECTED_TOKEN);
        expect(Object.keys(auth).sort()).toEqual(['googleTokenProvider', 'vercelProjectId', 'vercelTeamId', 'vercelTokenProvider']);
    });

    it('selects the exact current worktree project from an installed Vercel repo link', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-auth-'));
        const vercelDirectory = join(directory, '.vercel');
        const worktree = join(directory, 'packages', 'scanner');
        mkdirSync(vercelDirectory, { recursive: true });
        mkdirSync(worktree, { recursive: true });
        const metadataPath = privateFile(vercelDirectory, 'repo.json', {
            remoteName: 'origin',
            projects: [
                { id: 'other-project', name: 'other', directory: 'packages/other', orgId: 'other-team' },
                { id: 'current-project', name: 'current', directory: 'packages/scanner', orgId: 'current-team' },
            ],
        });
        const credentialsPath = privateFile(directory, 'auth.json', { token: PROTECTED_TOKEN });
        const auth = await loadOwnerAuthBoundary({ linkedMetadataPath: metadataPath, credentialStorePath: credentialsPath, cwd: worktree });

        expect(auth.vercelProjectId).toBe('current-project');
        expect(auth.vercelTeamId).toBe('current-team');
    });

    it('maps owner uid, permission, and malformed credential failures to one fixed code', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-auth-'));
        const metadataPath = privateFile(directory, 'project.json', { projectId: 'linked-project', orgId: 'linked-team' });
        const credentialsPath = privateFile(directory, 'auth.json', { token: PROTECTED_TOKEN });
        chmodSync(credentialsPath, 0o622);
        await expect(loadOwnerAuthBoundary({ linkedMetadataPath: metadataPath, credentialStorePath: credentialsPath })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');
        await expect(loadOwnerAuthBoundary({ linkedMetadataPath: metadataPath, credentialStorePath: credentialsPath, uid: -1 })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');

        const malformed = privateFile(directory, 'malformed.json', { token: '' });
        await expect(loadOwnerAuthBoundary({ linkedMetadataPath: metadataPath, credentialStorePath: malformed })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');
    });

    it('requires private mode for the Vercel credential store while allowing owner-readable metadata', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-auth-'));
        const metadataPath = privateFile(directory, 'project.json', { projectId: 'linked-project', orgId: 'linked-team' });
        chmodSync(metadataPath, 0o644);
        const credentialsPath = privateFile(directory, 'auth.json', { token: PROTECTED_TOKEN });
        chmodSync(credentialsPath, 0o644);

        await expect(loadOwnerAuthBoundary({ linkedMetadataPath: metadataPath, credentialStorePath: credentialsPath }))
            .rejects.toThrow('OWNER_AUTH_UNAVAILABLE');

        chmodSync(credentialsPath, 0o600);
        await expect(loadOwnerAuthBoundary({ linkedMetadataPath: metadataPath, credentialStorePath: credentialsPath }))
            .resolves.toBeDefined();
    });

    it('captures gcloud stdout/stderr privately and never includes protected output in fixed errors', async () => {
        const child: GoogleTokenChild = {
            stdout: { on: (_event, handler) => { handler(Buffer.from(`${GOOGLE_TOKEN}\n`)); handler(); return child.stdout; } },
            stderr: { on: (_event, handler) => { handler(Buffer.from(PROTECTED_TOKEN)); handler(); return child.stderr; } },
            once: (event, handler) => { if (event === 'close') queueMicrotask(() => handler(0, null)); return child; },
            kill: () => true,
        };
        const token = await captureGoogleAccessToken({ spawn: () => child, timeoutMs: 1_000 });
        expect(token).toBe(GOOGLE_TOKEN);

        const failed: GoogleTokenChild = {
            stdout: { on: (_event, handler) => { handler(Buffer.from(PROTECTED_TOKEN)); handler(); return failed.stdout; } },
            stderr: { on: (_event, handler) => { handler(Buffer.from(PROTECTED_TOKEN)); handler(); return failed.stderr; } },
            once: (event, handler) => { if (event === 'close') queueMicrotask(() => handler(1, null)); return failed; },
            kill: () => true,
        };
        await expect(captureGoogleAccessToken({ spawn: () => failed, timeoutMs: 1_000 })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');
        await expect(captureGoogleAccessToken({ spawn: () => failed, timeoutMs: 1_000 })).rejects.not.toThrow(PROTECTED_TOKEN);
        expect(scrubOwnerError(new Error(PROTECTED_TOKEN)).message).toBe('OWNER_AUTH_UNAVAILABLE');
    });

    it('builds authenticated Vercel, Google, and optional Supabase transports without exposing credential inputs', async () => {
        const transports = createOwnerProtectedTransports({
            vercelTokenProvider: async () => PROTECTED_TOKEN,
            googleTokenProvider: async () => GOOGLE_TOKEN,
            supabaseTokenProvider: async () => 'fixture-supabase-secret',
            supabaseHosts: new Set(['supabase.invalid']),
        });
        await expect(transports.vercel.preflight()).resolves.toBeUndefined();
        await expect(transports.google.preflight()).resolves.toBeUndefined();
        await expect(transports.supabase?.preflight()).resolves.toBeUndefined();
        expect(JSON.stringify({ transports })).not.toContain(PROTECTED_TOKEN);
        expect(JSON.stringify({ transports })).not.toContain(GOOGLE_TOKEN);
    });

    it('parses exactly one service-role key from the linked Supabase CLI response', () => {
        expect(parseSupabaseServiceRoleKey(JSON.stringify([
            {
                name: 'anon',
                api_key: 'fixture-anon-key',
                id: 'anon',
                type: 'legacy',
                hash: 'fixture-anon-hash',
                prefix: 'anon',
                description: 'Legacy anon API key',
            },
            {
                name: 'service_role',
                api_key: 'fixture-service-role-key',
                id: 'service_role',
                type: 'legacy',
                hash: 'fixture-service-role-hash',
                prefix: 'service',
                description: 'Legacy service role API key',
            },
            {
                id: 'fixture-publishable-id',
                name: 'default',
                type: 'publishable',
                api_key: 'fixture-publishable-key',
                description: null,
                secret_jwt_template: null,
                hash: 'fixture-publishable-hash',
                prefix: 'sb_publishable',
                inserted_at: '2000-01-01T00:00:00Z',
                updated_at: '2000-01-01T00:00:00Z',
            },
            {
                id: 'fixture-secret-id',
                name: 'default',
                type: 'secret',
                api_key: null,
                description: null,
                secret_jwt_template: { role: 'service_role' },
                hash: 'fixture-secret-hash',
                prefix: 'sb_secret',
                inserted_at: '2000-01-01T00:00:00Z',
                updated_at: '2000-01-01T00:00:00Z',
            },
        ]))).toBe('fixture-service-role-key');
        expect(() => parseSupabaseServiceRoleKey(JSON.stringify([
            {
                name: 'service_role',
                api_key: 'first-key',
                id: 'service_role',
                type: 'legacy',
                hash: 'fixture-first-hash',
                prefix: 'service',
                description: null,
            },
            {
                name: 'service_role',
                api_key: 'second-key',
                id: 'service_role-2',
                type: 'legacy',
                hash: 'fixture-second-hash',
                prefix: 'service',
                description: null,
            },
        ]))).toThrow('OWNER_AUTH_UNAVAILABLE');
        expect(() => parseSupabaseServiceRoleKey(JSON.stringify([
            {
                name: 'service_role',
                api_key: 'key',
                id: 'service_role',
                type: 'legacy',
                hash: 'fixture-hash',
                prefix: 'service',
                description: null,
                extra: 'unexpected',
            },
        ]))).toThrow('OWNER_AUTH_UNAVAILABLE');
    });

    it('captures the linked Supabase CLI privately with an origin-bound project ref', async () => {
        const primary = mkdtempSync(join(tmpdir(), 'owner-auth-primary-'));
        const implementation = mkdtempSync(join(tmpdir(), 'owner-auth-implementation-'));
        mkdirSync(join(primary, 'supabase', '.temp'), { recursive: true });
        const projectRefPath = join(primary, 'supabase', '.temp', 'project-ref');
        writeFileSync(projectRefPath, 'abcdefghijklmnopqrst\n', { mode: 0o600 });
        chmodSync(projectRefPath, 0o600);
        const child: GoogleTokenChild = {
            stdout: { on: (_event, handler) => {
                handler(Buffer.from(JSON.stringify([{
                    name: 'service_role',
                    api_key: 'fixture-service-role-key',
                    id: 'service_role',
                    type: 'legacy',
                    hash: 'fixture-service-role-hash',
                    prefix: 'service',
                    description: null,
                }])));
                handler();
                return child.stdout;
            } },
            stderr: { on: (_event, handler) => { handler(Buffer.from('private-cli-diagnostic')); handler(); return child.stderr; } },
            once: (event, handler) => { if (event === 'close') queueMicrotask(() => handler(0, null)); return child; },
            kill: () => true,
        };
        let capturedArgs: readonly string[] = [];
        let capturedCommand: string | undefined;
        let capturedOptions: Record<string, unknown> | undefined;
        const key = await captureSupabaseServiceRoleKey({
            origin: 'https://abcdefghijklmnopqrst.supabase.co/',
            workdir: primary,
            command: join(implementation, 'node_modules', '.bin', 'supabase'),
            spawn: (command, args, options) => {
                capturedCommand = command;
                capturedArgs = args;
                capturedOptions = options as Record<string, unknown>;
                return child;
            },
            timeoutMs: 1_000,
        });
        expect(key).toBe('fixture-service-role-key');
        expect(capturedCommand).toBe(join(implementation, 'node_modules', '.bin', 'supabase'));
        expect(capturedCommand).not.toBe(join(primary, 'node_modules', '.bin', 'supabase'));
        expect(capturedArgs).toEqual(['--workdir', primary, 'projects', 'api-keys', '--output', 'json']);
        expect(capturedOptions).toMatchObject({ cwd: primary, shell: false, env: { LANG: 'C', NODE_ENV: 'production' } });
        expect(capturedOptions?.env).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
    });

    it('rejects a Supabase origin that cannot produce the exact CLI project ref', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-auth-'));
        mkdirSync(join(directory, 'supabase', '.temp'), { recursive: true });
        writeFileSync(join(directory, 'supabase', '.temp', 'project-ref'), 'abcdefghijklmnopqrst\n', { mode: 0o600 });
        await expect(captureSupabaseServiceRoleKey({
            origin: 'https://wrong.example/',
            workdir: directory,
            command: 'supabase',
            spawn: () => { throw new Error('must not spawn'); },
        })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');
    });

    it('rejects a linked project ref that differs from the configured origin before spawning', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-auth-'));
        mkdirSync(join(directory, 'supabase', '.temp'), { recursive: true });
        writeFileSync(join(directory, 'supabase', '.temp', 'project-ref'), 'zyxwvutsrqponmlkjihg\n', { mode: 0o600 });
        let spawned = false;
        await expect(captureSupabaseServiceRoleKey({
            origin: 'https://abcdefghijklmnopqrst.supabase.co/',
            workdir: directory,
            command: 'supabase',
            spawn: () => { spawned = true; throw new Error('must not spawn'); },
        })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');
        expect(spawned).toBe(false);
    });

    it('caps Supabase CLI output and bounds a child that never closes', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'owner-auth-'));
        mkdirSync(join(directory, 'supabase', '.temp'), { recursive: true });
        writeFileSync(join(directory, 'supabase', '.temp', 'project-ref'), 'abcdefghijklmnopqrst\n', { mode: 0o600 });
        let killed = false;
        const oversized: GoogleTokenChild = {
            stdout: { on: (event, handler) => {
                if (event === 'data') handler(Buffer.alloc(64 * 1024 + 1, 'x'));
                return oversized.stdout;
            } },
            stderr: { on: () => oversized.stderr },
            once: (event, handler) => { if (event === 'close') queueMicrotask(() => handler(0, null)); return oversized; },
            kill: () => { killed = true; return true; },
        };
        await expect(captureSupabaseServiceRoleKey({
            origin: 'https://abcdefghijklmnopqrst.supabase.co/',
            workdir: directory,
            command: 'supabase',
            spawn: () => oversized,
            timeoutMs: 1_000,
        })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');
        expect(killed).toBe(true);

        const hanging: GoogleTokenChild = {
            stdout: { on: () => hanging.stdout },
            stderr: { on: () => hanging.stderr },
            once: () => hanging,
            kill: () => { killed = true; return true; },
        };
        await expect(captureSupabaseServiceRoleKey({
            origin: 'https://abcdefghijklmnopqrst.supabase.co/',
            workdir: directory,
            command: 'supabase',
            spawn: () => hanging,
            timeoutMs: 10,
        })).rejects.toThrow('OWNER_AUTH_UNAVAILABLE');
        expect(killed).toBe(true);
    });
});
