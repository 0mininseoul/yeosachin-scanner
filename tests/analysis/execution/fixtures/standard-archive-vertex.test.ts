import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { selectAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { prepareGenderTriagePlanAccount } from '@/lib/services/ai/v2-staged-analysis';
import { normalizeAnalysisV2MediaSelections } from '@/lib/services/analysis/v2-media-normalization';
import { analysisV2CandidateId } from '@/lib/services/analysis/v2-ai-scoring-executors';
import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import { prepareStandardArchiveVertex } from './standard-archive-vertex';

const state = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@/lib/services/dev-ui/standard-archive-runtime', async original => ({
    ...await original<typeof import('@/lib/services/dev-ui/standard-archive-runtime')>(),
    currentDevStandardArchive: () => ({ mode: 'replay', target: 'fixture_target', load: state.load, fail() { throw new Error('Missing fake image'); } }),
}));

const version = 'ai-stage-policy-v2.11';
const target = 'fixture_target';
const key = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

it('forces the sealed feature branch for each account and rejects an unavailable branch before scoring', async () => {
    const entries = new Map<string, unknown>();
    const put = (kind: string, identity: unknown, value: unknown) => entries.set(kind + key(identity), value);
    const reader = {
        async readFragment({ kind, inputKey }: { kind: string; inputKey: string }) {
            return entries.has(kind + inputKey) ? { value: entries.get(kind + inputKey) } : null;
        },
    };
    state.load.mockImplementation(async (kind: string, identity: unknown) => {
        const row = await reader.readFragment({ kind, inputKey: key(identity) });
        if (!row) throw new Error('Unavailable fake image');
        return row.value;
    });
    const names = ['fixture_shown', 'fixture_omitted'];
    const profiles = names.map((username, index) => ({
        username, isPrivate: false, isVerified: false, followersCount: 12, followingCount: 12, postsCount: 8,
        fullName: index === 0 ? '첫째' : '둘째', profilePicUrl: 'https://fixture.invalid/' + username + '.jpg',
        latestPosts: Array.from({ length: 8 }, (_, n) => ({
            id: String((index + 1) * 100 + n), shortCode: 'S' + index + n, type: 'image' as const,
            imageUrl: 'https://fixture.invalid/' + username + n + '.jpg', likesCount: 1, commentsCount: 0,
            timestamp: new Date(1_700_000_000_000 + n * 60_000).toISOString(), taggedUsers: [], mentionedUsers: [],
        })),
    }));
    const accountInputs = [];
    let includedListKey = '';
    for (const [index, profile] of profiles.entries()) {
        const policy = selectAnalysisMedia({ profile: { id: profile.username, imageUrl: profile.profilePicUrl },
            posts: profile.latestPosts }, { carouselDiversity: true });
        const included = new Set(policy.triage.selectionIds);
        for (const [stage, media] of [policy.triage.media, policy.feature.media.filter(m => !included.has(m.selectionId))].entries()) {
            const hash = key(media.map(x => [x.selectionId, archiveMediaUrlAnchor(x.imageUrl), x.role, x.postId ?? null,
                x.postType ?? null, x.mediaIndex ?? null]));
            if (stage === 1 && index === 1) continue;
            const parts = media.map((_, i) => [version, hash, i]);
            put('ai-image-selection-v1', [version, hash], parts);
            if (stage === 1 && index === 0) includedListKey = 'ai-image-selection-v1' + key([version, hash]);
            for (const part of parts) put('ai-image', part, { status: 'success', jpeg: '/9gBAv/Z' });
        }
        const normalized = await normalizeAnalysisV2MediaSelections(policy.triage.media, async () => { throw new Error('No network'); }, version);
        const plan = prepareGenderTriagePlanAccount({ media: normalized.media,
            accountProfile: { fullName: profile.fullName, hasProfileImage: true, bio: null } }, version);
        accountInputs.push({ accountId: plan.accountId, mediaManifest: plan.projectedMedia });
    }
    const candidate = analysisV2CandidateId(names[0]!);
    put('capture-summary-v1', [target], [0]);
    put('result-image-manifest-v1', [target], { imageInputs: [['target', 'target', null], ['female', candidate, null]] });
    const scopeHash = key([target,100,[[candidate,'https://www.instagram.com/p/S07/',1,true]]]);
    put('reverse-coverage-v1', [target], { scopeHash, results: [{ candidateId: candidate,status:'observed' }] });
    const ids = [target, 0, ...names];
    put('capture-coverage-v1', ['candidate-profile-batch-v1', 0], key(ids));
    put('candidate-profile-batch-v1', ids, profiles.map(profile => ({
        profile, outcome: { status:'success', requestedUsername:profile.username },
    })));
    const input = { target, reader, profileBatches: [0] };
    const fixed = await prepareStandardArchiveVertex(input);
    const response = fixed.generate({ contents: { parts: [{ text: 'accounts(JSON): ' + JSON.stringify(accountInputs) }] },
        config: { responseJsonSchema: { properties: { accounts: {} } } } });
    expect(JSON.parse(response.text).accounts.map((r: { assessment: { inferredGender: string } }) => r.assessment.inferredGender))
        .toEqual(['female','male']);
    expect(fixed.counts()).toMatchObject({ profiles:2, missingRemainder:1, positiveProfiles:1, batchCalls:1 });
    expect(fixed.reverseScope.sourceCounts()).toMatchObject({ reverseExpected:1, reverseSourceHashMatch:1 });
    const selectionCount = 6;
    const idsFor = (count:number) => Array.from({length:count},(_,i)=>'resolver-media:'+(i+1));
    const resolver = (count:number) => ({ contents:{ parts:[{text:'사용 가능한 selectionId: '+idsFor(count).join(', ')},
        ...idsFor(count).map(()=>({inlineData:{data:'/9gBAv/Z'}}))] },config:{responseJsonSchema:{properties:{inferredGender:{}}}} });
    // Resolver receives at most one profile and the policy's bounded feed window.
    const n = (await import('@/lib/domain/analysis/media-policy')).MAX_TRIAGE_FEED_MEDIA + 1;
    const answer = JSON.parse(fixed.generate(resolver(n)).text);
    expect(answer).toMatchObject({inferredGender:'female', evidenceSelectionIds:idsFor(2)});
    expect(() => fixed.generate(resolver(selectionCount+10))).toThrow('UNKNOWN_RESOLVER_INPUT');
    entries.delete(includedListKey);
    await expect(prepareStandardArchiveVertex(input)).rejects.toThrow('UNCOVERED_REQUIRED_BRANCH');
});
