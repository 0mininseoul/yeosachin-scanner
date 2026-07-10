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
    idempotency_key?: string;
    background_processing: boolean;
    processing_lease_token?: string;
    processing_lease_expires_at?: string;
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
    interaction_score: number;
    interaction_coverage: number;
    interaction_coverage_status: 'high' | 'medium' | 'low';
    female_to_target_likes_count: number;
    female_to_target_comments_count: number;
    target_to_female_likes_count: number;
    recency_bonus: number;
    risk_analysis: string[];

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
    name_female_score?: number;
    name_is_name?: boolean;
    name_confidence?: number;
    created_at: string;
}

export interface ScraperProviderUsage {
    id: string;
    request_id?: string;
    provider: 'apify' | 'coderx' | 'flashapi' | 'rapidapi' | 'selfhosted';
    capability: 'profile' | 'profilesBatch' | 'followers' | 'following';
    request_count: number;
    result_count: number;
    raw_result_count: number;
    unique_result_count: number;
    unique_ratio: number;
    fallback: boolean;
    latency_ms: number;
    status: 'success' | 'error';
    expected_result_count?: number;
    minimum_complete_count?: number;
    coverage_ratio?: number;
    failure_category?: 'configuration' | 'schema' | 'incomplete' | 'budget' | 'timeout' | 'provider';
    estimated_cost_usd: number;
    rate_limit_limit?: number;
    rate_limit_remaining?: number;
    created_at: string;
}
