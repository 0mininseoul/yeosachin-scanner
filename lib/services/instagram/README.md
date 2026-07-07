# 인스타그램 스크래핑 프로바이더 전환 가이드

수집 기능 4개를 각각 외부(Apify/RapidAPI) 또는 자체 호스팅 크롤러로 **env로 전환**한다.
`scraper.ts`는 라우터이고 실제 구현은 `providers/*`에 있다. 공개 함수 시그니처는 고정
(`getInstagramProfile`, `getFollowers`, `getFollowing`, `getProfilesBatch` — 파이프라인 무수정).

## 전환 스위치 (env)

| env | 허용값 | 기본값 | 대상 기능 |
|---|---|---|---|
| `SCRAPER_PROFILE` | `apify` \| `selfhosted` | `apify` | 대상 프로필 1건 |
| `SCRAPER_PROFILES_BATCH` | `apify` \| `selfhosted` | `apify` | 프로필+게시물 배치(비용 대부분) |
| `SCRAPER_FOLLOWERS` | `apify` \| `selfhosted` | `apify` | 팔로워 목록 (selfhosted는 세션 필요, 아래 2단계) |
| `SCRAPER_FOLLOWING` | `rapidapi` \| `selfhosted` | `rapidapi` | 팔로잉 목록 (selfhosted는 세션 필요, 아래 2단계) |
| `SCRAPER_FALLBACK` | `true` \| `false` | `false` | selfhosted 실패 시 외부로 자동 폴백 |

잘못된 값을 넣으면 해당 기능의 외부 기본값으로 안전하게 되돌아간다.

## 절차

- **외부 → 자체 전환**: 해당 `SCRAPER_*`를 `selfhosted`로. 재배포 불필요(런타임 env 읽음).
  1단계는 `SCRAPER_PROFILES_BATCH=selfhosted`(+ 원하면 `SCRAPER_PROFILE=selfhosted`)만 켠다.
- **자체 → 외부 복원**: 값을 `apify`/`rapidapi`로 되돌린다. 외부 코드는
  `providers/apify.ts`, `providers/rapidapi.ts`에 그대로 남아 있어 즉시 복원된다.
- **안전 전환**: `SCRAPER_FALLBACK=true`로 두면 자체 실패 시 자동으로 외부로 폴백(무중단).
  단, 폴백이 자주 일어나면 외부 비용이 발생하므로 로그(`[scraper] ... 폴백`)를 모니터링한다.

## 자체 크롤러 transport (무료 우선)

selfhosted는 `web_profile_info`(로그인 불필요)로 프로필+게시물을 수집한다.
요청 경로는 `IG_TRANSPORT`로 고른다.

| `IG_TRANSPORT` | 비용 | 설명 |
|---|---|---|
| `direct` (기본) | 무료 | 실행 환경 IP로 직접. 자택 상시 머신(레지던셜 IP)에서 돌리면 무료+저차단. Vercel(데이터센터 IP)은 소량만. |
| `scrape-api` | 무료 티어 | ScraperAPI(월 1,000요청 무료) 등 무료 크레딧 언블록 프록시. `IG_SCRAPE_API_URL`+`IG_SCRAPE_API_KEY`. Vercel에서 바로 사용. |
| `http-proxy` | 유료 | 레지던셜 프록시 `IG_PROXY_URL`. 볼륨 확장 시. |

**무료 최우선 권장**: Vercel에선 `scrape-api` 무료 티어로 시작 → 처리량 필요 시 자택 워커+`direct`.

### 로컬 실검증 (무료)

```bash
RUN_SMOKE=1 IG_TRANSPORT=direct npx vitest run lib/services/instagram/providers/selfhosted/web-client.smoke.test.ts
```

## 2단계 (팔로워/팔로잉 자체화) — 구현됨, 기본 OFF

`providers/selfhosted/followers-client.ts`, `session.ts`에 구현되어 있다.
`friendships/{user_id}/followers|following` 엔드포인트를 세션 쿠키로 페이지네이션한다.
**기본값은 `SCRAPER_FOLLOWERS=apify` / `SCRAPER_FOLLOWING=rapidapi`라, 세션을 넣고 env를
바꾸기 전까지는 절대 작동하지 않는다.**

### ⚠️ 계정 밴 리스크 (반드시 읽을 것)

- 쿠키를 넣는 **그 계정**이 팔로워 목록을 대량 열람하는 주체가 되며, 인스타는 이 패턴을
  감지해 해당 계정에 action block / 체크포인트 / 정지를 걸 수 있다.
- **개인/메인 계정 쿠키는 넣지 말 것. 밴당해도 되는 여분(버너) 계정만 사용한다.**
- 리스크는 볼륨에 비례한다. 낮은 볼륨 + 딜레이 + 버너 2~3개 로테이션이면 현실적으로 운용 가능.
  높은 볼륨이면 계정 소모가 빨라 외부 API 유지가 낫다.

### 활성화 방법

1. 버너 계정으로 웹 로그인 후 쿠키에서 `sessionid`, `csrftoken`, `ds_user_id`를 추출.
2. env에 세션 주입 (둘 중 하나, 병합도 됨):
   - `IG_SESSIONS='[{"sessionId":"..","csrfToken":"..","userId":"<ds_user_id>"}]'` (여러 개 권장, 라운드로빈)
   - 또는 단일: `IG_SESSION_ID`, `IG_CSRF_TOKEN`, `IG_DS_USER_ID`
3. `SCRAPER_FOLLOWERS=selfhosted` / `SCRAPER_FOLLOWING=selfhosted`로 전환.
4. 안전하게 `SCRAPER_FALLBACK=true`도 함께 켜면 세션 만료/차단 시 외부로 자동 폴백.
5. 프록시(`IG_TRANSPORT=http-proxy` 등)를 함께 쓰면 계정 IP 노출을 줄일 수 있다.

세션이 없는데 `selfhosted`로 두면 명확한 에러(`세션이 없습니다`)를 던지며, 폴백이 켜져 있으면
외부로 넘어간다.

## 구조

```
scraper.ts            라우터(+폴백) + 순수 헬퍼(extractMutualFollows, classifyByPrivacy)
config.ts             SCRAPER_* env → 기능별 프로바이더 결정
providers/
  types.ts            ScraperProvider 인터페이스
  apify.ts            Apify (profile, followers, profilesBatch)
  rapidapi.ts         RapidAPI (following)
  selfhosted/
    index.ts          SelfHostedProvider (makeSelfHostedProvider 팩토리)
    web-client.ts     web_profile_info 호출
    transport.ts      direct | scrape-api | http-proxy
    rate-limit.ts     pLimit(동시성) + withRetry(백오프)
    mappers.ts        IG JSON → InstagramProfile/InstagramPost
    followers-client.ts   friendships 페이지네이션 (2단계, 세션 필요)
    session.ts        세션 env 파싱 + 라운드로빈 (2단계)
```
