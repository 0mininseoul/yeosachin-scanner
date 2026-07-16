// 인스타그램 관련 타입 정의

export interface InstagramProfile {
    username: string;
    fullName?: string;
    bio?: string;
    externalUrl?: string; // 프로필 링크 (bio가 없을 때 대체용)
    profilePicUrl?: string;
    followersCount: number;
    followingCount: number;
    postsCount: number;
    isPrivate: boolean;
    isVerified: boolean;
    latestPosts?: InstagramPost[]; // profile scraper에서 함께 반환
}

export type InstagramPostMediaType = 'image' | 'video' | 'reel';

export interface InstagramPostMediaItem {
    id?: string;
    type: InstagramPostMediaType;
    caption?: string;
    imageUrl?: string;
    thumbnailUrl?: string;
    videoUrl?: string;
}

export interface InstagramPost {
    id: string;
    shortCode: string;
    caption?: string;
    hashtags?: string[]; // 스크래퍼에서 제공하는 해시태그 배열
    imageUrl?: string;
    thumbnailUrl?: string;
    videoUrl?: string;
    type: 'image' | 'video' | 'carousel' | 'reel';
    mediaItems?: InstagramPostMediaItem[];
    declaredMediaCount?: number;
    childrenComplete?: boolean;
    likesCount: number;
    commentsCount: number;
    timestamp: string;
    taggedUsers: string[];
    mentionedUsers: string[];
}

export interface InstagramComment {
    id: string;
    text: string;
    ownerUsername: string;
    timestamp: string;
    likesCount: number;
    replies?: InstagramComment[];
}

export interface InstagramFollower {
    username: string;
    fullName?: string;
    profilePicUrl?: string;
    isPrivate: boolean;
    isVerified: boolean;
}

// 맞팔 계정 (분석 대상)
export interface MutualFollow extends InstagramFollower {
    // AI 분석 결과
    gender?: 'male' | 'female' | 'unknown';
    genderConfidence?: number;
}

// 상호작용 데이터
export interface InteractionData {
    targetUsername: string;  // 분석 대상 (애인)
    suspectUsername: string; // 위험 인물 후보

    // 좋아요
    likesFromTarget: number;  // 애인 → 용의자 게시물
    likesFromSuspect: number; // 용의자 → 애인 게시물

    // 댓글
    commentsFromTarget: InstagramComment[];
    commentsFromSuspect: InstagramComment[];

    // 태그/언급
    postTagsFromTarget: number;
    postTagsFromSuspect: number;
    captionMentionsFromTarget: number;
    captionMentionsFromSuspect: number;

    // 기간 분석용
    firstInteractionDate?: string;
    recentInteractionDates: string[];
}
