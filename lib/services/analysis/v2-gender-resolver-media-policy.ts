import { MAX_TRIAGE_FEED_MEDIA } from '@/lib/domain/analysis/media-policy';

export interface AnalysisV2GenderResolverMedia {
    selectionId: string;
    kind: 'profile' | 'feed';
    postId?: string;
}

export function selectAnalysisV2GenderResolverMedia<
    T extends AnalysisV2GenderResolverMedia,
>(media: readonly T[]): T[] {
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

    const selectedFeed = representatives.slice(0, 2);
    const contextGroups = [...contextsByPost.values()];
    for (let contextIndex = 0; selectedFeed.length < MAX_TRIAGE_FEED_MEDIA; contextIndex++) {
        let appended = false;
        for (const contexts of contextGroups) {
            const context = contexts[contextIndex];
            if (!context || selectedFeed.length >= MAX_TRIAGE_FEED_MEDIA) continue;
            selectedFeed.push(context);
            appended = true;
        }
        if (!appended) break;
    }
    for (const representative of representatives.slice(2)) {
        if (selectedFeed.length >= MAX_TRIAGE_FEED_MEDIA) break;
        selectedFeed.push(representative);
    }
    return [...(profile ? [profile] : []), ...selectedFeed];
}
