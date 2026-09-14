import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    captureGoogleAccessToken,
    createOwnerProtectedTransports,
    loadOwnerAuthBoundary,
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
});
