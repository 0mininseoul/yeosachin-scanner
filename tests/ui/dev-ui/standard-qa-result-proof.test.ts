import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import type { AnalysisV2DevArchiveObjectClient } from '@/lib/services/analysis/v2-media-artifact-store';
import { createDevStandardQaCopyStore } from '@/lib/services/dev-ui/standard-archive-store';
import { standardQaCopyPolicyWindow } from '@/lib/services/dev-ui/standard-qa-copy';
import { enrollStandardQaResultProof, readStandardQaResultProof } from '@/lib/services/dev-ui/standard-qa-result-proof';
import { resultImageArchiveIdentity, resultImageOrderedManifestHash, resultImageSourceFingerprint } from '@/lib/services/media/result-image-capture';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const key = (value: unknown) => sha(JSON.stringify(value));

async function syntheticProof() {
    let time = Date.UTC(2026, 0, 1);
    const policy = { target:'synthetic_account', approval:randomUUID(), sourceApproval:randomUUID(),
        days:90 as const, approvedAt:new Date(time).toISOString() };
    const { binding, context } = standardQaCopyPolicyWindow(policy);
    const bytes = new Map<string,Buffer>();
    const objects: AnalysisV2DevArchiveObjectClient = {
        async createRetained({ objectName, bytes: input }) {
            if (bytes.has(objectName)) throw new Error('Precondition failed');
            bytes.set(objectName, Buffer.from(input));
            return { created:true,generation:'1' };
        },
        async readRetained({ objectName }) { return bytes.get(objectName) ?? null; },
        async listRetained({ prefix }) { return [...bytes.keys()].filter(name=>name.startsWith(prefix)); },
    };
    const store = createDevStandardQaCopyStore({ bucketName:'fixture-dev-qa-copy',slot:'1'.repeat(32),
        key:randomBytes(32).toString('base64'), objects, now:()=>time });
    const images = await Promise.all(['red','blue'].map(background =>
        sharp({create:{width:2,height:2,channels:3,background}}).webp().toBuffer()));
    const sources = Array.from({length:225}, (_,i) => ({
        kind:i === 0 ? 'target' as const : 'female' as const, candidateLocator:i ? 'fixture_' + i : 'target',
        sortOrdinal:i, sourceUrl:'https://scontent.cdninstagram.com/fixture/' + i + '.jpg?sig=synthetic',
    }));
    const entries = sources.map((source,i) => ({ sourceFingerprint:resultImageSourceFingerprint(source.sourceUrl)!,
        webpSha256:sha(images[i%2]!) }));
    const imageInputs = sources.map(resultImageArchiveIdentity);
    await store.bindCapture(binding);
    await store.bindCopyOrigin(context, key('synthetic-source-seal'));
    await store.writeFragment({kind:'result-image-manifest-v1',inputKey:key([policy.target]),value:{
        expectedRows:225,imageCount:225,orderedManifestHash:resultImageOrderedManifestHash(sources),imageInputs,
    }});
    await Promise.all(imageInputs.map((identity,i)=>store.writeFragment({kind:'result-image-v1',inputKey:key(identity),
        value:{width:2,height:2,sha256:entries[i]!.webpSha256,webp:images[i%2]!.toString('base64')}})));
    await store.seal();
    return { store, policy, binding, entries, bytes, expire:()=>{ time=binding.expiresAt; } };
}

it('enrolls a single encrypted result proof without changing the existing seal and rejects corruption and expiry', async () => {
    const {store,policy,binding,entries,bytes,expire} = await syntheticProof();
    const existing = new Set(bytes.keys());
    const original = (await store.openSealedArchive())!;
    await expect(readStandardQaResultProof(policy,store)).rejects.toThrow();
    await expect(Promise.all([enrollStandardQaResultProof(policy,store,entries),
        enrollStandardQaResultProof(policy,store,entries)])).resolves.toEqual([225,225]);
    const names = [...bytes.keys()].filter(name => !existing.has(name));
    expect(names).toHaveLength(1);
    const name = names[0]!;
    const cipher = bytes.get(name)!;
    expect(name).not.toContain('fragment/');
    expect(cipher.includes(entries[0]!.sourceFingerprint)).toBe(false);
    expect(cipher.includes(entries[0]!.webpSha256)).toBe(false);
    expect((await store.openSealedArchive())!.fingerprint).toBe(original.fingerprint);
    expect((await store.openSealedArchive())!.members()).toEqual(original.members());
    await expect(store.readSeal()).resolves.toEqual(binding);
    await expect(readStandardQaResultProof(policy,store)).resolves.toEqual(entries);
    await expect(enrollStandardQaResultProof(policy,store,entries)).resolves.toBe(225);
    expect(bytes.get(name)).toBe(cipher);
    const corrupted = Buffer.from(cipher);
    corrupted[corrupted.length-1]! ^= 1;
    bytes.set(name,corrupted);
    await expect(readStandardQaResultProof(policy,store)).rejects.toThrow();
    await expect(enrollStandardQaResultProof(policy,store,entries)).rejects.toThrow();
    bytes.set(name,cipher);
    expire();
    await expect(readStandardQaResultProof(policy,store)).rejects.toThrow();
    await expect(enrollStandardQaResultProof(policy,store,entries)).rejects.toThrow();
});

it('rejects incomplete, reordered, extra-field, wrong-image and cross-consent input before the object is created', async () => {
    const {store,policy,entries,bytes} = await syntheticProof();
    const existing = bytes.size;
    for (const input of [
        entries.slice(1),[...entries,entries[0]], [...entries].reverse(),
        [{...entries[0], sourceFingerprint:'X'.repeat(64)},...entries.slice(1)],
        [{...entries[0], url:'synthetic'},...entries.slice(1)],
        [{...entries[0], sourceFingerprint:'f'.repeat(64)},...entries.slice(1)],
        [{...entries[0], webpSha256:entries[1]!.webpSha256},...entries.slice(1)],
    ]) await expect(enrollStandardQaResultProof(policy,store,input)).rejects.toThrow();
    for (const changed of [
        {...policy,target:'another_fixture'}, {...policy,approval:randomUUID()}, {...policy,sourceApproval:randomUUID()},
    ]) {
        await expect(enrollStandardQaResultProof(changed,store,entries)).rejects.toThrow();
        await expect(readStandardQaResultProof(changed,store)).rejects.toThrow();
    }
    expect(bytes.size).toBe(existing);
});
