import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createCloudSyntheticApify } from './standard-cloud-apify';
import { createGcsSyntheticApifyStore, syntheticCloudBucket, type SyntheticCloudStorageRequester } from './standard-cloud-apify-store';
import { SyntheticApify, candidate, privateCandidate, profileItem, publicUsername, target } from './standard-providers';

const waveDigest = 'e'.repeat(64);
const actor = 'scraping_solutions/instagram-scraper-followers-following-no-cookies';
const relation = { Account: [target], dataToScrape: 'Followers', resultsLimit: 601 };

function harness() {
    const objects = new Map<string, string>();
    let ambiguousUpload = false;
    const beforeUpload: Error[] = [];
    const history: { method: string; name: string; body?: string; generation?: string }[] = [];
    // Separate adapter instances share only the GCS transport. Emulate create-only
    // writes and a committed upload whose network acknowledgement was lost.
    const requester: SyntheticCloudStorageRequester = { async request(options) {
        const url = new URL(options.url);
        expect(url.origin).toBe('https://storage.googleapis.com');
        expect(url.pathname).toContain('/b/' + syntheticCloudBucket + '/o');
        if (options.method === 'POST') {
            const name = options.params.name;
            expect(name).toMatch(/^standard-six\/v2\/[a-f0-9]{64}\/apify\//);
            expect(options.params.ifGenerationMatch).toBe('0');
            history.push({ method: 'POST', name, body: options.data?.toString(), generation: options.params.ifGenerationMatch });
            const failure = beforeUpload.shift();
            if (failure) throw failure;
            if (objects.has(name)) throw Object.assign(new Error('exists'), { response: { status: 412 } });
            objects.set(name, options.data!.toString());
            if (ambiguousUpload) { ambiguousUpload = false; throw Object.assign(new Error('connection closed after commit'), { code: 'ECONNRESET' }); }
            return { data: {} };
        }
        if (options.params.prefix) {
            const keys = [...objects.keys()].filter(key => key.startsWith(options.params.prefix)).sort();
            const offset = Number(options.params.pageToken ?? 0);
            return { data: { items: keys.slice(offset, offset + 2).map(name => ({ name })),
                ...(offset + 2 < keys.length ? { nextPageToken: String(offset + 2) } : {}) } };
        }
        const key = decodeURIComponent(url.pathname.split('/o/')[1]!);
        history.push({ method: 'GET', name: key });
        const value = objects.get(key);
        if (value === undefined) throw Object.assign(new Error('not found'), { response: { status: 404 } });
        return { data: JSON.parse(value) };
    } };
    const worker = (owner = 'one', delayMs = 25_105, wave = waveDigest) => createCloudSyntheticApify({
        store: createGcsSyntheticApifyStore({ bucket: syntheticCloudBucket, waveDigest: wave, requester }),
        operationKey: () => createHash('sha256').update(owner).digest('hex'), durationMs: () => delayMs,
    });
    const store = createGcsSyntheticApifyStore({ bucket: syntheticCloudBucket, waveDigest, requester });
    return { worker, store, requester, objects, history, beforeUpload, loseResponse: () => { ambiguousUpload = true; } };
}

afterEach(() => vi.useRealTimers());

it('shares one run and terminal receipt across workers, retries and paginated reads', async () => {
    vi.useFakeTimers();
    const { worker, store, objects } = harness();
    const first = worker();
    const second = worker();
    const [a, b] = await Promise.all([first.actor(actor).start(relation), second.actor(actor).start(relation)]);
    expect(a).toEqual(b);
    expect(await store.invocationCounts()).toEqual({ sdkEntries: 2, rejectedEntries: 0, distinctAcceptedRuns: 1,
        duplicateAcceptedEntries: 1, runsCreated: 1, acceptedWithoutRun: 0, runsWithoutEntry: 0 });
    expect(await second.run(a.id).waitForFinish({ waitSecs: 0 })).toEqual({ id: a.id, status: 'RUNNING' });
    await expect(second.dataset(a.id).listItems()).rejects.toThrow('DATASET_PENDING');
    await vi.advanceTimersByTimeAsync(25_105);
    const terminal = await first.run(a.id).waitForFinish({ waitSecs: 30 });
    expect(terminal).toMatchObject({ status: 'SUCCEEDED', defaultDatasetId: a.id, usageTotalUsd: 0 });
    expect(await store.getFinish(a.id)).toMatchObject({ usageUsd: 0.001 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await worker().run(a.id).get()).toEqual(terminal);
    expect(objects.size).toBe(4);
    const local = new SyntheticApify(1, 1, 600);
    const localRun = await local.actor(actor).start(relation);
    for (const offset of [0, 400, 600, 601]) {
        const page = { offset, limit: 200 };
        expect(await second.dataset(a.id).listItems(page)).toEqual(await local.dataset(localRun.id).listItems(page));
    }
    expect((await worker('two').actor(actor).start(relation)).id).not.toEqual(a.id);
    await expect(worker('one', 25_105, 'c'.repeat(64)).run(a.id).get()).rejects.toThrow('OBJECT_UNAVAILABLE');
    for (const value of objects.values()) {
        expect(value).not.toContain(target);
        expect(value).not.toContain(candidate);
        expect(value).not.toContain('instagram');
    }
});

it('reconstructs only catalogued profiles and posts while preserving fixture charges', async () => {
    const { worker, store } = harness();
    const client = worker('buyer', 0);
    const post = 'https://www.instagram.com/p/TargetPost70/';
    type ActorInput = Parameters<ReturnType<SyntheticApify['actor']>['start']>[0];
    const requests: [string, ActorInput & Record<string, unknown>][] = [
        ['apify/instagram-profile-scraper', { usernames: [target, candidate] }],
        ['datadoping/instagram-likes-scraper', { posts: [post], max_count: 50 }],
        ['apify/instagram-comment-scraper', { directUrls: [post], resultsLimit: 50, includeNestedComments: false }],
    ];
    const local = new SyntheticApify(1, 1, 600);
    for (const [name, input] of requests) {
        const receipt = await client.actor(name).start(input, { maxTotalChargeUsd: 0.0005 });
        const original = await local.actor(name).start(input);
        expect(await client.run(receipt.id).get()).toMatchObject({ usageTotalUsd: 0 });
        expect(await store.getFinish(receipt.id)).toMatchObject({ usageUsd: 0.0005 });
        expect(await client.dataset(receipt.id).listItems()).toEqual(await local.dataset(original.id).listItems({}));
    }
    const created = (await store.invocationCounts()).runsCreated;
    const rejected = [
        ['unregistered/actor', { usernames: [target] }],
        ['apify/instagram-profile-scraper', { usernames: ['uncatalogued_name'] }],
        ['apify/instagram-profile-scraper', { usernames: [candidate], metadata: 'foreign' }],
        ['datadoping/instagram-likes-scraper', { posts: [post + '?private=input'], max_count: 1 }],
        [actor, { ...relation, Account: ['uncatalogued_name'] }],
    ] as const;
    for (const [name, input] of rejected) await expect(client.actor(name).start(input)).rejects.toThrow('CLOUD_SYNTHETIC_APIFY_INVALID');
    expect(await store.invocationCounts()).toMatchObject({ sdkEntries: created + rejected.length,
        rejectedEntries: rejected.length, duplicateAcceptedEntries: 0, runsCreated: created });
    expect(() => createGcsSyntheticApifyStore({ bucket: 'unrelated-bucket', waveDigest })).toThrow();
    expect(() => createGcsSyntheticApifyStore({ bucket: syntheticCloudBucket, waveDigest: '../wrong' })).toThrow();
});

it('writes and reads Plus receipts for the last public profile, private profile and post', async () => {
    vi.stubEnv('DEV_STANDARD_QA_PLAN', 'plus');
    vi.resetModules();
    try {
        const { createCloudSyntheticApify: createPlusClient } = await import('./standard-cloud-apify');
        const { createGcsSyntheticApifyStore: createPlusStore } = await import('./standard-cloud-apify-store');
        const { requester } = harness();
        const store = createPlusStore({ bucket: syntheticCloudBucket, waveDigest, requester });
        const lastPublic = publicUsername(899);
        const lastPost = profileItem(lastPublic).latestPosts[0]!.url;
        const profileClient = createPlusClient({ store, operationKey: () => '1'.repeat(64), durationMs: () => 0 });
        const profiles = await profileClient.actor('apify/instagram-profile-scraper').start({
            usernames: [lastPublic, privateCandidate],
        });
        await profileClient.run(profiles.id).get();
        const local = new SyntheticApify(1, 1, 900);
        const expectedProfiles = await local.actor('apify/instagram-profile-scraper').start({
            usernames: [lastPublic, privateCandidate],
        });
        await expect(profileClient.dataset(profiles.id).listItems())
            .resolves.toEqual(await local.dataset(expectedProfiles.id).listItems({}));

        const postClient = createPlusClient({ store, operationKey: () => '2'.repeat(64), durationMs: () => 0 });
        const posts = await postClient.actor('datadoping/instagram-likes-scraper').start({ posts: [lastPost], max_count: 50 });
        await postClient.run(posts.id).get();
        const expectedPosts = await local.actor('datadoping/instagram-likes-scraper').start({ posts: [lastPost] });
        await expect(postClient.dataset(posts.id).listItems())
            .resolves.toEqual(await local.dataset(expectedPosts.id).listItems({}));
        expect(await store.invocationCounts()).toMatchObject({ sdkEntries: 2, runsCreated: 2, acceptedWithoutRun: 0 });
    } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
    }
});

it('counts one SDK entry when the create acknowledgement is lost and its transport retries', async () => {
    const { worker, store, loseResponse, objects } = harness();
    loseResponse();
    const { id } = await worker('once', 0).actor(actor).start(relation);
    const entry = [...objects.entries()].find(([key]) => key.includes('/entries/'))!;
    const receipt = JSON.parse(entry[1]);
    // Only the transport can reuse the nonce. Another actor().start() generates a fresh nonce.
    await store.recordInvocation(id, receipt.nonce);
    expect(await store.invocationCounts()).toEqual({ sdkEntries: 1, rejectedEntries: 0, distinctAcceptedRuns: 1,
        duplicateAcceptedEntries: 0, runsCreated: 1, acceptedWithoutRun: 0, runsWithoutEntry: 0 });
    expect(entry[0]).toContain('/entries/' + id + '/');
    expect(receipt).toEqual({ version: 2, id, nonce: receipt.nonce });
    // A crash after recording the SDK entry and before recording the run stays visible.
    await store.recordInvocation('CloudQa' + '1'.repeat(48), randomUUID());
    expect(await store.invocationCounts()).toMatchObject({ sdkEntries: 2, acceptedWithoutRun: 1 });
});

it('preserves the first terminal outcome, cost, and finish time even across abort and success races', async () => {
    vi.useFakeTimers();
    const { worker } = harness();
    const first = worker();
    const other = worker();
    const { id } = await first.actor(actor).start(relation, { maxTotalChargeUsd: 0.0002 });
    const aborted = await other.run(id).abort();
    expect(aborted).toMatchObject({ status: 'ABORTED', usageTotalUsd: 0 });
    await vi.advanceTimersByTimeAsync(26_000);
    expect(await first.run(id).waitForFinish()).toEqual(aborted);
    expect(await first.run(id).get()).toEqual(aborted);
    await expect(first.dataset(id).listItems()).rejects.toThrow('DATASET_ABORTED');
    const ready = await worker('finished', 0).actor(actor).start(relation);
    const succeeded = await first.run(ready.id).get();
    expect(succeeded.status).toBe('SUCCEEDED');
    expect(await other.run(ready.id).abort()).toEqual(succeeded);
    const race = await worker('race', 0).actor(actor).start(relation);
    const [a, b] = await Promise.all([first.run(race.id).get(), other.run(race.id).abort()]);
    expect(a).toEqual(b);
});

it.each([408, 429, 503, 'ECONNRESET'])('retries a pre-commit %s once after confirming absence with the same invocation', async status => {
    const { worker, store, beforeUpload, history } = harness();
    beforeUpload.push(typeof status === 'number'
        ? Object.assign(new Error('transient'), { response: { status } }) : Object.assign(new Error('network'), { code: status }));
    await worker().actor(actor).start(relation);
    expect(history.slice(0, 3).map(item => item.method)).toEqual(['POST', 'GET', 'POST']);
    expect(history[1]!.name).toBe(history[0]!.name);
    expect(history[2]).toEqual(history[0]);
    expect(await store.invocationCounts()).toMatchObject({ sdkEntries: 1, duplicateAcceptedEntries: 0, runsCreated: 1 });
});

it.each([401, 403])('fails a real POST %s even if the winning receipt already exists', async status => {
    const { store, beforeUpload, history } = harness();
    const entry = randomUUID();
    await store.recordInvocation(null, entry);
    const before = history.length;
    beforeUpload.push(Object.assign(new Error('upstream response withheld'), { response: { status } }));
    await expect(store.recordInvocation(null, entry)).rejects.toThrow(/^CLOUD_SYNTHETIC_APIFY_OBJECT_UNAVAILABLE$/);
    expect(history.slice(before).map(item => item.method)).toEqual(['POST']);
});

it('stops after two transient POST failures and two confirmed misses', async () => {
    const { worker, beforeUpload, history, objects } = harness();
    for (let i = 0; i < 2; i++) beforeUpload.push(Object.assign(new Error('network'), { code: 'ECONNRESET' }));
    await expect(worker().actor(actor).start(relation)).rejects.toThrow('CLOUD_SYNTHETIC_APIFY_OBJECT_UNAVAILABLE');
    expect(history.map(item => item.method)).toEqual(['POST', 'GET', 'POST', 'GET']);
    expect(history[2]).toEqual(history[0]);
    expect(objects.size).toBe(0);
});
