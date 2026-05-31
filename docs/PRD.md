# AI 위장 여사친 판독기 MVP - PRD

## 📋 개요

AI가 남자친구의 인스타그램 맞팔 중 위장 여사친을 찾아주는 서비스의 MVP 기술 명세서입니다.

---

## 1. 프로젝트 구조

```
ai-baram-detector/
├── app/
│   ├── page.tsx                      # 랜딩 페이지
│   ├── login/page.tsx                # 로그인
│   ├── analyze/page.tsx              # 분석 입력
│   ├── progress/[requestId]/page.tsx # 분석 진행
│   ├── result/[requestId]/page.tsx   # 결과 리포트
│   ├── mypage/page.tsx               # 마이페이지
│   ├── share/[token]/                # 결과 공유
│   ├── privacy/page.tsx              # 개인정보처리방침
│   ├── terms/page.tsx                # 이용약관
│   └── api/
│       ├── analysis/
│       │   ├── start/
│       │   ├── run/          # 레거시 파이프라인
│       │   ├── step/         # 현행 단계별 파이프라인
│       │   ├── status/[requestId]/
│       │   └── result/[requestId]/
├── lib/
│   ├── supabase/
│   ├── services/
│   │   ├── instagram/
│   │   ├── ai/               # gender, photogenic, exposure, intimacy, combined
│   │   ├── analysis/
│   │   ├── email.ts          # Resend
│   │   └── analytics.ts      # Amplitude
│   ├── types/
│   └── constants/            # scoring.ts, prompts.ts
├── components/
│   └── email-template.tsx
├── hooks/
└── supabase/migrations/
```

---

## 2. 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | Next.js 16, Tailwind CSS 4 |
| 배포 | Vercel (Free) |
| 백엔드/DB | Supabase |
| 스크래핑 | Apify + RapidAPI |
| AI 분석 | Vertex AI Gemini (`gemini-3-flash-preview`) |
| 이메일 | Resend |
| 애널리틱스 | Amplitude |

---

## 3. 환경 변수

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
APIFY_API_TOKEN=
RAPIDAPI_KEY=
RAPIDAPI_HOST=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=global
GOOGLE_GENAI_USE_VERTEXAI=true
VERTEX_AI_MODEL=gemini-3-flash-preview
GOOGLE_APPLICATION_CREDENTIALS=
GOOGLE_SERVICE_ACCOUNT_KEY_BASE64=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
NEXT_PUBLIC_AMPLITUDE_API_KEY=
```

---

## 4. 유저 플로우

```
[랜딩] → [로그인] → [애인 ID/성별 입력] → [분석 중] → [결과]
```

입력 완료 시 → 분석 요청 생성 → 진행 화면 이동

---

## 5. 분석 제한

- 기본 분석은 팔로워/팔로잉 각 **500명** 기준으로 처리합니다.
- 무료 분석 횟수 제한은 `users.analysis_count`와 `is_unlimited`로 제어합니다.

---

## 6. 스크래퍼 설정

| 용도 | Actor | 비고 |
|------|-------|------|
| 팔로워 수집 | `datadoping/instagram-followers-scraper` | |
| 팔로잉 수집 | RapidAPI Instagram Scraper | 개인 Instagram 쿠키 미사용 |
| 프로필/매일 트래킹 | `apify/instagram-profile-scraper` | |

---

## 7. DB 스키마

```sql
-- 분석 결과 확장
ALTER TABLE analysis_results 
ADD COLUMN bio TEXT,
ADD COLUMN photogenic_grade INTEGER CHECK (photogenic_grade BETWEEN 1 AND 5),
ADD COLUMN exposure_level VARCHAR(10) CHECK (exposure_level IN ('high', 'low')),
ADD COLUMN is_tagged BOOLEAN DEFAULT FALSE,
ADD COLUMN risk_grade VARCHAR(20) CHECK (risk_grade IN ('high_risk', 'caution', 'normal')),
ADD COLUMN gender_status VARCHAR(20) CHECK (gender_status IN ('confirmed', 'suspected', 'unknown'));
```

---

## 8. API 명세

### 8.1 분석 요청 생성

#### POST `/api/analysis/start`
```json
// Request
{ "targetInstagramId": "boyfriend_123", "targetGender": "male" }

// Response (201)
{ "requestId": "uuid" }
```

### 8.2 결과 조회

#### GET `/api/analysis/result/[requestId]`
```json
{
  "summary": {
    "targetInstagramId": "boyfriend_123",
    "mutualFollows": 152,
    "genderRatio": {
      "male": { "count": 87, "percentage": 57 },
      "female": { "count": 47, "percentage": 31 },
      "unknown": { "count": 18, "percentage": 12 }
    }
  },
  "femaleAccounts": [
    {
      "instagramId": "user_1",
      "profileImage": "https://...",
      "instagramUrl": "https://instagram.com/user_1",
      "riskGrade": "high_risk",
      "bio": "21 | Seoul"
    }
  ],
  "privateAccounts": [...]
}
```

> 유저에게 표시: 프로필 이미지, 아이디(링크), 위험순위 Grade, bio

---

## 9. AI 프롬프트

### 9.1 성별 판단

```typescript
export const GENDER_ANALYSIS_PROMPT = `
당신은 인스타그램 계정의 성별을 판단하는 AI입니다.

## 분석 대상 정보
- 프로필 사진: {profileImageDescription}
- 사용자명: {username}
- 표시 이름: {fullName}
- 바이오: {bio}
- 최근 피드 이미지: {feedImagesDescription}

## 응답 형식 (JSON)
{ "gender": "male" | "female" | "unknown", "confidence": 0.0~1.0, "reasoning": "판단 근거" }

## 신뢰도 기준
- ≥ 0.80 → 확정
- 0.60 ~ 0.80 → 의심
- < 0.60 → 판단불가
`;
```

### 9.2 Photogenic Quality 분석

```typescript
export const PHOTOGENIC_ANALYSIS_PROMPT = `
당신은 미디어 이미지 분석 전문가입니다.
이미지 속 인물의 "Photogenic Quality (포토제닉 지수)"를 평가합니다.

## 평가 기준
- 얼굴의 조화로움과 균형감
- 표정에서 느껴지는 호감도
- 전체적인 외적 인상
- 사진 속 시각적 존재감

## 응답 형식 (JSON)
{ "ownerIdentified": true|false, "photogenicGrade": 1~5, "confidence": 0.0~1.0, "reasoning": "판단 근거" }

## Grade 기준
5: 매우 높은 시각적 매력 | 4: 평균 이상 | 3: 보통 | 2: 평균 이하 | 1: 판단 어려움
`;
```

### 9.3 노출 정도 분석

```typescript
export const EXPOSURE_ANALYSIS_PROMPT = `
당신은 패션 이미지 분석 전문가입니다.
이미지에서 인물의 의상 커버리지(Clothing Coverage Level)를 분석합니다.

## 평가 기준
의상으로 덮이지 않은 피부 면적 비율을 평가합니다.

## 응답 형식 (JSON)
{ "ownerIdentified": true|false, "skinVisibility": "high"|"low", "confidence": 0.0~1.0, "reasoning": "판단 근거" }

## 분류 기준
- high: 피부 가시 면적이 넓음 (민소매, 반바지, 비키니, 크롭탑 등)
- low: 피부 가시 면적이 적음 (긴팔, 긴바지, 정장 등)
`;
```

---

## 10. 점수 계산

```typescript
const SCORES = {
  PHOTOGENIC: [20, 40, 60, 80, 100], // Grade 1~5
  EXPOSURE_HIGH: 40,
  TAG: 30,
};

// 최대 170점
const totalScore = photogenicScore + exposureScore + tagScore;
```

### 위험순위 분류

- **≤30명**: 상위 **1명** = 고위험군
- **31~70명**: 상위 **2명** = 고위험군
- **71명+**: 상위 **3명** = 고위험군
- 나머지의 20% = 주의, 80% = 보통

---

## 11. 분석 파이프라인

현행: `/api/analysis/step` (단계별, 재개 가능)
레거시: `/api/analysis/run` (단일 패스)

```typescript
// 현행 step 기반 파이프라인
async function runStep(requestId, step) {
  switch (step) {
    case 'collect':
      // 프로필 수집 → 팔로워/팔로잉 수집 → 맞팔 추출 → 공개/비공개 분류
      break;
    case 'profiles':
      // 공개 계정 프로필 배치 수집 (apify/instagram-profile-scraper, 최대 350개)
      break;
    case 'analyze':
      // 종합 AI 분석 (성별 + 외모 + 노출도 + 친밀도) - 단일 Vertex AI Gemini 호출
      // ai_analysis_cache 활용 (이미 분석된 계정 스킵)
      break;
    case 'finalize':
      // 위험도 점수 계산 및 위험순위 분류
      break;
    case 'completed':
      // 결과 Supabase 저장 + Resend 이메일 발송
      break;
  }
}
```

---

## 12. 추가 구현 기능 (MVP 이후)

| 기능 | 설명 |
|------|------|
| **결과 공유** | share_token 기반 `/share/[token]` 공유 페이지 |
| **AI 분석 캐싱** | `ai_analysis_cache` 테이블로 동일 계정 재분석 스킵 |
| **토큰 사용 추적** | `gemini_token_usage` 테이블로 API 비용 모니터링 |
| **종합 분석** | 성별/외모/노출도/친밀도를 단일 Vertex AI Gemini 호출로 처리 (`combined-analysis.ts`) |
| **단계별 파이프라인** | step 기반으로 재개 가능한 분석 구조 |

---

## 변경 이력

| 버전 | 날짜 | 변경 |
|------|------|------|
| 1.0 | 2025-01-22 | 초안 |
| 2.0 | 2026-01-29 | 전면 재설계 |
| 2.1 | 2026-01-29 | 유저 플로우, 요금제(500/1000), 외모 표현 제거, 파이프라인 순서 |
| 2.2 | 2026-01-29 | 고위험군 10명/10%로 변경, 팔로잉 스크래퍼 방식 정리 |
| 2.3 | 2026-02-24 | 서비스명 변경, 프로젝트 구조 업데이트, step 파이프라인/캐싱/공유 기능 반영 |
| 2.4 | 2026-02-25 | 고위험군 인원수 변경: ≤30명→1명, 31~70명→2명, 71명+→3명 |
