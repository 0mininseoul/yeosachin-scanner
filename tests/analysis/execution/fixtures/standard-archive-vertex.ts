import { private90ImageScope } from './private90-image-scope';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { selectAnalysisV2GenderResolverMedia } from '@/lib/services/analysis/v2-gender-resolver-media-policy';
import { projectGenderResolutionMedia } from '@/lib/services/ai/gender-resolution-pure';
import { private90ReverseScope } from './private90-reverse-scope';
import { selectAnalysisMedia, type SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { prepareGenderTriagePlanAccount } from '@/lib/services/ai/v2-staged-analysis';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import { analysisV2CandidateId } from '@/lib/services/analysis/v2-ai-scoring-executors';
import { normalizeAnalysisV2MediaSelections } from '@/lib/services/analysis/v2-media-normalization';
import { analysisV2CheckpointProfileSchema } from '@/lib/services/analysis/v2-profile-fetch-store';
import { currentDevStandardArchive } from '@/lib/services/dev-ui/standard-archive-runtime';
import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import { fixedPrivateNameResults, syntheticGeneration } from './standard-vertex';
import type { bootstrapStandardArchiveSource } from './standard-archive-source';

type Setup = Omit<Parameters<typeof bootstrapStandardArchiveSource>[1], 'ownerId'>;
type Generation = Parameters<typeof syntheticGeneration>[0];
type ManifestItem = { selectionId: string; kind: 'feed' | 'profile' };
const mediaManifest = z.array(z.object({ selectionId: z.string(), kind: z.enum(['feed', 'profile']) }));
const accountManifest = z.array(z.object({ accountId: z.string(), mediaManifest }));
const version = AI_STAGE_POLICY_V211_VERSION;

function key(parts: unknown) {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
function stop(code: string): never {
    throw new Error('OFFLINE_STANDARD_VERTEX_' + code);
}
function membershipKey(selected: readonly SelectedAnalysisMedia[]) {
    const hash = key(selected.map(x => [x.selectionId, archiveMediaUrlAnchor(x.imageUrl), x.role, x.postId ?? null,
        x.postType ?? null, x.mediaIndex ?? null]));
    return { hash, inputKey: key([version, hash]) };
}
function promptData(prompt: string, label: string) {
    const prefix = label + '(JSON): ';
    const line = prompt.split('\n').findLast(s => s.startsWith(prefix));
    if (!line) return stop('PROMPT_SHAPE');
    return JSON.parse(line.slice(prefix.length)) as unknown;
}
// The fixed output describes only attachment kinds. User-authored bio/caption text can
// contain terms the real v2.11 public-copy schema forbids even inside quotations.
function fixedFeatureOverview(media:ManifestItem[]) {
    const profile = media.some(item => item.kind === 'profile');
    const feed = media.some(item => item.kind === 'feed');
    if (profile && feed) return '프로필 이미지와 피드 이미지가 함께 있어 소개 화면과 게시물 양쪽에서 사진을 볼 수 있습니다.';
    if (feed) return '게시물에 올린 피드 이미지를 통해 이 계정이 공개한 사진 구성을 살펴볼 수 있습니다.';
    if (profile) return '프로필에 이미지를 올려 두어 소개 화면에서 계정을 대표하는 사진을 볼 수 있습니다.';
    return stop('MODEL_INPUT_SHAPE');
}
function response(output: unknown) {
    const text = JSON.stringify(output);
    return { text, candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
        usageMetadata: { promptTokenCount: 24, candidatesTokenCount: 12, thoughtsTokenCount: 0, totalTokenCount: 36 } };
}

export async function prepareStandardArchiveVertex(input: Setup) {
    const session = currentDevStandardArchive();
    if (session?.mode !== 'replay' || session.target !== input.target) stop('SEALED_SESSION_REQUIRED');
    const positiveByAccount = new Map<string, boolean>();
    const expectedByAccount = new Map<string,string>();
    const positiveOwners = new Set<string>();
    const resolverRoutes = new Map<string,boolean | null>();
    const resolverKey = (images:readonly string[]) => key(images.map(data => createHash('sha256').update(Buffer.from(data,'base64')).digest('hex')));
    const positiveBySelection = new Map<string, boolean | null>();
    const totals = { profileBatches: input.profileBatches.length, profiles: 0, missingRemainder: 0, positiveProfiles: 0,
        batchCalls: 0, featureCalls: 0, resolverCalls: 0, nameCalls: 0, otherCalls: 0 };
    let reverseScope: ReturnType<typeof private90ReverseScope>;
    let imageScope: ReturnType<typeof private90ImageScope>;
    const read = async (kind: string, inputKey: string) => {
        const fragment = await input.reader.readFragment({ kind, inputKey });
        return fragment ? fragment.value : stop('SEALED_INPUT_MISSING');
    };
    try {
        const covered = z.array(z.number().int()).parse(await read('capture-summary-v1', key([input.target])));
        if (covered.length !== input.profileBatches.length ||
            covered.some((n,i) => n !== i || input.profileBatches[i] !== n)) stop('BATCH_COVERAGE');
        const manifest = z.object({ imageInputs: z.array(z.tuple([z.enum(['target','female','private']), z.string(), z.string().nullable()])) })
            .parse(await read('result-image-manifest-v1', key([input.target])));
        const female = new Set(manifest.imageInputs.filter(x => x[0] === 'female').map(x => x[1]));
        reverseScope = private90ReverseScope(input.target, await read('reverse-coverage-v1', key([input.target])));
        const reverseIds = reverseScope.expected;
        // The archived reverse lookup checks the exact candidate set. Retain that shortlist, and only publish
        // candidates whose result images are in the verified archive. Reranking is still performed by the worker.
        if ([...reverseIds].some(id => !female.has(id))) stop('REVERSE_RESULT_SCOPE_UNSUPPORTED');
        const positive = reverseIds.size ? reverseIds : female;
        imageScope = private90ImageScope(manifest.imageInputs, positive);
        const matchedPositive = new Set<string>();
        for (const batch of covered) {
            const pointer = z.string().regex(/^[a-f0-9]{64}$/).parse(await read('capture-coverage-v1', key(['candidate-profile-batch-v1', batch])));
            const rows = z.array(z.object({ outcome: z.object({ status: z.string(), requestedUsername: z.string() }),
                profile: analysisV2CheckpointProfileSchema.optional() })).parse(await read('candidate-profile-batch-v1', pointer));
            if (pointer !== key([input.target, batch, ...rows.map(r => r.outcome.requestedUsername)])) stop('BATCH_IDENTITY');
            for (const row of rows) {
                if (row.outcome.status !== 'success' || !row.profile || row.profile.isPrivate) continue;
                const profile = row.profile;
                const id = analysisV2CandidateId(profile.username);
                const desired = positive.has(id);
                reverseScope.remember(id, profile);
                const policy = selectAnalysisMedia({ profile: profile.profilePicUrl ? { id: profile.username, imageUrl: profile.profilePicUrl } : undefined,
                    posts: profile.latestPosts ?? [] }, { carouselDiversity: true });
                if (policy.carouselCoverage.incompletePostIds.length) stop('PROFILE_INPUT_INCOMPLETE');
                const used = new Set(policy.triage.selectionIds);
                const remainder = policy.feature.media.filter(item => !used.has(item.selectionId));
                const member = membershipKey(remainder);
                const list = remainder.length ? await input.reader.readFragment({ kind:'ai-image-selection-v1', inputKey: member.inputKey }) : null;
                if (list && JSON.stringify(list.value) !== JSON.stringify(remainder.map((_,i) => [version,member.hash,i]))) stop('SELECTION_MEMBERSHIP');
                const absent = remainder.length > 0 && !list;
                // Recreate the same microbatch account ID, including JPEG digests, then discard the image bytes.
                const triage = await normalizeAnalysisV2MediaSelections(policy.triage.media, async () => stop('NETWORK_ATTEMPT'), version);
                if (absent && (desired || triage.media.length < 2)) stop('UNCOVERED_REQUIRED_BRANCH');
                // Only these candidates can reach optional resolution after our fixed triage.
                // The resolver sees anonymous ordered JPEGs, never the source selection IDs.
                if (desired || triage.media.length < 2) {
                    const rest = remainder.length ? (await normalizeAnalysisV2MediaSelections(remainder, async () => stop('NETWORK_ATTEMPT'), version)).media : [];
                    const byId = new Map([...triage.media,...rest].map(item => [item.selectionId,item]));
                    const chosen = policy.feature.media.flatMap(item => byId.get(item.selectionId) ?? []);
                    const resolved = projectGenderResolutionMedia(selectAnalysisV2GenderResolverMedia(chosen));
                    const fingerprint = resolverKey(resolved.projectedMedia.map(item => item.normalizedJpegBase64));
                    const previous = resolverRoutes.get(fingerprint);
                    resolverRoutes.set(fingerprint,previous === undefined || previous === desired ? desired : null);
                }
                if (desired) positiveOwners.add(id);
                const account = prepareGenderTriagePlanAccount({ media: triage.media, accountProfile: {
                    fullName: profile.fullName ?? null, hasProfileImage: Boolean(profile.profilePicUrl?.trim()), bio: profile.bio ?? null,
                } }, version);
                if (positiveByAccount.has(account.accountId) && positiveByAccount.get(account.accountId) !== desired) stop('ACCOUNT_ROUTE_AMBIGUOUS');
                positiveByAccount.set(account.accountId, desired);
                if (reverseIds.has(id)) expectedByAccount.set(account.accountId,id);
                reverseScope.bindAccount(account.accountId,id);
                reverseScope.bind(id, policy.feature.selectionIds);
                for (const item of policy.feature.media) {
                    const previous = positiveBySelection.get(item.selectionId);
                    positiveBySelection.set(item.selectionId, previous === undefined || previous === desired ? desired : null);
                }
                totals.profiles++;
                if (absent) totals.missingRemainder++;
                if (desired) { totals.positiveProfiles++; matchedPositive.add(id); }
            }
        }
        if (!matchedPositive.size || matchedPositive.size !== positive.size) stop('PUBLICATION_SCOPE_UNSUPPORTED');
    } catch (error) {
        if (error instanceof Error && /^OFFLINE_STANDARD_VERTEX_[A-Z_]+$/.test(error.message)) throw error;
        stop('PREPARATION_FAILED');
    }

    function desiredFor(items: ManifestItem[]) {
        const options = new Set(items.map(item => positiveBySelection.get(item.selectionId)).filter(v => typeof v === 'boolean'));
        if (options.size > 1) stop('FEATURE_ROUTE_AMBIGUOUS');
        return options.has(true);
    }
    const counts = () => ({ ...totals });
    function generate(input: Generation): ReturnType<typeof syntheticGeneration> {
        try {
            const schema = input.config.responseJsonSchema as { type?: string; properties?: Record<string, unknown> };
            const fields = schema.properties ?? {};
            const prompt = (Array.isArray(input.contents) ? input.contents : [input.contents])
                .flatMap(c => c.parts.map(p => p.text ?? '')).join('\n');
            const privateNames = fixedPrivateNameResults(input);
            if (privateNames) {
                totals.nameCalls++;
                return response(privateNames);
            }
            if ('accounts' in fields) {
                totals.batchCalls++;
                const accounts = accountManifest.parse(promptData(prompt, 'accounts'));
                return response({ accounts: accounts.map(account => {
                    reverseScope.event(expectedByAccount.get(account.accountId), 'triage');
                    const female = positiveByAccount.get(account.accountId);
                    if (female === undefined) stop('UNKNOWN_BATCH_ACCOUNT');
                    const ids = account.mediaManifest.slice(0,2).map(m => m.selectionId);
                    return { accountId: account.accountId, status:'ok', accountContext:'personal', assessment: {
                        inferredGender: female ? 'female' : 'male', confidence:'high', ownerConsistency:'same_person', evidenceSelectionIds:ids,
                    } };
                }) });
            }
            if ('gender' in fields) {
                totals.featureCalls++;
                const items = z.object({mediaManifest}).parse(promptData(prompt,'evidence')).mediaManifest;
                const owner = reverseScope.selectionOwner(items);
                reverseScope.event(owner,'featureModel');
                const ids = items.map(x => x.selectionId);
                const main = ids.slice(0,2);
                const secondary = items.filter(x => x.kind === 'feed').slice(0,1).map(x => x.selectionId);
                return response({ gender: (owner ? positiveOwners.has(owner) : desiredFor(items)) ? 'female' : 'male', genderConfidence:'high', ownerConsistency:'same_person',
                    appearanceGrade:5,exposureScore:2,businessClassification:'personal',businessConfidence:'high',accountContext:'personal',
                    marriageEvidence:'none',partnerEvidence:'none',partnerExclusionContext:'none', evidenceSelectionIds:{
                        gender:main, appearance:secondary, exposure:secondary, business:main.slice(0,1),accountContext:main.slice(0,1),marriagePartner:[],
                    }, oneLineOverview:fixedFeatureOverview(items) });
            }
            if ('inferredGender' in fields) {
                totals.resolverCalls++;
                const parts = (Array.isArray(input.contents) ? input.contents : [input.contents]).flatMap(c => c.parts);
                const images = parts.flatMap(part => part.inlineData?.data ? [part.inlineData.data] : []);
                const ids = images.map((_,i) => 'resolver-media:' + (i + 1));
                if (!ids.length || !prompt.split('\n').includes('사용 가능한 selectionId: ' + ids.join(', '))) stop('PROMPT_SHAPE');
                const desired = resolverRoutes.get(resolverKey(images));
                if (desired === undefined) stop('UNKNOWN_RESOLVER_INPUT');
                if (desired === null || ids.length < 2) return response({ inferredGender:'unknown',confidence:'low',
                    ownerConsistency:'not_visible',evidenceSelectionIds:[] });
                return response({ inferredGender:desired?'female':'male',confidence:'high',ownerConsistency:'same_person',
                    evidenceSelectionIds:ids.slice(0,2) });
            }
            if (schema.type?.toLowerCase() === 'array' && prompt.includes('candidates(JSON): ')) {
                totals.nameCalls++;
                const rows=z.array(z.object({candidateId:z.string()})).parse(promptData(prompt,'candidates'));
                return response(rows.map(x=>({candidateId:x.candidateId,gender:'unknown',confidence:'low'})));
            }
            if ('persona' in fields || 'companionPattern' in fields || 'lines' in fields) {
                totals.otherCalls++;
                return syntheticGeneration(input);
            }
            return stop('UNSUPPORTED_SCHEMA');
        } catch (error) {
            if (error instanceof Error && /^OFFLINE_STANDARD_VERTEX_[A-Z_]+$/.test(error.message)) throw error;
            return stop('MODEL_INPUT_SHAPE');
        }
    }
    return { generate, counts, reverseScope, imageScope };
}
