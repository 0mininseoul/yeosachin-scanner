# AI 위장 여사친 판독기

AI가 남자친구의 인스타그램 맞팔 중 위장 여사친을 찾아주는 서비스

## 프로젝트 개요

| 항목 | 내용 |
|------|------|
| **서비스명** | AI 위장 여사친 판독기 |
| **한 줄 소개** | AI가 남자친구의 인스타그램 맞팔 중 위장 여사친을 찾아드립니다 |
| **타겟 유저** | 20대 여성, 연애 중, SNS 활발 사용 |
| **핵심 가치** | 공개된 정보만으로 연인 관계의 불안 해소 (재미 목적) |

## 기술 스택

| 영역 | 기술 | 버전/플랜 |
|------|------|----------|
| 프레임워크 | Next.js (App Router) | 16.2.6 |
| UI | React + TypeScript | 19.2.3 / 5.x |
| 스타일링 | Tailwind CSS | 4.x |
| 배포 | Vercel | Free |
| 백엔드/DB | Supabase (Auth, DB, Realtime) | Hobby (Free) |
| 인스타 스크래핑 | Apify + RapidAPI | Apify Free / RapidAPI |
| AI 분석 | Vertex AI Gemini | Google Cloud |
| 이메일 발송 | Resend | Free (100/일) |
| 애널리틱스 | Amplitude | Free |

## 시작하기

### 1. 환경 변수 설정

`.env.example`을 복사하여 `.env.local` 파일을 생성하고 필요한 값을 입력합니다:

```bash
cp .env.example .env.local
```

필수 환경 변수:
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase 프로젝트 URL
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Supabase Anon Key
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase Service Role Key
- `APIFY_API_TOKEN` - Apify API 토큰
- `RAPIDAPI_KEY` - RapidAPI Instagram Scraper API 키
- `RAPIDAPI_HOST` - RapidAPI Instagram Scraper 호스트
- `GOOGLE_CLOUD_PROJECT` - Vertex AI가 활성화된 Google Cloud 프로젝트 ID
- `GOOGLE_CLOUD_LOCATION` - Vertex AI 리전 (`global` 권장)
- `VERTEX_AI_MODEL` - 사용할 Gemini 모델명
- `GOOGLE_APPLICATION_CREDENTIALS` - 로컬 개발용 서비스 계정 JSON 경로
- `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` - Vercel 배포용 서비스 계정 JSON base64 값
- `RESEND_API_KEY` - Resend API 키
- `NEXT_PUBLIC_AMPLITUDE_API_KEY` - Amplitude API 키

### 2. 의존성 설치

```bash
npm install
```

### 3. Supabase 설정

```bash
# Supabase CLI 로그인
npx supabase login

# 로컬 Supabase 시작 (선택사항)
npx supabase start

# 마이그레이션 적용
npx supabase db push
```

### 4. 개발 서버 실행

```bash
npm run dev
```

[http://localhost:3000](http://localhost:3000)에서 확인할 수 있습니다.

## 프로젝트 구조

```
ai-baram-detector/
├── app/                          # Next.js App Router 페이지 & API
│   ├── page.tsx                  # 홈/랜딩 페이지
│   ├── login/page.tsx            # 로그인 페이지 (카카오/구글)
│   ├── analyze/page.tsx          # 분석 입력 페이지
│   ├── progress/[requestId]/     # 분석 진행 상황 페이지
│   ├── result/[requestId]/       # 결과 리포트 페이지
│   ├── mypage/page.tsx           # 마이페이지
│   ├── share/[token]/            # 결과 공유 페이지
│   ├── privacy/page.tsx          # 개인정보처리방침
│   ├── terms/page.tsx            # 이용약관
│   ├── auth/callback/route.ts    # OAuth 콜백
│   └── api/
│       ├── analysis/             # 분석 API
│       │   ├── start/route.ts    # 분석 요청 시작
│       │   ├── run/route.ts      # 분석 파이프라인 실행 (레거시)
│       │   ├── step/route.ts     # 단계별 분석 실행 (현행)
│       │   ├── status/[requestId]/   # 진행 상태 조회
│       │   └── result/[requestId]/   # 결과 조회
├── lib/
│   ├── supabase/                 # Supabase 클라이언트
│   │   ├── client.ts             # 브라우저 전용
│   │   ├── server.ts             # 서버 컴포넌트/API Route
│   │   └── admin.ts              # Service Role (RLS 우회)
│   ├── services/
│   │   ├── instagram/            # Apify 기반 스크래핑
│   │   ├── ai/                   # Vertex AI Gemini (성별/외모/친밀도/종합분석)
│   │   ├── analysis/             # 위험도/신뢰도 점수 계산
│   │   ├── email.ts              # Resend 이메일 발송
│   │   └── analytics.ts          # Amplitude 분석
│   ├── types/                    # TypeScript 타입 정의
│   └── constants/                # 점수 계산 상수, AI 프롬프트
├── hooks/
│   ├── useAuth.ts                # 인증 상태 관리
│   └── useAnalysisProgress.ts    # 분석 진행 상황 실시간 추적
├── components/
│   └── email-template.tsx        # 이메일 템플릿
├── supabase/migrations/          # DB 마이그레이션 SQL
└── proxy.ts                      # 인증 프록시
```

## 핵심 기능

### 분석 파이프라인 (`/api/analysis/step` 현행)

| 단계 | 작업 | 설명 |
|------|------|------|
| `collect` | 프로필/팔로워/팔로잉 수집 | 맞팔 추출, 공개/비공개 분류 |
| `profiles` | 공개 계정 프로필 배치 수집 | latestPosts 포함 (최대 350개) |
| `analyze` | AI 종합 분석 | 성별·외모·노출도·친밀도 단일 Vertex AI Gemini 호출로 처리 (캐시 활용) |
| `finalize` | 위험도 점수 계산 및 순위화 | 가중치·기간·급증 보너스 적용 |
| `completed` | 결과 저장 및 이메일 알림 | Supabase 저장, Resend 발송 |

### 위험도 점수 계산

```
기본점수 = (좋아요 × 1) + (일반댓글 × 3) + (친밀댓글 × 10) + (대댓글 × 5)
         + (게시물태그 × 3) + (캡션언급 × 5) + (외모점수)

최종점수 = 기본점수 × 기간가중치 × 급증보너스(해당시)
```

- **기간 가중치**: 6개월 미만(×1.0), 6~12개월(×1.3), 12개월 이상(×1.5)
- **급증 보너스**: 최근 1개월 상호작용이 이전 평균의 2배 이상이면 ×1.5

## 데이터베이스 테이블

| 테이블 | 설명 |
|--------|------|
| `users` | 사용자 정보, 분석 횟수 |
| `analysis_requests` | 분석 요청 상태/진행률/단계 데이터 |
| `analysis_results` | 위험도 순위 결과 (share_token 포함) |
| `comment_details` | 친밀한 댓글 상세 정보 |
| `private_accounts` | 비공개 계정 목록 |
| `ai_analysis_cache` | AI 분석 결과 캐시 (계정별 영구 저장) |
| `gemini_token_usage` | Vertex AI Gemini 토큰 사용량 추적 |

## 스크립트

```bash
npm run dev      # 개발 서버 실행
npm run build    # 프로덕션 빌드
npm run start    # 프로덕션 서버 실행
npm run lint     # 린트 검사
```

## 보호 경로

프록시에서 다음 경로는 로그인 필수로 처리됩니다:
- `/analyze` - 분석 입력 페이지
- `/progress/*` - 진행 상황 페이지
- `/result/*` - 결과 페이지

## 구현 현황

### 완료
- 사용자 인증 (카카오/구글 OAuth)
- 팔로워/팔로잉 수집 (Apify + RapidAPI 연동, 개인 Instagram 쿠키 미사용)
- 분석 파이프라인 (단계별 step 방식, 레거시 run 병행)
- AI 종합 분석 (성별/외모/노출도/친밀도 단일 Vertex AI Gemini 호출)
- AI 분석 캐싱 (ai_analysis_cache 테이블)
- 위험도 점수 계산 및 순위화
- 실시간 진행 상황 표시 (Supabase Realtime)
- 결과 리포트 (1위 상세 + 비공개 계정 리스트)
- 결과 공유 기능 (share token)
- 이메일 알림 (분석 완료, Resend)
- 무료 분석 1회 제한

### 진행 중
- 프로필 이미지 blur 처리

### 예정
- 딥 스캔 기능 (외부 댓글까지 전수 분석)
- 카카오톡/인스타그램 공유 연동

## 라이선스

MIT

## 관련 문서

- [기획서](docs/AI_바람감지기_기획서.md)
- [PRD](docs/PRD.md)
