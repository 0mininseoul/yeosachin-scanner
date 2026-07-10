> **SUPERSEDED / DO NOT IMPLEMENT.** This is a historical design record, not current approval. See the [Instagram provider scope ledger](../../instagram-provider-scope-ledger.md); prohibited paths described below remain out of scope.

# 자체 인스타그램 크롤러 (전환 가능한 프로바이더) — 설계 문서

- 작성일: 2026-07-08
- 상태: 승인됨 (구현 진행)
- 관련 브랜치: `feat/self-hosted-scraper`

## 1. 배경 및 목표

현재 분석 파이프라인은 인스타그램 데이터 수집을 외부 유료 서비스(Apify, RapidAPI)에 의존한다. 건당 과금 구조라 분석 볼륨이 늘수록 운영비가 선형 증가해 PMF 탐색에 부담이 된다.

**목표**: 외부 서비스 건당 과금을 자체 호스팅 크롤러로 대체해 운영비를 절감하되, **외부 크롤러를 언제든 복원할 수 있도록** 코드/구조를 유지한다.

**명시적으로 목표가 아닌 것 (기술적 현실)**:
- "무료 + 무차단" 크롤러는 불가능하다. 인스타그램 차단 회피는 크롤러 코드 품질이 아니라 **인프라(IP + 계정)** 의 문제다. 데이터센터 IP 하나로 대량 요청하면 코드와 무관하게 즉시 차단된다.
- Apify/RapidAPI 비용의 실체는 그들이 대신 운영하는 **레지던셜 프록시 풀 + 로테이션되는 실제 계정 풀**이다. 자체 호스팅은 이 비용을 없애는 게 아니라 건당 과금 → 고정비/무료 인프라로 **전환**하는 것이다.

## 2. 수집 기능과 인증 요구 (현황)

| 기능 | 현재 소스 | 수집량 | 로그인 필요 | 자체화 난이도 |
|---|---|---|---|---|
| `getInstagramProfile` | Apify | 1건 | ❌ | 낮음 (1단계) |
| `getProfilesBatch` (프로필+게시물) | Apify | 최대 350건 | ❌ | 낮음 (1단계, **비용의 대부분**) |
| `getFollowers` | Apify | 500~1000명 | ✅ | 높음 (2단계) |
| `getFollowing` | RapidAPI | 500~1000명 | ✅ | 높음 (2단계) |

핵심: 비용의 큰 덩어리인 프로필+게시물 350건은 **로그인 없이** 수집 가능(1단계). 팔로워/팔로잉만 인증이 필요(2단계).

## 3. 단계적 전략

- **1단계 (이번 구현)**: 프로필 + 프로필배치(게시물 포함)를 자체 호스팅. 계정 불필요. 프록시 계층은 무료 옵션 우선으로 pluggable하게. 팔로워/팔로잉은 기존 외부 API 유지.
- **2단계 (후속)**: 팔로워/팔로잉을 계정 풀 + 세션 관리로 자체화. 상시 워커 필요. 이번엔 인터페이스/설정만 스캐폴드하고 기본 OFF(외부 유지).

## 4. 아키텍처 — 기능별(capability) 프로바이더 스위치

전역 단일 프로바이더가 아니라 **4개 기능 각각을 환경변수로 프로바이더 선택**. 단계적 전환과 외부 복원을 동시에 만족한다.

```
SCRAPER_PROFILE=apify          # apify | selfhosted
SCRAPER_PROFILES_BATCH=apify   # apify | selfhosted   ← 1단계에서 selfhosted로 전환
SCRAPER_FOLLOWERS=apify        # apify | selfhosted
SCRAPER_FOLLOWING=rapidapi     # rapidapi | selfhosted
SCRAPER_FALLBACK=false         # true면 selfhosted 실패 시 기존 외부 프로바이더로 자동 폴백
```

- **기본값은 현재와 동일**(apify/apify/apify/rapidapi) → 이 작업만으로 프로덕션 동작 불변, 리스크 0에서 시작.
- 인프라 준비 후 해당 env만 `selfhosted`로 → **재배포 없이 env 한 줄로 전환/복원.**
- `scraper.ts`의 공개 함수 시그니처는 완전히 동일하게 유지 → `run/route.ts`, `step/route.ts` 등 파이프라인 코드 무수정.

### 자동 폴백 (`SCRAPER_FALLBACK=true`, 기본 off)

selfhosted 프로바이더가 차단/오류로 실패하면 해당 기능의 기존 외부 프로바이더(apify/rapidapi)로 자동 재시도. 프로덕션 무중단. opt-in(남용 시 외부 비용 발생 가능하므로 기본 off).

## 5. 파일 구조

```
lib/services/instagram/
  index.ts                  # 공개 API export (변경 없음)
  scraper.ts                # 라우터: 기능별 config 보고 프로바이더 위임 (+폴백)
  config.ts                 # SCRAPER_* env 파싱 → 기능별 프로바이더 결정
  README.md                 # ★ 프로바이더 전환 방법 문서 (다른 세션이 찾을 수 있게)
  providers/
    types.ts                # ScraperProvider 인터페이스, capability 타입
    apify.ts                # 기존 Apify 로직 이동 (복원 가능)
    rapidapi.ts             # 기존 RapidAPI following 로직 이동 (복원 가능)
    selfhosted/
      index.ts              # SelfHostedProvider (기능별 위임)
      web-client.ts         # web_profile_info 클라이언트 (프로필+게시물, 인증 불필요)
      transport.ts          # 요청 전송 계층 (무료 프록시 우선 pluggable)
      rate-limit.ts         # 동시성 제한 + 지터/백오프 + 429 처리
      mappers.ts            # IG raw JSON → InstagramProfile/Follower/Post
      followers-client.ts   # 2단계용 (세션 필요) — 스캐폴드, 미구현 throw
      session.ts            # 2단계용 계정 세션 관리 — 스캐폴드
```

`extractMutualFollows`, `classifyByPrivacy`는 프로바이더 무관 순수 함수이므로 `scraper.ts`에 유지.

## 6. 1단계 자체 크롤러 기술 상세

- 엔드포인트: `GET https://www.instagram.com/api/v1/users/web_profile_info/?username={id}`
- 헤더: `x-ig-app-id: 936619743392459`, 현실적인 `User-Agent`, `Accept: */*`, `X-Requested-With: XMLHttpRequest` 등. 로그인 쿠키 불필요.
- 응답 `data.user`에서 매핑:
  - 프로필: `full_name`, `biography`, `profile_pic_url_hd`, `edge_followed_by.count`, `edge_follow.count`, `edge_owner_to_timeline_media.count`, `is_private`, `is_verified`, `external_url`.
  - 게시물(`edge_owner_to_timeline_media.edges`, 최근 ~12개): 캡션, 해시태그, `display_url`, `is_video`, 좋아요/댓글 수, `edge_media_to_tagged_user`(태그된 유저), 캡션 내 `@멘션`.
- 매핑 결과는 기존 `InstagramProfile` / `InstagramPost` 타입과 동일 형태(기존 `parseLatestPosts`와 호환).
- `getInstagramProfile`과 `getProfilesBatch`를 **한 클라이언트로 둘 다** 커버(배치는 동시성 제한 병렬 호출).

### 실패/차단 처리
- 429/401/불완전 응답 → 백오프 재시도 후 실패 시 기존 에러 규약(`SCRAPING_ERROR:` 접두사) 그대로 throw → 파이프라인의 기존 에러 매핑 유지.
- `SCRAPER_FALLBACK=true`면 외부 프로바이더로 폴백.

## 7. 인프라 조달 — 무료 최우선

전제: 유료 레지던셜 프록시 없이 시작. transport 계층을 pluggable로 만들어 무료 경로부터 지원한다.

**transport 모드** (`IG_TRANSPORT`):

1. `direct` (기본, 무료) — 프록시 없이 직접 요청. 실행 환경 IP를 그대로 사용.
   - **최적 무료 조합**: 크롤러 워커를 **자택 상시 머신/미니PC**에서 구동 → 레지던셜 IP를 공짜로 확보. 프록시비 0. 처리량은 낮게(강한 레이트리밋).
   - Vercel(데이터센터 IP)에서 `direct`는 소량/테스트만 가능, 대량은 차단됨.
2. `scrape-api` (무료 크레딧 브릿지) — ScraperAPI(월 1,000요청 무료) / ScrapingBee / ScrapingDog 등 무료 티어를 언블록 프록시로 사용. `IG_SCRAPE_API_URL` + 키 설정. 무료 크레딧 한도 내 비용 0. Vercel에서도 바로 동작(신규 인프라 운영 불필요).
3. `http-proxy` (유료, 확장용) — `IG_PROXY_URL`에 레지던셜 프록시. 볼륨 커진 뒤 도입.

**무료 우선 권장 경로**:
- 지금 당장 Vercel에서: `scrape-api` 무료 티어로 시작(운영 부담 0, 무료 크레딧 소진 전까지 비용 0).
- 처리량이 필요해지면: 자택 상시 머신 워커 + `direct`(레지던셜 IP 무료) — 2단계 워커와 겸용.
- 무료 워커 호스팅 옵션(2단계): Oracle Cloud Always Free VM(상시 무료), 자택 머신(무료+레지던셜), Fly.io/Railway 무료 티어.

프록시가 아직 없어도 코드는 위 3모드 지원으로 완성해 두고, 로컬/소량으로 자체 크롤러 동작을 검증한다. 무료 티어 키만 넣으면 프로덕션 전환.

## 8. 배포/런타임

1단계는 상태 없는 HTTP + transport라 **기존 Next.js API 안에서 동작**(별도 워커 불필요). 파이프라인이 이미 배치를 30개씩 쪼개 처리해 Vercel 타임아웃 내 수용. 상시 워커는 **2단계(세션 관리)** 에서만 필요.

## 9. 프로바이더 전환 문서화 (코드베이스 기억)

`lib/services/instagram/README.md`에 전환 방법을 기록하고, 루트 `CLAUDE.md`의 아키텍처 섹션에도 짧게 링크/요약을 추가한다. 다른 세션에서 "프로바이더 어떻게 바꾸지?"를 물으면 이 문서로 답할 수 있게 한다. 내용:
- 각 `SCRAPER_*` env의 의미와 허용값
- 외부 → 자체 전환 절차, 자체 → 외부 복원 절차
- `SCRAPER_FALLBACK` 동작
- `IG_TRANSPORT` 모드와 무료 조달 옵션 요약

## 10. 테스트 전략

- 매퍼 단위테스트: 저장된 IG raw JSON 픽스처 → 기대 `InstagramProfile`/`InstagramPost` 변환 검증(네트워크 불필요, 결정적).
- config 라우팅 테스트: env 조합별로 올바른 프로바이더가 선택되는지, 폴백 동작.
- 로컬 검증 스크립트: 공개 계정 대상 web_profile_info 실호출(소량) — transport `direct`로 스모크 테스트.

## 11. 범위 밖 (이번 구현 제외)

- 2단계 팔로워/팔로잉 자체 수집의 실제 구현(계정 풀·세션·상시 워커). 인터페이스와 config만 스캐폴드하고 기본 OFF.
- 유료 프록시 도입/결제.
- 계정 밴 모니터링·자동 교체 시스템(2단계 이후).

## 12. 리스크 및 완화

| 리스크 | 완화 |
|---|---|
| Vercel 데이터센터 IP 차단 | `scrape-api` 무료 티어 브릿지 or 자택 워커 `direct` |
| 무료 크레딧 소진 | 소진 시 `SCRAPER_FALLBACK`로 외부 자동 복원, 또는 env로 수동 복원 |
| IG 응답 스키마 변경 | 매퍼 격리 + 단위테스트로 조기 감지, 실패 시 폴백 |
| 자체 크롤러 장애 | 기본값 외부 유지 + opt-in 폴백으로 프로덕션 무중단 |
