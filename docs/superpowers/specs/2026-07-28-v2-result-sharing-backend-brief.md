# 백엔드 작업 의뢰 — V2 결과 공유 + 타깃 실명 + 동적 OG 이미지

프론트 세션에서 결과 페이지를 재설계하면서 백엔드가 막고 있는 세 가지가 나왔습니다.
아래를 그대로 백엔드 세션에 전달하면 됩니다.

---

## 배경

프론트는 결과 페이지 헤드라인을 `{타깃 실명}님의 위장 여사친`으로 바꿨고, 결과 페이지 안에
카카오 공유 버튼을 넣었습니다. 현재 두 가지가 불가능합니다.

1. **타깃의 실명(fullName)이 결과 계약에 없다.** 지금은 인스타그램 핸들로 대체 중.
2. **V2 결과에는 공개 URL이 없다.** `CURRENT_ANALYSIS_PIPELINE_VERSION = 'v2'`인데
   `app/api/share/enable/route.ts`가 v2를 명시적으로 거부하고(`unsupportedPipelineResponse`),
   `app/api/share/[token]/route.ts`도 `isLegacySharePipeline` 게이트로 v2 토큰을 404 처리합니다.
   `/result/[requestId]`는 미들웨어 인증 보호라 링크를 받아도 로그인 화면만 보입니다.

결과적으로 지금 공유 버튼은 결과가 아니라 서비스 링크만 보냅니다.

---

## 요청 1 — 타깃 실명을 V2 요약 계약에 추가

### 목표

`analysisResultSummaryV1Schema`에 `targetFullName`을 추가한다.

### 근거

`lib/types/instagram.ts`의 `InstagramProfile`에 이미 `fullName?: string`이 있다.
스크래퍼는 값을 받아오고 있고, 요약까지 전파가 안 될 뿐이다.

### 변경 지점

| 파일 | 내용 |
| --- | --- |
| `supabase/migrations/` | 신규 마이그레이션. V2 finalization RPC가 `target_full_name`을 반환하도록 확장 |
| `lib/contracts/analysis-v2.ts` | `analysisResultSummaryV1Schema`에 `targetFullName` 추가 |
| `lib/services/analysis/v2-result-store.ts` | `rawSummarySchema`(약 797행)에 필드 추가 후 요약 매핑에 반영 |
| `lib/services/demo-analysis/demo-analysis.ts` | `demoResultPage` 픽스처에 필드 추가 (계약이 `.strict()`라 없으면 파싱 실패) |

**선례:** `supabase/migrations/20260723191547_persist_analysis_v2_gender_stats.sql`.
`genderStats`가 정확히 같은 경로(마이그레이션 → 계약 → result store → 데모 픽스처)로 추가됐다.
그대로 따라가면 된다.

### 계약 제약

- **nullable로 정의한다.** 인스타그램 실명은 비어 있을 수 있다.
  `targetFullName: z.string().max(200).nullable()` 수준이면 충분하다.
- 프론트는 `targetFullName ?? targetInstagramId`로 폴백하므로, null이어도 화면은 깨지지 않는다.
- **`.strip()`이 아닌 기존 요약 스키마 정책을 유지**하되, 과거에 생성된 결과 행에는 값이 없다.
  구버전 행이 파싱 실패하지 않도록 `.nullable()` + 기본값 처리를 반드시 확인할 것.

---

## 요청 2 — V2 결과 공유 토큰

### 목표

로그인 없이 열람 가능한 V2 결과 공유 URL을 만든다. 프론트가 이 URL을 카카오로 보낸다.

### 변경 지점

| 파일 | 내용 |
| --- | --- |
| `app/api/share/enable/route.ts` | v2 거부 해제. v2 요청에도 `share_token` 발급 |
| `app/api/share/[token]/route.ts` | v2 토큰에 대해 V2 결과 DTO 반환 (현재는 레거시 DTO 전용) |
| `app/share/[token]/page.tsx` | V2 응답 형태 수용. 현재 v1 형태만 가정 |

### 반드시 지킬 것

- **공유본은 소유자 뷰와 같은 데이터를 그대로 노출하면 안 된다.**
  토큰만 있으면 누구나 보는 페이지에 타깃의 핸들·실명·프로필 사진과 함께
  **동의한 적 없는 제3자(판독된 여성 계정들)의 아이디·프로필·바이오·AI 총평**이 전부 실린다.
  최소한 공유본에서 개별 계정 식별 정보를 가릴지 여부를 제품 결정으로 확정하고 가야 한다.
  (`.worktrees/demo-fixture-v3-redaction` 브랜치에 리댁션 개념이 이미 있으니 참고)
- 토큰은 **취소 가능**해야 한다. 기존 `share_enabled` 플래그를 그대로 쓰면 된다.
- 기존 v1 토큰 동작을 깨뜨리지 말 것. `isLegacySharePipeline` 분기는 유지하고 v2 분기를 추가한다.
- 페이지네이션: V2 결과는 커서 기반이다. 공유본에 첫 페이지만 실을지 전체를 실을지 정할 것.

---

## 요청 3 — 결과별 동적 OG 이미지

### 목표

카카오 공유 메시지 썸네일을 결과마다 생성한다.

**구성:** 타깃 계정 프로필 이미지 + `{target_fullname}님의 위장 여사친 판독 결과` 텍스트.
**구체적인 숫자(고위험 N건 등)는 넣지 않는다.**

### 구현

- `next/og`의 `ImageResponse`를 쓴다. Next 16.2.11이라 사용 가능하다
  (`node_modules/next/dist/server/og/image-response.js` 확인함).
- 신규 라우트: `app/api/share/[token]/opengraph-image` 또는 `app/share/[token]/opengraph-image.tsx`.
- **인증이 없어야 한다.** 카카오가 서버에서 이미지를 긁어간다. 토큰이 곧 접근 권한이다.

### 카카오 규격 (프론트에서 실측·확인함)

- 카카오 피드 템플릿은 **페이지의 OG 태그를 읽지 않는다.** `content.imageUrl`로 넘긴 URL만 쓴다.
  → 프론트가 넘길 절대 URL을 백엔드가 확정해 주면 된다.
- 이미지·링크 모두 **카카오 개발자콘솔에 등록된 도메인**이어야 한다. 등록됨: `https://yeosachin.com`.
  localhost URL은 거부된다.
- 권장 규격 **800×400 (2:1)**, 최소 200×200. 현재 정적 `public/og.png`는 1200×630(1.90:1)이라
  살짝 크롭된다. 동적 이미지는 800×400으로 생성할 것.
- **카카오는 이미지를 서버에서 캐싱한다.** 결과별로 URL이 달라야 캐시가 섞이지 않는다.
  토큰이 URL에 들어가므로 자연히 해결되지만, 재생성 시 무효화가 필요하면 쿼리 버전을 둘 것.

### 프로필 이미지 처리

- 인스타그램 CDN 이미지는 `lib/services/media/image-proxy-token.ts`의 **서명된 프록시**를 거친다.
  토큰 버킷이 15분(`TOKEN_BUCKET_SECONDS`)이라, OG 이미지에 프록시 URL을 그대로 박으면
  **카카오가 나중에 다시 긁을 때 만료된다.**
- OG 라우트는 서버에서 실행되므로 렌더 시점에 원본을 직접 fetch해 인라인하거나,
  결과 확정 시 프로필 이미지를 R2 등에 사본으로 저장해 안정적인 URL을 쓰는 편이 안전하다.
  (`.worktrees` 이력에 `r2-result-images` 작업이 있으니 그 경로 재사용 검토)
- 프로필 이미지 로드 실패 시 텍스트만으로도 성립하는 폴백을 반드시 둘 것.

---

## 프론트가 이미 한 것 / 건드리지 말 것

아래 파일은 프론트 세션에서 수정 중이다. **충돌 방지를 위해 백엔드에서 수정하지 말 것.**

```
app/result/[requestId]/page.tsx
app/share/[token]/page.tsx          ← V2 대응은 프론트가 맡는다. 계약만 확정해 달라
app/page.tsx
app/analyze/page.tsx
app/progress/[requestId]/page.tsx
app/globals.css
components/case-ui.tsx
components/suspect-row.tsx
components/landing-reviews.tsx
components/landing-signature-card.tsx
lib/services/kakao-share.ts
lib/services/analysis/result-page-copy-contract.test.ts
```

카카오 JS SDK 연동(로더·SRI·초기화·폴백)은 프론트에서 끝났다:
`lib/services/kakao-share.ts`. 환경변수는 `NEXT_PUBLIC_KAKAO_JS_KEY`이며
`.env.example`에 문서화돼 있다. **Vercel 환경변수 등록만 남았다.**

프론트가 백엔드에 필요한 것은 결국 두 가지뿐이다.

1. `summary.targetFullName`
2. 로그인 없이 열리는 V2 결과 URL + 그에 대응하는 OG 이미지 URL

---

## 확인 요청

- `AGENTS.md`의 Supabase 운영 규칙을 따를 것.
  관련 없는 pending migration이 있는 상태에서 `supabase db push --include-all` 금지.
- 다른 워크트리에서 백엔드 작업이 병행 중이다. 마이그레이션 파일명 충돌을 먼저 확인할 것.
