import { MAX_TRIAGE_FEED_MEDIA } from '@/lib/domain/analysis/media-policy';
import { aiStagePolicySupports, type AiStagePolicyVersion } from '@/lib/services/ai/stage-policy';

export interface AnalysisV2GenderResolverMedia {
    selectionId: string;
    kind: 'profile' | 'feed';
    postId?: string;
}

export function selectAnalysisV2GenderResolverMedia<
    T extends AnalysisV2GenderResolverMedia,
>(
    media: readonly T[],
    policyVersion?: AiStagePolicyVersion,
): T[] {
    const feedLimit = policyVersion
        && aiStagePolicySupports(policyVersion, 'genderQualityV211')
        ? 8
        : MAX_TRIAGE_FEED_MEDIA;
    const seenSelectionIds = new Set<string>();
    const unique = media.filter(item => {
        if (seenSelectionIds.has(item.selectionId)) return false;
        seenSelectionIds.add(item.selectionId);
        return true;
    });
    const profile = unique.find(item => item.kind === 'profile');
    const feed = unique.filter(item => item.kind === 'feed');
    const representatives: T[] = [];
    const contextsByPost = new Map<string, T[]>();
    const seenPostIds = new Set<string>();
    for (const item of feed) {
        const postKey = item.postId ?? `selection:${item.selectionId}`;
        if (!seenPostIds.has(postKey)) {
            seenPostIds.add(postKey);
            representatives.push(item);
            continue;
        }
        const contexts = contextsByPost.get(postKey) ?? [];
        contexts.push(item);
        contextsByPost.set(postKey, contexts);
    }

    // Preserve the v2.10 representative-first + carousel-context ordering. v2.11 widens only
    // the bounded tail so recurrence and carousel context are both visible.
    const selectedFeed = representatives.slice(0, 2);
    const contextGroups = [...contextsByPost.values()];
    for (let contextIndex = 0; selectedFeed.length < feedLimit; contextIndex++) {
        let appended = false;
        for (const contexts of contextGroups) {
            const context = contexts[contextIndex];
            if (!context || selectedFeed.length >= feedLimit) continue;
            selectedFeed.push(context);
            appended = true;
        }
        if (!appended) break;
    }
    for (const representative of representatives.slice(2)) {
        if (selectedFeed.length >= feedLimit) break;
        selectedFeed.push(representative);
    }
    return [...(profile ? [profile] : []), ...selectedFeed];
}
