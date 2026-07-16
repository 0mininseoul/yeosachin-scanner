import { createHash } from 'node:crypto';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import { extractInstagramMentions } from '@/lib/services/instagram/username';
import {
    MAX_CAROUSEL_MEDIA,
    MAX_PARTNER_SAFETY_CONTACT_MEDIA,
    type SelectedAnalysisMedia,
} from './media-policy';

const DOSSIER_CHARACTER_LIMIT = 2_000;
const MIN_CANONICAL_CAROUSEL_ITEMS = 3;

export type CarouselCaptionEvidence = Readonly<{
    evidenceRefId: string;
    selectionId: string;
    text: string;
}>;

export interface CarouselCaptionPolicy {
    featureCaptions: CarouselCaptionEvidence[];
    partnerCaptions: CarouselCaptionEvidence[];
    dossier: Readonly<{ evidenceRefId: string; text: string }> | null;
}

type CaptionPolicyInput = Readonly<{
    targetUsername: string;
    profile: Pick<InstagramProfile, 'username' | 'latestPosts'>;
    featureSelections: readonly SelectedAnalysisMedia[];
    partnerSelections: readonly SelectedAnalysisMedia[];
}>;

interface SlideCaption {
    mediaIndex: number;
    text: string;
}

function normalizeCaption(value: string | undefined): string | null {
    const normalized = value?.normalize('NFKC').replace(/\s+/g, ' ').trim();
    return normalized || null;
}

function digest(domain: string, value: unknown): string {
    return createHash('sha256')
        .update(`${domain}\n${JSON.stringify(value)}`, 'utf8')
        .digest('hex');
}

function captionEvidence(input: {
    profileUsername: string;
    postId: string;
    mediaIndex: number | null;
    selectionId: string;
    text: string;
}): CarouselCaptionEvidence {
    return Object.freeze({
        evidenceRefId: `caption:${digest('carousel-caption-evidence-v1', {
            username: input.profileUsername.toLowerCase(),
            postId: input.postId,
            mediaIndex: input.mediaIndex,
            text: input.text,
        }).slice(0, 48)}`,
        selectionId: input.selectionId,
        text: input.text,
    });
}

function postMap(profile: CaptionPolicyInput['profile']): ReadonlyMap<string, InstagramPost> {
    return new Map((profile.latestPosts ?? []).map(post => [post.id, post]));
}

function selectedCaption(
    post: InstagramPost,
    selection: SelectedAnalysisMedia
): { mediaIndex: number | null; parentFallback: boolean; text: string } | null {
    if (selection.mediaIndex !== undefined) {
        const childCaption = normalizeCaption(post.mediaItems?.[selection.mediaIndex]?.caption);
        if (childCaption) {
            return {
                mediaIndex: selection.mediaIndex,
                parentFallback: false,
                text: childCaption,
            };
        }
    }
    const parentCaption = normalizeCaption(post.caption);
    return parentCaption ? {
        mediaIndex: selection.mediaIndex ?? null,
        parentFallback: true,
        text: parentCaption,
    } : null;
}

function featureCaptionEvidence(
    input: CaptionPolicyInput,
    posts: ReadonlyMap<string, InstagramPost>
): CarouselCaptionEvidence[] {
    const parentFallbackPosts = new Set<string>();
    const captions: CarouselCaptionEvidence[] = [];
    for (const selection of input.featureSelections) {
        if (!selection.postId) continue;
        const post = posts.get(selection.postId);
        if (!post) continue;
        const selected = selectedCaption(post, selection);
        if (!selected) continue;
        if (selected.parentFallback) {
            if (parentFallbackPosts.has(post.id)) continue;
            parentFallbackPosts.add(post.id);
        }
        captions.push(captionEvidence({
            profileUsername: input.profile.username,
            postId: post.id,
            mediaIndex: selected.mediaIndex,
            selectionId: selection.selectionId,
            text: selected.text,
        }));
    }
    return captions;
}

function canonicalCompleteCarousel(post: InstagramPost | undefined): post is InstagramPost {
    if (
        !post
        || post.type !== 'carousel'
        || post.childrenComplete !== true
        || !Array.isArray(post.mediaItems)
        || post.mediaItems.length < MIN_CANONICAL_CAROUSEL_ITEMS
        || post.mediaItems.length > MAX_CAROUSEL_MEDIA
        || post.declaredMediaCount === undefined
        || post.declaredMediaCount < MIN_CANONICAL_CAROUSEL_ITEMS
        || post.declaredMediaCount > MAX_CAROUSEL_MEDIA
    ) {
        return false;
    }
    return post.declaredMediaCount === post.mediaItems.length;
}

function selectedCarousel(
    input: CaptionPolicyInput,
    posts: ReadonlyMap<string, InstagramPost>
): InstagramPost | null {
    const contextSelection = input.featureSelections.find(selection => (
        selection.role === 'carousel_context'
        && selection.postId !== undefined
        && canonicalCompleteCarousel(posts.get(selection.postId))
    ));
    if (contextSelection?.postId) return posts.get(contextSelection.postId) ?? null;

    const partnerSelection = input.partnerSelections.find(selection => (
        selection.role === 'partner_safety_contact'
        && selection.postId !== undefined
        && canonicalCompleteCarousel(posts.get(selection.postId))
    ));
    return partnerSelection?.postId ? posts.get(partnerSelection.postId) ?? null : null;
}

function partnerCaptionEvidence(
    input: CaptionPolicyInput,
    carousel: InstagramPost | null
): CarouselCaptionEvidence[] {
    if (!carousel) return [];
    const captions: CarouselCaptionEvidence[] = [];
    for (const selection of input.partnerSelections) {
        if (
            selection.role !== 'partner_safety_contact'
            || selection.postId !== carousel.id
            || selection.mediaIndex === undefined
        ) {
            continue;
        }
        const text = normalizeCaption(carousel.mediaItems?.[selection.mediaIndex]?.caption);
        if (!text) continue;
        captions.push(captionEvidence({
            profileUsername: input.profile.username,
            postId: carousel.id,
            mediaIndex: selection.mediaIndex,
            selectionId: selection.selectionId,
            text,
        }));
        if (captions.length === MAX_PARTNER_SAFETY_CONTACT_MEDIA) break;
    }
    return captions;
}

function uniqueSlideCaptions(carousel: InstagramPost): SlideCaption[] {
    const seen = new Set<string>();
    const captions: SlideCaption[] = [];
    for (const [mediaIndex, item] of (carousel.mediaItems ?? []).entries()) {
        const text = normalizeCaption(item.caption);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        captions.push({ mediaIndex, text });
    }
    return captions;
}

function exactMention(text: string, targetUsername: string): boolean {
    const username = targetUsername
        .normalize('NFKC')
        .trim()
        .replace(/^@/, '')
        .toLowerCase();
    if (!username) return false;
    return extractInstagramMentions(text).includes(username);
}

function excerpt(text: string, allocation: number): string {
    if (text.length <= allocation) return text;
    if (allocation <= 3) return text.slice(0, allocation);
    return `${text.slice(0, allocation - 3)}...`;
}

function packDossier(slides: readonly SlideCaption[], targetUsername: string): string {
    const labels = slides.map(slide => `[슬라이드 ${slide.mediaIndex + 1}] `);
    const separatorCharacters = Math.max(0, slides.length - 1);
    const availableCharacters = DOSSIER_CHARACTER_LIMIT
        - labels.reduce((sum, label) => sum + label.length, 0)
        - separatorCharacters;
    if (availableCharacters < slides.length) {
        throw new Error('CAROUSEL_CAPTION_POLICY_BUDGET_TOO_SMALL');
    }

    const fullLength = slides.reduce((sum, slide) => sum + slide.text.length, 0);
    if (fullLength <= availableCharacters) {
        return slides.map((slide, index) => `${labels[index]}${slide.text}`).join('\n');
    }

    const fairShare = Math.floor(availableCharacters / slides.length);
    const allocations = slides.map(slide => Math.min(slide.text.length, fairShare));
    let remaining = availableCharacters
        - allocations.reduce((sum, allocation) => sum + allocation, 0);
    const priority = slides
        .map((slide, index) => ({
            index,
            mediaIndex: slide.mediaIndex,
            mentionsTarget: exactMention(slide.text, targetUsername),
        }))
        .sort((left, right) => (
            Number(right.mentionsTarget) - Number(left.mentionsTarget)
            || left.mediaIndex - right.mediaIndex
        ));
    for (const item of priority) {
        if (remaining === 0) break;
        const capacity = slides[item.index].text.length - allocations[item.index];
        const granted = Math.min(capacity, remaining);
        allocations[item.index] += granted;
        remaining -= granted;
    }

    const packed = slides.map((slide, index) => (
        `${labels[index]}${excerpt(slide.text, allocations[index])}`
    )).join('\n');
    if (packed.length > DOSSIER_CHARACTER_LIMIT) {
        throw new Error('CAROUSEL_CAPTION_POLICY_BUDGET_DRIFT');
    }
    return packed;
}

function dossier(
    input: CaptionPolicyInput,
    carousel: InstagramPost | null
): CarouselCaptionPolicy['dossier'] {
    if (!carousel) return null;
    const slides = uniqueSlideCaptions(carousel);
    if (slides.length === 0) return null;
    const text = packDossier(slides, input.targetUsername);
    return Object.freeze({
        evidenceRefId: `carousel-dossier:${digest('carousel-caption-dossier-v1', {
            username: input.profile.username.toLowerCase(),
            postId: carousel.id,
            text,
        })}`,
        text,
    });
}

export function buildCarouselCaptionPolicy(
    input: CaptionPolicyInput
): Readonly<CarouselCaptionPolicy> {
    const posts = postMap(input.profile);
    const carousel = selectedCarousel(input, posts);
    return Object.freeze({
        featureCaptions: featureCaptionEvidence(input, posts),
        partnerCaptions: partnerCaptionEvidence(input, carousel),
        dossier: dossier(input, carousel),
    });
}
