-- 001_initial_schema.sql
-- AI 바람감지기 MVP 초기 스키마

-- UUID 확장 활성화
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. 사용자 테이블
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    provider VARCHAR(50) NOT NULL,  -- 'google' | 'kakao'
    analysis_count INTEGER DEFAULT 0,
    is_paid_user BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. 분석 요청 테이블
CREATE TABLE analysis_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_instagram_id VARCHAR(100) NOT NULL,
    target_gender VARCHAR(10) NOT NULL CHECK (target_gender IN ('male', 'female')),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    progress_step VARCHAR(100),  -- 현재 진행 단계 설명
    total_followers INTEGER,
    mutual_follows INTEGER,
    opposite_gender_count INTEGER,
    confidence_score FLOAT,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    completed_at TIMESTAMP WITH TIME ZONE
);

-- 3. 분석 결과 테이블
CREATE TABLE analysis_results (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id UUID NOT NULL REFERENCES analysis_requests(id) ON DELETE CASCADE,
    rank INTEGER NOT NULL,  -- 1위, 2위, ...
    suspect_instagram_id VARCHAR(100) NOT NULL,
    suspect_profile_image TEXT,
    risk_score INTEGER NOT NULL DEFAULT 0,
    
    -- 상호작용 카운트
    likes_count INTEGER DEFAULT 0,
    normal_comments_count INTEGER DEFAULT 0,
    intimate_comments_count INTEGER DEFAULT 0,
    replies_count INTEGER DEFAULT 0,
    post_tags_count INTEGER DEFAULT 0,
    caption_mentions_count INTEGER DEFAULT 0,
    comment_mentions_count INTEGER DEFAULT 0,
    
    -- AI 분석 결과
    attractiveness_level VARCHAR(10) CHECK (attractiveness_level IN ('high', 'medium', 'low')),
    attractiveness_score INTEGER DEFAULT 0,
    gender_confidence FLOAT,
    
    -- 기간 및 급증 분석
    first_interaction_date TIMESTAMP WITH TIME ZONE,
    duration_months INTEGER,
    is_recent_surge BOOLEAN DEFAULT FALSE,
    surge_percentage FLOAT,
    
    -- 결과 공개 상태
    is_unlocked BOOLEAN DEFAULT FALSE,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. 댓글 상세 테이블
CREATE TABLE comment_details (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    result_id UUID NOT NULL REFERENCES analysis_results(id) ON DELETE CASCADE,
    comment_text TEXT NOT NULL,
    author_id VARCHAR(100) NOT NULL,
    target_post_owner VARCHAR(100) NOT NULL,
    intimacy_level VARCHAR(10) CHECK (intimacy_level IN ('intimate', 'normal')),
    intimacy_indicators TEXT[],
    confidence FLOAT,
    comment_date TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. 상호작용 로그 테이블
CREATE TABLE interaction_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    result_id UUID NOT NULL REFERENCES analysis_results(id) ON DELETE CASCADE,
    interaction_type VARCHAR(20) NOT NULL CHECK (interaction_type IN ('like', 'comment', 'reply', 'post_tag', 'caption_mention', 'comment_mention')),
    post_id VARCHAR(100),
    content TEXT,
    interaction_date TIMESTAMP WITH TIME ZONE,
    score INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. 비공개 계정 테이블
CREATE TABLE private_accounts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id UUID NOT NULL REFERENCES analysis_requests(id) ON DELETE CASCADE,
    instagram_id VARCHAR(100) NOT NULL,
    profile_image TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 인덱스 생성
CREATE INDEX idx_analysis_requests_user_id ON analysis_requests(user_id);
CREATE INDEX idx_analysis_requests_status ON analysis_requests(status);
CREATE INDEX idx_analysis_results_request_id ON analysis_results(request_id);
CREATE INDEX idx_analysis_results_rank ON analysis_results(rank);
CREATE INDEX idx_comment_details_result_id ON comment_details(result_id);
CREATE INDEX idx_interaction_logs_result_id ON interaction_logs(result_id);
CREATE INDEX idx_private_accounts_request_id ON private_accounts(request_id);

-- RLS (Row Level Security) 활성화
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_accounts ENABLE ROW LEVEL SECURITY;

-- RLS 정책: 사용자는 자신의 데이터만 접근 가능
CREATE POLICY "Users can view own data" ON users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can view own analysis requests" ON analysis_requests
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can view own analysis results" ON analysis_results
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM analysis_requests 
            WHERE analysis_requests.id = analysis_results.request_id 
            AND analysis_requests.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can view own comment details" ON comment_details
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM analysis_results
            JOIN analysis_requests ON analysis_requests.id = analysis_results.request_id
            WHERE analysis_results.id = comment_details.result_id
            AND analysis_requests.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can view own interaction logs" ON interaction_logs
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM analysis_results
            JOIN analysis_requests ON analysis_requests.id = analysis_results.request_id
            WHERE analysis_results.id = interaction_logs.result_id
            AND analysis_requests.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can view own private accounts" ON private_accounts
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM analysis_requests 
            WHERE analysis_requests.id = private_accounts.request_id 
            AND analysis_requests.user_id = auth.uid()
        )
    );

-- Realtime 활성화 (분석 진행 상황 실시간 업데이트)
ALTER PUBLICATION supabase_realtime ADD TABLE analysis_requests;

-- 업데이트 시 updated_at 자동 갱신 트리거
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
