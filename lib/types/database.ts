// 데이터베이스 타입 정의

export interface User {
    id: string;
    email: string;
    provider: 'google' | 'kakao';
    analysis_count: number;
    is_paid_user: boolean;
    is_unlimited: boolean;
    created_at: string;
    updated_at: string;
}

export interface AnalysisRequest {
    id: string;
    user_id: string;
    target_instagram_id: string;
    target_gender: 'male' | 'female';
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progress_step?: string;
    total_followers?: number;
    mutual_follows?: number;
    opposite_gender_count?: number;
    confidence_score?: number;
    error_message?: string;
    created_at: string;
    completed_at?: string;
}

export interface AnalysisResult {
    id: string;
    request_id: string;
    rank: number;
    suspect_instagram_id: string;
    suspect_profile_image?: string;
    suspect_full_name?: string;
    risk_score: number;

    // 상호작용 카운트
    likes_count: number;
    normal_comments_count: number;
    intimate_comments_count: number;
    replies_count: number;
    post_tags_count: number;
    caption_mentions_count: number;
    comment_mentions_count: number;

    // AI 분석 결과
    attractiveness_level?: 'high' | 'medium' | 'low';
    attractiveness_score: number;
    gender_confidence?: number;

    // 기간 및 급증 분석
    first_interaction_date?: string;
    duration_months?: number;
    is_recent_surge: boolean;
    surge_percentage?: number;

    // 결과 공개 상태
    is_unlocked: boolean;

    created_at: string;
}

export interface CommentDetail {
    id: string;
    result_id: string;
    comment_text: string;
    author_id: string;
    target_post_owner: string;
    intimacy_level: 'intimate' | 'normal';
    intimacy_indicators: string[];
    confidence: number;
    comment_date?: string;
    created_at: string;
}

export interface InteractionLog {
    id: string;
    result_id: string;
    interaction_type: 'like' | 'comment' | 'reply' | 'post_tag' | 'caption_mention' | 'comment_mention';
    post_id?: string;
    content?: string;
    interaction_date?: string;
    score: number;
    created_at: string;
}

export interface PrivateAccount {
    id: string;
    request_id: string;
    instagram_id: string;
    profile_image?: string;
    full_name?: string;
    created_at: string;
}
