import { expect, it } from 'vitest';
import { z } from 'zod';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import { createGenderTriageMicrobatchResponseSchema, prepareGenderTriagePlanAccount, projectV211FeatureEvaluation } from '@/lib/services/ai/v2-staged-analysis';
import { candidate, privateCandidate, profileItem, SyntheticApify, target } from './standard-providers';
import { syntheticGeneration } from './standard-vertex';
import { ApifyActorSemaphore, getApifyActorSemaphore } from '@/lib/services/instagram/providers/apify-actor-semaphore';

it('reuses each worker Actor limit across deliveries and keeps separate workers independent', async () => {
    const first = getApifyActorSemaphore();
    const second = new ApifyActorSemaphore();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const entered: string[] = [];
    const start = first.run(1, async () => { entered.push('first'); await held; });
    const queued = getApifyActorSemaphore().run(1, async () => { entered.push('queued'); });
    try {
        await second.run(1, async () => { entered.push('independent'); });
        expect(entered).toEqual(['first', 'independent']);
    } finally {
        release();
        await Promise.all([start, queued]);
    }
    expect(entered).toEqual(['first', 'independent', 'queued']);
});

it.each([240, 600])('keeps %i public candidates distinct across result pages and model microbatches', async publicCount => {
    const actor = new SyntheticApify(2, 1, publicCount);
    const run = await actor.actor('fixture-relationships').start({ Account: [target], dataToScrape: 'followers' });
    const names: string[] = [];
    const row = z.object({ username: z.string(), id: z.string(), is_private: z.boolean() });
    for (let offset = 0; offset < publicCount + 1; offset += 50) {
        const page = await actor.dataset(run.id).listItems({ offset, limit: 50 });
        expect(page.total).toBe(publicCount + 1);
        names.push(...page.items.map(item => row.parse(item).username));
    }
    expect(names[0]).toBe(candidate);
    expect(names.at(-1)).toBe(privateCandidate);
    expect(new Set(names).size).toBe(publicCount + 1);
    expect(profileItem(target, 2, publicCount + 1)).toMatchObject({ followersCount: publicCount + 1, followsCount: publicCount + 1 });
    const accounts = names.slice(0, -1).map(name => profileItem(name, 2));
    const posts = accounts.flatMap(p => p.latestPosts);
    expect(new Set(posts.map(p => p.id)).size).toBe(publicCount * 2);
    expect(new Set(posts.map(p => p.shortCode)).size).toBe(publicCount * 2);
    expect(new Set(accounts.map(p => p.profilePicUrl)).size).toBe(publicCount);
    expect(posts[0]).toMatchObject({ id: '201', shortCode: 'SamplePost20' });

    const pair = accounts.slice(29, 31).map(p => {
        const id = p.latestPosts[0]!.id;
        const media = [{ selectionId: 'profile:' + p.username, kind: 'profile' as const, normalizedJpegBase64: '/9gBAv/Z' },
            { selectionId: 'post:' + id + ':thumbnail', kind: 'feed' as const, postId: id, normalizedJpegBase64: '/9gBAv/Z' }];
        const input = { media, accountProfile: { fullName: p.fullName, bio: p.biography, hasProfileImage: true } };
        const plan = prepareGenderTriagePlanAccount(input, AI_STAGE_POLICY_V211_VERSION);
        return { accountId: plan.accountId, input, mediaManifest: plan.projectedMedia };
    }).sort((a, b) => a.accountId.localeCompare(b.accountId));
    const fixed = (key: string, text: string) => JSON.parse(syntheticGeneration({
        contents: { parts: [{ text }] }, config: { responseJsonSchema: { properties: { [key]: {} } } },
    }).text);
    const { accounts: batch } = createGenderTriageMicrobatchResponseSchema(pair.map(({ accountId, input }) => ({ accountId, input }))).parse(fixed('accounts', 'accounts(JSON): ' +
        JSON.stringify(pair.map(({ accountId, mediaManifest }) => ({ accountId, mediaManifest })))));
    for (const [index, account] of pair.entries()) {
        const projected = account.mediaManifest.map(item => item.selectionId);
        const result = batch[index];
        if (result?.status !== 'ok') throw new Error('Synthetic triage did not return an assessed account');
        expect(result.assessment.evidenceSelectionIds).toEqual(projected);
        const media = account.input.media;
        const selected = media.map(item => item.selectionId);
        const features = fixed('gender', 'evidence(JSON): ' + JSON.stringify({ mediaManifest: media }));
        expect(features.evidenceSelectionIds.gender).toEqual(selected);
        const evaluation = projectV211FeatureEvaluation({
            triage: { assessment: { inferredGender: 'female', confidence: 'high', ownerConsistency: 'same_person',
                evidenceSelectionIds: selected }, routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall', analyzedSelectionIds: selected },
            media, bio: null, captions: [],
        }, 'HIGH');
        expect(evaluation.validateResult({ features, analyzedSelectionIds: selected,
            finalGenderDecision: 'verified_female' }).finalGenderDecision).toBe('verified_female');
    }
});

it('detects an original profile or feed swap in a valid normalized WebP', async () => {
    const { createSharedImageSource, matchesSharedResultImage } = await import('./standard-shared-image-source');
    const { normalizeResultImage } = await import('@/lib/services/media/result-image-normalizer');
    const source = createSharedImageSource();
    const names = [target, candidate, 'fixture_public_1', privateCandidate, 'SamplePost2'];
    const images = await Promise.all(names.map(async name => {
        const png = await source('https://scontent.cdninstagram.com/' + name + '.jpg?z=2&a=1');
        return normalizeResultImage(png);
    }));
    expect(new Set(images.map(im => im.sha256)).size).toBe(names.length);
    for (const [i, im] of images.entries()) {
        for (const [j, name] of names.entries()) {
            expect(await matchesSharedResultImage(im.bytes, name)).toBe(i === j);
        }
    }
    expect(await source('https://scontent.cdninstagram.com/' + candidate + '.jpg?a=1&z=2'))
        .toEqual(await source('https://scontent.cdninstagram.com/' + candidate + '.jpg?z=2&a=1'));
});
