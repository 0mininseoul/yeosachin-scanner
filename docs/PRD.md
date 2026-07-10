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
│   │   ├── ai/               # Gemini 종합 분석, 이미지 준비, 응답 검증과 캐시
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
| 개발 호스팅 | Vercel Hobby (개발·비상업 검증 전용) |
| 운영 실행 | Vercel + Google Cloud Tasks OIDC 비동기 step 실행 |
| 백엔드/DB | Supabase |
| Instagram 수집 | 로그인 없는 직접 공개 프로필 + Apify 관계 목록 |
| AI 분석 | Vertex AI Gemini (`gemini-3-flash-preview`, 비용 최적화 모드 선택 가능) |
| 이메일 | Resend |
| 애널리틱스 | Amplitude |

---

## 3. 환경 변수

환경 변수 이름, 기본값과 허용 범위의 단일 기준은 [`.env.example`](../.env.example)입니다. 수집 프로바이더 조합과 실패 동작은 [Instagram 프로바이더 운영 가이드](../lib/services/instagram/README.md)를 따릅니다.

| 범주 | 운영 요구사항 |
|------|---------------|
| 인증/DB | Supabase 프로젝트 키와 카카오·구글 OAuth 자격증명 |
| Instagram 수집 | Apify 토큰, 기능별 `SCRAPER_*` 라우팅, 수동 FlashAPI 진단 시에만 해당 키 |
| AI | Vertex AI 프로젝트·리전과 런타임 서비스 계정, 선택적 품질·동시성 설정 |
| 부가 기능 | Resend, Amplitude, 관리자 전용 프로바이더 override 키 |

---

## 4. 유저 플로우

```
[랜딩] → [로그인] → [애인 ID/성별 입력] → [분석 중] → [결과]
```

입력 완료 시 → 분석 요청 생성 → 진행 화면 이동

---

## 5. 분석 제한

- Basic은 팔로워/팔로잉 각 **500명**, Standard는 각 **1,000명**까지 수집합니다.
- 공개 맞팔 프로필과 AI 분석 대상은 요금제와 무관하게 최대 **350개**입니다.
- 공개 맞팔이 350개를 넘으면 팔로잉 프로바이더가 반환한 순서의 앞 350개를 분석하므로 결과는 전체 공개 맞팔이 아닌 표본입니다.
- 무료 분석 횟수 제한은 `users.analysis_count`와 `is_unlimited`로 제어합니다.

---

## 6. Instagram 수집 설정

| 기능 | 기본 | 자동 폴백 |
|------|------|-----------|
| 단일/배치 공개 프로필 | 로그인 없는 직접 수집 (`selfhosted`) | `apify/instagram-profile-scraper` 1회 |
| 팔로워/팔로잉 목록 | `scraping_solutions/instagram-scraper-followers-following-no-cookies` | 없음 |

Instagram 로그인 쿠키, 사용자 세션, 계정 풀은 사용하지 않습니다. 공개 프로필 작업만 직접 수집 실패 시 Apify를 한 번 시도합니다. 관계 목록은 예상 결과 수의 99% 미만이면 자동 폴백 없이 실패합니다. FlashAPI, CoderX, Stable RapidAPI 어댑터는 운영자 수동 선택 전용입니다. FlashAPI는 라이브 canary에서 팔로워 320/474명, 팔로잉 425/642명만 고유 수집해 합계 완전성이 66.76%였기 때문에 기본 경로와 자동 폴백에서 제외했습니다.

관리자는 `POST /api/analysis/start` 요청에 `Authorization: Bearer <ADMIN_API_KEY>`와 `scraperOptions`를 함께 보내 기능별 프로바이더와 폴백 여부를 해당 작업에만 지정할 수 있습니다. 일반 사용자 요청의 override는 거부됩니다.

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

로그인 세션과 16~128자의 `Idempotency-Key` 헤더가 필수입니다. 같은 사용자가 같은 키와 payload를 재전송하면 쿼터를 다시 차감하지 않고 기존 요청을 반환합니다.

```json
// Request
{ "targetInstagramId": "boyfriend_123", "targetGender": "male" }

// Response (201: 신규, 200: 멱등 재시도)
{ "requestId": "uuid" }
```

관리자 요청은 `Authorization: Bearer <ADMIN_API_KEY>`와 선택적 `scraperOptions`를 추가할 수 있습니다. 같은 idempotency key로 대상, 성별 또는 프로바이더 선택을 바꾸면 `409`를 반환합니다.

현재 API는 `targetGender`의 `male`과 `female`을 모두 허용하지만 결과 후보 필터는 여성 계정으로 고정되어 있습니다. 유료 출시 전 입력을 남성 대상으로 제한하거나 후보 필터를 대상 성별에 맞게 구현하는 계약 결정이 필요합니다.

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

## 9. AI 종합 분석 계약

현행 파이프라인은 프로필 메타데이터와 기본 프로필 이미지 1장 + 게시물 이미지 최대 10장을 하나의 Gemini 요청으로 분석합니다. 프롬프트의 기준은 [`COMBINED_ANALYSIS_PROMPT`](../lib/constants/prompts.ts), 런타임 응답 검증의 기준은 [`combinedAnalysisResponseSchema`](../lib/services/ai/analysis-response-schemas.ts)입니다.

```typescript
type CombinedAnalysisResponse =
  | {
      gender: 'male' | 'unknown';
      genderConfidence: number;
      genderReasoning: string;
    }
  | {
      gender: 'female';
      genderConfidence: number;
      genderReasoning: string;
      ownerIdentified: boolean;
      photogenicGrade: 1 | 2 | 3 | 4 | 5;
      photogenicConfidence: number;
      skinVisibility: 'high' | 'low';
      exposureConfidence: number;
      isMarried: boolean;
      marriedConfidence: number;
      isForeigner: boolean;
      foreignerConfidence: number;
      featureReasoning: string;
    };
```

응답은 strict schema를 통과해야 하며, 성별이 `female`이 아닌 계정은 추가 필드를 허용하지 않습니다. 여성 계정은 성별 신뢰도 0.60 이상만 결과 후보에 포함합니다.

---

## 10. 점수 계산

```typescript
const SCORES = {
  PHOTOGENIC: [20, 40, 60, 80, 100], // Grade 1~5
  EXPOSURE_HIGH: 40,
  TAG: 30,
  INTERACTION: {
    FEMALE_TO_TARGET_LIKES: 35,
    FEMALE_TO_TARGET_COMMENTS: 45, // post당 최대 2개 기여
    TARGET_TO_FEMALE_LIKES: 20,
  },
};

const featureScore = isMarried || isForeigner
  ? 0
  : photogenicScore + exposureScore + tagScore; // 최대 170
const recencyBonus = 20 / mutualOrder; // 최신 맞팔 20, 2번째 10, ... 최대 20
const totalScore = featureScore + recencyBonus + interactionScore; // 최대 290
```

`interactionScore`는 관측된 양의 신호만 정규화한다. 대상 liker는 최근 4 posts에서 150명씩, comments는 최근 6 posts에서 15개씩 교집한다. 관측 여성 중 외모·노출·태그·최근 맞팔 중간점수가 높은 최대 10명만 최근 1 post의 liker 100명을 후속 확인한다. 수집 상한에서 목록에 없음은 0이 아니라 unknown으로 내부 coverage에만 반영한다. 공개 결과에는 interaction component score, coverage, 좋아요·댓글 건수를 노출하지 않고 최종 순위/등급만 제공한다.

### 위험순위 분류

- **≤30명**: 상위 **1명** = 고위험군
- **31~70명**: 상위 **2명** = 고위험군
- **71명+**: 상위 **3명** = 고위험군
- 나머지의 20% = 주의, 80% = 보통

---

## 11. 분석 파이프라인

현행: `/api/analysis/step` (단계별, 재개 가능)
레거시: `/api/analysis/run` (기본 HTTP 410, migration-only 환경변수와 관리자 Bearer가 모두 있을 때만 허용)

운영에서는 Cloud Tasks가 OIDC 서비스 계정으로 step 호출과 재시도를 소유하므로 모바일 페이지 이탈·화면 잠금 뒤에도 분석이 계속됩니다. queue 설정이 없는 로컬 환경만 인증된 진행 페이지가 step을 호출합니다.

```typescript
// 현행 step 기반 파이프라인
async function runStep(requestId, step) {
  switch (step) {
    case 'collect':
      // 프로필 수집 → 팔로워/팔로잉 → 맞팔 → 공개/비공개 분류
      // 비공개 계정 username/full_name은 Gemini 100개 단위 텍스트 배치로 확률 정렬
      break;
    case 'profiles':
      // 현재 캐시 버전의 12시간 프로필 snapshot을 먼저 사용
      // cache miss만 직접 공개 프로필로 수집하고 실패 시 Apify를 1회 호출 (최대 350개)
      break;
    case 'analyze':
      // 기본 프로필 1장 + 게시물 최대 10장을 1024px JPEG로 정규화 (비용 최적화 모드는 3장/384px)
      // 성별 + 포토제닉 + 노출도 + 기혼/해외 여부를 단일 Vertex AI Gemini 호출로 분석
      // 현재 모델/프롬프트/스키마/이미지 정책 버전의 30일 결과 캐시 활용
      break;
    case 'interactions':
      // target: liker 4 posts×150, top-level comments 6 posts×15
      // 중간점수 상위 관측 여성 최대 10명, 최근 1 post×liker 100
      // 일치한 양의 증거만 저장하고 post별 coverage를 보존
      break;
    case 'deep_analysis':
      // 고위험 1~3명만 프로필·bio·피드·방향별 상호작용·댓글 내용을 병렬 Gemini 분석
      // 결과에는 건수/점수/coverage 없이 시니컬한 2문장 총평만 공개
      break;
    case 'finalize':
      // 특징 점수 + 상호작용 점수 계산 및 위험순위 분류
      break;
    case 'completed':
      // 결과 Supabase 저장 + Resend 이메일 발송
      break;
  }
}
```

---

## 12. 운영 데이터와 마이그레이션

| 기능 | 설명 |
|------|------|
| **결과 공유** | share_token 기반 `/share/[token]` 공유 페이지 |
| **AI 분석 캐싱** | 현재 버전의 결과는 30일, 함께 저장한 프로필 snapshot은 기본 12시간 재사용 |
| **토큰/비용/지연 추적** | `gemini_token_usage`에 모델·추론 토큰·비용 추정·호출 지연 저장 |
| **수집 텔레메트리** | `scraper_provider_usage`에 프로바이더, 기대/최소/실제 결과 수, 완전성, 실패 유형, 지연 및 비용 추정 저장 |
| **종합 분석** | 성별·포토제닉·노출도·기혼/해외 여부를 단일 Vertex AI Gemini 호출로 처리 ([`combined-analysis.ts`](../lib/services/ai/combined-analysis.ts)) |
| **단계별 파이프라인** | Cloud Tasks OIDC 호출과 lease로 재개 가능한 분석 구조 |
| **상호작용 수집** | server-only job/evidence/score table, 최대 10명/10 posts 배치, 양의 일치와 coverage는 내부 점수에만 반영 |
| **비공개 이름 정렬** | username/full_name만 100개 단위 텍스트 배치로 분석하며 실제 성별이 아닌 확률 순서로 표시 |

운영 분석을 활성화하기 전에 `007`~`010` 이후 모든 `20260710*` migration을 적용합니다. 최종 사용자는 owner-scoped SELECT만 가능하며 분석 요청 생성·변경과 상호작용 원본 staging은 service role만 담당합니다.
