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
| 개발 호스팅 | Vercel Hobby | 개발·비상업 검증 전용 |
| 운영 실행 | Vercel + Google Cloud Tasks | OIDC 인증 비동기 step 실행, Cloud Run 미사용 |
| 백엔드/DB | Supabase | Auth, DB, owner-scoped progress reads |
| 인스타 수집 | 직접 공개 프로필 + Apify 관계 목록 | Vendor API 과금 |
| AI 분석 | Vertex AI Gemini 3 Flash | Google Cloud |
| 이메일 발송 | Resend | 완료 알림 |
| 애널리틱스 | Amplitude | 제품 이벤트 |

## 시작하기

### 1. 환경 변수 설정

`.env.example`을 복사하여 `.env.local` 파일을 생성하고 필요한 값을 입력합니다:

```bash
cp .env.example .env.local
```

환경 변수의 전체 목록, 기본값과 허용 범위는 [`.env.example`](.env.example)이 기준입니다. 운영 기본 경로에는 Supabase와 OAuth, Apify, Vertex AI 자격증명이 필요합니다. FlashAPI 키는 운영자가 수동 진단을 실행할 때만 선택 사항입니다. Resend와 Amplitude는 해당 기능을 사용할 때 설정하고, `ADMIN_API_KEY`는 요청별 수집 프로바이더 override를 허용할 때만 사용합니다.

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

운영 분석 전에 `007`~`010`과 이후의 모든 timestamp migration을 순서대로 적용해야 합니다. 최신 migration은 상호작용 증거/점수, background task 상태, 고위험 심층 분석, 비공개 계정 이름 정렬, 내부 증거 열의 client 접근 차단을 포함합니다.

### 4. Cloud Tasks 운영 설정

운영 환경은 앱 런타임의 Google Cloud 서비스 계정과 Cloud Tasks가 OIDC 토큰에 사용할 전용 계정을 분리합니다. 런타임 계정은 이미 존재해야 하며, 스크립트는 전용 task invoker 계정이 없을 때만 키 없이 생성합니다.

```bash
export ANALYSIS_TASKS_PROJECT=your-project-id
export ANALYSIS_TASKS_LOCATION=asia-northeast3
export ANALYSIS_TASKS_QUEUE=analysis-pipeline
export ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL=analysis-task@your-project-id.iam.gserviceaccount.com
export ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL=app-runtime@your-project-id.iam.gserviceaccount.com

# API, IAM, service agent, queue 변경 예정 내용만 확인
./scripts/configure-analysis-tasks-queue.sh --dry-run

# 멱등적 설정 후 전체 구성 검증
./scripts/configure-analysis-tasks-queue.sh
./scripts/configure-analysis-tasks-queue.sh --check
```

`ANALYSIS_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL`은 이 설정 스크립트에서만 쓰는 입력입니다. 앱 런타임은 [`.env.example`](.env.example)의 기존 `ANALYSIS_TASKS_*` 값을 그대로 사용합니다. 스크립트는 다음을 보장합니다.

- `cloudtasks.googleapis.com` API와 Cloud Tasks service agent
- 런타임 계정의 `roles/cloudtasks.enqueuer`
- task invoker 계정에 대한 런타임 계정의 `iam.serviceAccounts.actAs`
- task invoker 계정에 대한 Cloud Tasks service agent의 OIDC 토큰 발급 권한
- 최대 동시 2개·초당 2개, 최대 8회, `40s`~`300s` backoff의 `analysis-pipeline` 큐 정책

실행자에게는 해당 프로젝트의 Service Usage, IAM/service account, Cloud Tasks 큐 설정 권한이 필요합니다. 스크립트는 중지된 큐를 자동으로 재개하지 않고 상태 이상을 보고하므로, 운영자가 중지 의도를 확인한 뒤 직접 재개해야 합니다.

### 5. 개발 서버 실행

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
│   │   ├── instagram/            # 기능별 public/vendor 프로바이더 라우팅
│   │   ├── ai/                   # Vertex AI Gemini 종합 분석과 응답 검증
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
| `collect` | 프로필/팔로워/팔로잉 수집 | 맞팔 추출, 공개/비공개 분류, 비공개 계정 이름 텍스트 100개 단위 AI 정렬 |
| `profiles` | 공개 계정 프로필 배치 수집 | 12시간 이내 프로필 snapshot 우선, 나머지만 직접 수집 후 Apify 1회 폴백 |
| `analyze` | AI 종합 분석 | 기본 프로필 1장 + 게시물 최대 10장을 1024px JPEG로 정규화한 뒤 단일 Vertex AI Gemini 호출 (30일 결과 캐시 활용) |
| `interactions` | 양방향 상호작용 수집 | 대상 liker 4 posts×150, 댓글 6 posts×15, 중간점수 상위 관측 여성 최대 10명×1 post×liker 100 |
| `deep_analysis` | 고위험 후보 심층 분석 | 상위 1~3명의 프로필·bio·피드 이미지/캡션·댓글 원문·방향별 좋아요·coverage를 병렬 Gemini 분석하고 수치 없는 시니컬한 2문장 생성 |
| `finalize` | 위험도 점수 계산 및 순위화 | 특징 점수 + 최근 맞팔 보정 + 관측 상호작용 점수; 원시 건수와 component score는 결과에 비공개 |
| `completed` | 결과 저장 및 이메일 알림 | Supabase 저장, Resend 발송 |

### 위험도 점수 계산

```
총점 = 포토제닉 점수(20/40/60/80/100)
     + 피부 노출 점수(high 40, low 0)
     + 태그 점수(30 또는 0)
     + 최근 맞팔 보정(최대 20)
     + 상호작용 점수(최대 100)
```

최대 290점입니다. 최신 맞팔일수록 `20/맞팔순위` 보정이 커집니다. 기혼/해외 패턴은 외모 기반 170점에서만 제외하고, 최근 맞팔 보정과 실제 관측된 상호작용은 유지합니다. 목록에 없는 계정은 비상호작용으로 단정하지 않으며 coverage는 서버 내부에만 별도 보존합니다.

## 데이터베이스 테이블

| 테이블 | 설명 |
|--------|------|
| `users` | 사용자 정보, 분석 횟수 |
| `analysis_requests` | 분석 요청 상태/진행률/단계 데이터 |
| `analysis_results` | 위험도 순위 결과 (share_token 포함) |
| `comment_details` | 친밀한 댓글 상세 정보 (현재 수집/분석 파이프라인 미연결) |
| `private_accounts` | 비공개 계정과 username/full_name 기반 여성형 이름 확률 정렬값 |
| `ai_analysis_cache` | 버전이 일치하는 AI 결과는 30일, 함께 저장한 프로필 snapshot은 기본 12시간 유효 |
| `gemini_token_usage` | Vertex AI Gemini 모델별 토큰, 추론 토큰, 비용, 호출 지연 데이터 |
| `scraper_provider_usage` | 기능별 수집 프로바이더, 폴백, 결과 수, 지연 및 비용 추정 텔레메트리 |
| `analysis_interaction_jobs` | 상호작용 Actor 배치, 결과 수, 비용, post별 coverage |
| `analysis_interaction_evidence` | 여성 후보와 일치한 양의 좋아요/댓글 증거만 저장 |
| `analysis_interaction_scores` | 후보별 3방향 상호작용 점수와 coverage |

캐시 버전은 모델, 프롬프트, 응답 스키마, 이미지 정책으로 계산합니다. 버전이 다르거나 TTL이 지난 값은 재사용하지 않으며, profile snapshot 캐시가 없거나 유효하지 않으면 설정된 프로필 프로바이더로 수집합니다.

### Instagram 수집 라우팅

- 공개 프로필과 프로필 배치는 로그인 없는 직접 수집이 기본이며, 실패 시 Apify를 한 번만 호출합니다.
- 팔로워와 팔로잉은 Apify Scraping Solutions가 기본입니다. 대상 프로필의 선언 수와 플랜 상한으로 계산한 예상치의 99% 미만이면 자동 폴백 없이 실패합니다.
- Instagram 로그인 쿠키, 세션 계정, 계정 풀은 사용하지 않습니다.
- 댓글은 Apify 공식 Actor, liker는 DataDoping no-cookie Actor를 사용합니다. 관리자는 요청별 `comments`/`likers`를 `apify` 또는 `disabled`로 선택할 수 있습니다.
- FlashAPI, CoderX, Stable RapidAPI 어댑터는 관리자가 명시적으로 선택할 때만 사용하며 관계 목록의 자동 폴백에 포함되지 않습니다.
- `POST /api/analysis/start`의 `scraperOptions`는 `ADMIN_API_KEY` Bearer 인증을 통과한 요청만 허용하며, 선택값은 해당 분석 요청에 저장됩니다.

허용 조합, 기능별 폴백 규칙, 완전성 기준과 canary 절차의 기준 문서는 [Instagram 프로바이더 운영 가이드](lib/services/instagram/README.md)입니다.

## 스크립트

```bash
npm run dev      # 개발 서버 실행
npm run build    # 프로덕션 빌드
npm run start    # 프로덕션 서버 실행
npm run lint     # 린트 검사
npm test         # 단위 테스트
```

## 보호 경로

프록시에서 다음 경로는 로그인 필수로 처리됩니다:
- `/analyze` - 분석 입력 페이지
- `/progress/*` - 진행 상황 페이지
- `/result/*` - 결과 페이지

## 구현 현황

### 완료
- 사용자 인증 (카카오/구글 OAuth)
- 팔로워/팔로잉 수집 (Apify 기본, 99% 완전성 검증, 개인 Instagram 쿠키 미사용)
- 분석 파이프라인 (단계별 step 방식, 레거시 run 기본 비활성)
- AI 종합 분석 (기본 계정당 프로필 1장 + 게시물 최대 10장, 단일 Vertex AI Gemini 호출)
- AI 분석 결과 캐싱 (30일) 및 프로필 snapshot 수집 가속 (기본 12시간)
- 위험도 점수 계산 및 순위화
- 양방향 liker/comment 교집과 coverage 내부 보존, 최종 순위에만 반영
- Cloud Tasks OIDC 기반 백그라운드 실행과 모바일 페이지 이탈 후 계속 처리
- 고위험 1~3명만 댓글 내용과 방향별 좋아요를 반영한 수치 없는 시니컬한 2문장 총평, 대상 프로필 이미지 결과 표시
- 비공개 계정 이름 텍스트 기반 확률 정렬
- 진행 상황 표시 (권한이 제한된 상태 열을 5초 간격으로 조회)
- 결과 리포트 (1위 상세 + 비공개 계정 리스트)
- 결과 공유 기능 (share token)
- 이메일 알림 (분석 완료, Resend)
- 무료 분석 1회 제한

### 진행 중
- 프로필 이미지 blur 처리
- `targetGender` 계약과 현재 여성 후보 고정 필터의 정합성 결정 (유료 출시 전 필수)
- 제3자 프로필 보존·삭제, 공유 링크 접근, 미성년자 및 허용 사용 정책 확정 (유료 출시 전 필수)

운영 환경에서는 Cloud Tasks가 `/api/analysis/step`을 순차 호출합니다. 로컬처럼 task 설정이 꺼진 환경만 진행 페이지가 기존 브라우저 실행 방식으로 자동 폴백합니다.

### 예정
- 딥 스캔 기능 (비로그인 범위를 넘는 데이터는 별도 동의/가격 계약 필요)
- 카카오톡/인스타그램 공유 연동

## 라이선스

MIT

## 관련 문서

- [기획서](docs/AI_위장여사친판독기_기획서.md)
- [PRD](docs/PRD.md)
- [운영 비용 및 가격 모델](docs/operations-cost-model.md)
- [Instagram 프로바이더 운영 가이드](lib/services/instagram/README.md)
- [Instagram 프로바이더 범위 대장](docs/instagram-provider-scope-ledger.md)
