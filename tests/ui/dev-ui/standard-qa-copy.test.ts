import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AnalysisV2DevArchiveObjectClient } from '@/lib/services/analysis/v2-media-artifact-store';
import { createDevStandardArchiveStore, createDevStandardQaCopyStore } from '@/lib/services/dev-ui/standard-archive-store';
import { currentDevStandardArchive } from '@/lib/services/dev-ui/standard-archive-runtime';
import { exportStandardQaCopy, withVerifiedStandardQaCopy, type StandardQaCopyPolicy } from '@/lib/services/dev-ui/standard-qa-copy';

const day = 86_400_000;
const began = Date.UTC(2026, 0, 1);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function memoryObjects() {
    const bytes = new Map<string, Buffer>();
    let writesLeft = Infinity;
    const objects: AnalysisV2DevArchiveObjectClient = {
        async readRetained({ objectName }) { return bytes.get(objectName) ?? null; },
        async createRetained(input) {
            if (--writesLeft < 0) throw new Error('simulated interrupted upload');
            if (bytes.has(input.objectName)) throw new Error('object exists');
            bytes.set(input.objectName, Buffer.from(input.bytes));
            return { created: true, generation: '1' };
        },
        async listRetained({ prefix }) { return [...bytes.keys()].filter(name => name.startsWith(prefix)); },
    };
    return { bytes, objects, allowWrites: (n: number) => { writesLeft = n; } };
}

async function fixture(days: 90, unexpectedFragment = false) {
    let instant = began;
    const time = () => instant;
    const now = (n: number) => { instant = n; };
    const original = memoryObjects();
    const copied = memoryObjects();
    const policy: StandardQaCopyPolicy = {
        approval: randomUUID(), sourceApproval: randomUUID(), target: 'fixture.account',
        approvedAt: new Date(began).toISOString(), days,
    };
    const source = createDevStandardArchiveStore({
        bucketName: 'fixture-dev-live-media', slot: '1'.repeat(32), key: randomBytes(32).toString('base64'),
        objects: original.objects, now: time,
    });
    const destination = createDevStandardQaCopyStore({
        bucketName: 'fixture-dev-qa-copy', slot: '2'.repeat(32), key: randomBytes(32).toString('base64'),
        objects: copied.objects, now: time,
    });
    await source.bindCapture({ grantId: policy.sourceApproval, target: policy.target, expiresAt: began + day });
    const targetImage = ['target', 'fixture-key', null];
    const groups: [string, unknown[], unknown][] = [
        ['preflight-profile-v1', [], { username: 'fixture.account' }],
        ['fresh-profile-v1', [], {}],
        ['preflight-blite-policy-v1', [], false],
        ['relationship-side-v1', ['followers'], []],
        ['relationship-side-v1', ['following'], []],
        ['formal-target-profile-v2', [], {}],
        ['target-evidence-v1', [], {}],
        ['reverse-coverage-v1', [], []],
        ['source-profile-proof-v1', ['track:target-evidence:collect'], {
            providerOperationKey: 'target-profile:synthetic', providerInputHash: '3'.repeat(64),
        }],
        ['result-image-manifest-v1', [], {
            expectedRows: 1, imageCount: 0, orderedManifestHash: '4'.repeat(64), imageInputs: [targetImage],
        }],
    ];
    for (const [kind, keys, value] of groups) {
        const inputKey = hash([policy.target, ...keys]);
        await source.writeFragment({ kind, inputKey, value });
        await source.writeFragment({ kind: 'capture-coverage-v1', inputKey: hash([kind, ...keys]), value: inputKey });
    }
    await source.writeFragment({ kind: 'capture-summary-v1', inputKey: hash([policy.target]), value: [] });
    await source.writeFragment({ kind: 'result-image-v1', inputKey: hash(targetImage), value: 'source_missing' });
    if (unexpectedFragment) await source.writeFragment({
        kind: 'future-capture-kind', inputKey: hash(['future']), value: 'synthetic',
    });
    await source.seal();
    return { source, destination, policy, now, time, copied, original };
}

describe('an independently approved private QA copy', () => {
    it('opens the isolated fixture after the original grant expires, up to day 90', async () => {
        const days = 90;
        const { source, destination, policy, now, time, copied, original } = await fixture(days);
        const result = await exportStandardQaCopy(policy, source, destination, time);
        expect(result).toEqual({ fragments: 22, profileBatches: 0, expiresAt: began + days * day });
        const unchanged = [...copied.bytes.values()].map(b => b.toString('hex'));
        await exportStandardQaCopy(policy, source, destination, time);
        expect([...copied.bytes.values()].map(b => b.toString('hex'))).toEqual(unchanged);
        const sourceNames = new Set([...original.bytes.keys()].map(name => name.split('/').at(-1)));
        const sourceBytes = new Set([...original.bytes.values()].map(b => b.toString('hex')));
        for (const [name, bytes] of copied.bytes) {
            expect(sourceBytes.has(bytes.toString('hex'))).toBe(false);
            expect(name).not.toContain(policy.target);
            if (name.includes('/fragment/')) {
                expect(name).toMatch(/\/[a-f0-9]{80}\.bin$/);
                expect(sourceNames.has(name.split('/').at(-1))).toBe(false);
            }
            expect(bytes.includes(policy.target)).toBe(false);
        }
        now(began + day);
        await expect(source.openSealedArchive()).rejects.toThrow('EXPIRED');
        const read = () => withVerifiedStandardQaCopy(policy, destination,
            () => currentDevStandardArchive()!.load('preflight-profile-v1', [policy.target]), time);
        await expect(read()).resolves.toEqual({ username: policy.target });
        await expect(withVerifiedStandardQaCopy({ ...policy, approval: randomUUID() }, destination, () => true, time)).rejects.toThrow();
        await expect(withVerifiedStandardQaCopy({ ...policy, sourceApproval: randomUUID() }, destination, () => true, time)).rejects.toThrow();
        now(began + days * day);
        await expect(read()).rejects.toThrow();
    });

    it('keeps interrupted copies unreadable and resumes exact members without reopening the original approval', async () => {
        const { source, destination, policy, time, copied } = await fixture(90);
        copied.allowWrites(6);
        await expect(exportStandardQaCopy(policy, source, destination, time)).rejects.toThrow();
        expect(await destination.openSealedArchive()).toBeNull();
        copied.allowWrites(Infinity);
        await exportStandardQaCopy(policy, source, destination, time);
        const entry = [...copied.bytes].find(([key]) => key.includes('/fragment/'))!;
        const damaged = Buffer.from(entry[1]);
        damaged[damaged.length - 1] ^= 1;
        copied.bytes.set(entry[0], damaged);
        await expect(withVerifiedStandardQaCopy(policy, destination, () => true, time)).rejects.toThrow();
    });

    it('refuses an unapproved future capture kind before creating any copy objects', async () => {
        const { source, destination, policy, time, copied } = await fixture(90, true);
        await expect(exportStandardQaCopy(policy, source, destination, time)).rejects.toThrow();
        expect(copied.bytes.size).toBe(0);
    });

    it('rejects a different original consent or target, an inactive copy window, and an expired source', async () => {
        const { source, destination, policy, time, now, copied } = await fixture(90);
        for (const invalid of [
            { ...policy, sourceApproval: randomUUID() }, { ...policy, target: 'different.fixture' },
            { ...policy, approvedAt: new Date(began + day).toISOString() },
        ]) {
            await expect(exportStandardQaCopy(invalid, source, destination, time)).rejects.toThrow();
        }
        now(began + day);
        await expect(exportStandardQaCopy(policy, source, destination, time)).rejects.toThrow();
        expect(copied.bytes.size).toBe(0);
    });
});
