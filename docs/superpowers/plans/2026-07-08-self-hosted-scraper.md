# 자체 인스타그램 크롤러 (전환 가능한 프로바이더) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 인스타그램 스크래핑을 기능별로 외부(Apify/RapidAPI)와 자체 호스팅 크롤러 사이에서 env로 전환 가능한 프로바이더 구조로 리팩터링하고, 프로필+게시물 수집을 자체화(1단계)한다.

**Architecture:** `scraper.ts`를 얇은 라우터로 만들어 4개 수집 기능(profile / profilesBatch / followers / following)을 각각 `SCRAPER_*` env로 고른 프로바이더에 위임한다. 기존 Apify/RapidAPI 로직은 `providers/apify.ts`, `providers/rapidapi.ts`로 이동해 보존한다. 자체 프로바이더는 로그인 불필요한 `web_profile_info` 엔드포인트로 프로필+게시물을 수집하며, transport 계층(direct/scrape-api/http-proxy)으로 무료 경로부터 지원한다. `SCRAPER_FALLBACK=true`면 자체 크롤러 실패 시 외부로 자동 폴백.

**Tech Stack:** TypeScript, Next.js 16 (Node runtime API routes), undici(ProxyAgent), vitest(신규 테스트 러너).

## Global Constraints

- 공개 함수 시그니처 불변: `getInstagramProfile(username): Promise<InstagramProfile|null>`, `getFollowers(username, limit): Promise<InstagramFollower[]>`, `getFollowing(username, limit): Promise<InstagramFollower[]>`, `getProfilesBatch(usernames, batchSize?): Promise<InstagramProfile[]>`, `extractMutualFollows(followers, following)`, `classifyByPrivacy(accounts)`. 파이프라인(`app/api/analysis/run/route.ts`, `step/route.ts`)은 수정하지 않는다.
- 기본 env 동작은 현행 유지: `SCRAPER_PROFILE=apify`, `SCRAPER_PROFILES_BATCH=apify`, `SCRAPER_FOLLOWERS=apify`, `SCRAPER_FOLLOWING=rapidapi`, `SCRAPER_FALLBACK=false`.
- 에러는 기존 규약 유지: 스크래핑 실패는 `SCRAPING_ERROR:` 접두사 메시지로 throw (파이프라인의 에러 매핑과 호환).
- 타입은 `@/lib/types/instagram`의 `InstagramProfile`, `InstagramPost`, `InstagramFollower`를 그대로 사용. 새 타입을 만들지 않는다.
- import 별칭 `@/*` = 프로젝트 루트.
- 2단계(팔로워/팔로잉 자체 수집)는 스캐폴드만: 파일과 config는 만들되 호출 시 `SCRAPING_ERROR: 자체 팔로워/팔로잉 수집은 2단계에서 지원됩니다` throw.

---

### Task 1: 테스트 러너 + 프로바이더 인터페이스

**Files:**
- Modify: `package.json` (devDependencies에 vitest 추가, `test` 스크립트 추가)
- Create: `vitest.config.ts`
- Create: `lib/services/instagram/providers/types.ts`
- Test: `lib/services/instagram/providers/types.test.ts`

**Interfaces:**
- Produces: `ScraperProvider` 인터페이스, `Capability` 타입, `ProviderName` 타입.

```ts
// Capability = 'profile' | 'profilesBatch' | 'followers' | 'following'
// ProviderName = 'apify' | 'rapidapi' | 'selfhosted'
// ScraperProvider: { name; getProfile?; getFollowers?; getFollowing?; getProfilesBatch? }
```

- [ ] **Step 1: vitest 설치**

Run:
```bash
npm install -D vitest@^3
```
Expected: `added ... vitest` (package.json devDependencies에 반영)

- [ ] **Step 2: package.json에 test 스크립트 추가**

`scripts`에 아래 줄 추가 (기존 lint 줄 뒤):
```json
    "lint": "eslint",
    "test": "vitest run"
```

- [ ] **Step 3: vitest.config.ts 작성**

Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['lib/**/*.test.ts', 'scripts/**/*.test.ts'],
    },
    resolve: {
        alias: { '@': path.resolve(__dirname, '.') },
    },
});
```

- [ ] **Step 4: providers/types.ts 작성**

Create `lib/services/instagram/providers/types.ts`:
```ts
import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';

export type Capability = 'profile' | 'profilesBatch' | 'followers' | 'following';

export type ProviderName = 'apify' | 'rapidapi' | 'selfhosted';

/**
 * 스크래핑 프로바이더. 각 프로바이더는 지원하는 기능만 구현한다.
 * (예: rapidapi는 getFollowing만, selfhosted는 getProfile/getProfilesBatch만)
 */
export interface ScraperProvider {
    readonly name: ProviderName;
    getProfile?(username: string): Promise<InstagramProfile | null>;
    getFollowers?(username: string, limit: number): Promise<InstagramFollower[]>;
    getFollowing?(username: string, limit: number): Promise<InstagramFollower[]>;
    getProfilesBatch?(usernames: string[], batchSize?: number): Promise<InstagramProfile[]>;
}
```

- [ ] **Step 5: 인터페이스 스모크 테스트 작성**

Create `lib/services/instagram/providers/types.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { ScraperProvider } from './types';

describe('ScraperProvider', () => {
    it('부분 구현(getProfile만) 객체가 인터페이스를 만족한다', () => {
        const p: ScraperProvider = {
            name: 'selfhosted',
            async getProfile() {
                return null;
            },
        };
        expect(p.name).toBe('selfhosted');
        expect(p.getFollowers).toBeUndefined();
    });
});
```

- [ ] **Step 6: 테스트 실행**

Run: `npx vitest run lib/services/instagram/providers/types.test.ts`
Expected: PASS (1 passed)

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts lib/services/instagram/providers/types.ts lib/services/instagram/providers/types.test.ts
git commit -m "test: add vitest + ScraperProvider interface"
```

---

### Task 2: 기능별 프로바이더 라우팅 설정 (config.ts)

**Files:**
- Create: `lib/services/instagram/config.ts`
- Test: `lib/services/instagram/config.test.ts`

**Interfaces:**
- Consumes: `ProviderName`, `Capability` (Task 1).
- Produces: `getScraperConfig(env?): ScraperConfig`, `EXTERNAL_DEFAULT: Record<Capability, ProviderName>`, `ScraperConfig` 타입.

```ts
// ScraperConfig = { profile; profilesBatch; followers; following: ProviderName; fallback: boolean }
```

- [ ] **Step 1: 실패 테스트 작성**

Create `lib/services/instagram/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getScraperConfig, EXTERNAL_DEFAULT } from './config';

describe('getScraperConfig', () => {
    it('env가 비면 현행 기본값을 쓴다', () => {
        const c = getScraperConfig({});
        expect(c).toEqual({
            profile: 'apify',
            profilesBatch: 'apify',
            followers: 'apify',
            following: 'rapidapi',
            fallback: false,
        });
    });

    it('env로 기능별 프로바이더를 덮어쓴다', () => {
        const c = getScraperConfig({
            SCRAPER_PROFILES_BATCH: 'selfhosted',
            SCRAPER_FALLBACK: 'true',
        });
        expect(c.profilesBatch).toBe('selfhosted');
        expect(c.profile).toBe('apify');
        expect(c.fallback).toBe(true);
    });

    it('잘못된 값은 기본값으로 안전하게 폴백한다', () => {
        const c = getScraperConfig({ SCRAPER_PROFILE: 'garbage' });
        expect(c.profile).toBe('apify');
    });

    it('EXTERNAL_DEFAULT는 following만 rapidapi', () => {
        expect(EXTERNAL_DEFAULT.following).toBe('rapidapi');
        expect(EXTERNAL_DEFAULT.profile).toBe('apify');
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run lib/services/instagram/config.test.ts`
Expected: FAIL ("Cannot find module './config'")

- [ ] **Step 3: config.ts 구현**

Create `lib/services/instagram/config.ts`:
```ts
import type { Capability, ProviderName } from './providers/types';

export interface ScraperConfig {
    profile: ProviderName;
    profilesBatch: ProviderName;
    followers: ProviderName;
    following: ProviderName;
    fallback: boolean;
}

/** 기능별 외부(비-selfhosted) 기본 프로바이더 — 폴백 대상이자 초기 기본값 */
export const EXTERNAL_DEFAULT: Record<Capability, ProviderName> = {
    profile: 'apify',
    profilesBatch: 'apify',
    followers: 'apify',
    following: 'rapidapi',
};

const VALID: Record<Capability, ProviderName[]> = {
    profile: ['apify', 'selfhosted'],
    profilesBatch: ['apify', 'selfhosted'],
    followers: ['apify', 'selfhosted'],
    following: ['rapidapi', 'selfhosted'],
};

function pick(
    capability: Capability,
    raw: string | undefined
): ProviderName {
    const value = (raw || '').trim() as ProviderName;
    if (VALID[capability].includes(value)) return value;
    return EXTERNAL_DEFAULT[capability];
}

export function getScraperConfig(
    env: Record<string, string | undefined> = process.env
): ScraperConfig {
    return {
        profile: pick('profile', env.SCRAPER_PROFILE),
        profilesBatch: pick('profilesBatch', env.SCRAPER_PROFILES_BATCH),
        followers: pick('followers', env.SCRAPER_FOLLOWERS),
        following: pick('following', env.SCRAPER_FOLLOWING),
        fallback: env.SCRAPER_FALLBACK === 'true',
    };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx vitest run lib/services/instagram/config.test.ts`
Expected: PASS (4 passed)

- [ ] **Step 5: Commit**

```bash
git add lib/services/instagram/config.ts lib/services/instagram/config.test.ts
git commit -m "feat: add per-capability scraper provider config"
```

---

### Task 3: Apify 프로바이더 분리 (providers/apify.ts)

기존 `scraper.ts`의 Apify 로직을 새 모듈로 **복사**한다(원본 `scraper.ts`는 Task 8까지 그대로 동작). `parseLatestPosts` 헬퍼도 함께 옮긴다.

**Files:**
- Create: `lib/services/instagram/providers/apify.ts`
- Test: `lib/services/instagram/providers/apify.test.ts`

**Interfaces:**
- Consumes: `ScraperProvider` (Task 1).
- Produces: `export const apifyProvider: ScraperProvider` (getProfile, getFollowers, getProfilesBatch 구현).

- [ ] **Step 1: 인터페이스 준수 테스트 작성**

Create `lib/services/instagram/providers/apify.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { apifyProvider } from './apify';

describe('apifyProvider', () => {
    it('name과 지원 기능이 노출된다', () => {
        expect(apifyProvider.name).toBe('apify');
        expect(typeof apifyProvider.getProfile).toBe('function');
        expect(typeof apifyProvider.getFollowers).toBe('function');
        expect(typeof apifyProvider.getProfilesBatch).toBe('function');
        expect(apifyProvider.getFollowing).toBeUndefined();
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run lib/services/instagram/providers/apify.test.ts`
Expected: FAIL ("Cannot find module './apify'")

- [ ] **Step 3: apify.ts 구현 (기존 로직 이동)**

Create `lib/services/instagram/providers/apify.ts`:
```ts
import { ApifyClient } from 'apify-client';
import type { InstagramProfile, InstagramFollower, InstagramPost } from '@/lib/types/instagram';
import type { ScraperProvider } from './types';

const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

/** latestPosts를 InstagramPost[] 형식으로 변환 (기존 scraper.ts에서 이동) */
function parseLatestPosts(rawPosts: unknown[]): InstagramPost[] {
    if (!rawPosts || !Array.isArray(rawPosts)) return [];

    return rawPosts.slice(0, 10).map((item) => {
        const post = item as Record<string, unknown>;
        const type = (post.type as string)?.toLowerCase() || 'image';

        const rawMentions = post.mentions as string[] | undefined;
        const mentionedUsers = Array.isArray(rawMentions) ? rawMentions : [];

        const taggedUsers: string[] = [];
        const rawTaggedUsers = post.taggedUsers as Array<{ username?: string }> | undefined;
        if (rawTaggedUsers && Array.isArray(rawTaggedUsers)) {
            for (const user of rawTaggedUsers) {
                if (user.username) taggedUsers.push(user.username);
            }
        }

        return {
            id: (post.id as string) || '',
            shortCode: (post.shortCode as string) || '',
            caption: post.caption as string | undefined,
            hashtags: Array.isArray(post.hashtags) ? (post.hashtags as string[]) : [],
            imageUrl: post.displayUrl as string | undefined,
            videoUrl: post.videoUrl as string | undefined,
            type: type === 'video' ? 'video' : type === 'sidecar' ? 'carousel' : 'image',
            likesCount: (post.likesCount as number) || 0,
            commentsCount: (post.commentsCount as number) || 0,
            timestamp: (post.timestamp as string) || '',
            taggedUsers,
            mentionedUsers,
        } as InstagramPost;
    });
}

async function getProfile(username: string): Promise<InstagramProfile | null> {
    try {
        const run = await client.actor('apify/instagram-profile-scraper').call({
            usernames: [username],
        });
        if (run.status === 'ABORTED') throw new Error('Scraping run aborted by user');

        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        if (items.length === 0) return null;

        const profile = items[0] as Record<string, unknown>;
        return {
            username: profile.username as string,
            fullName: profile.fullName as string | undefined,
            bio: profile.biography as string | undefined,
            profilePicUrl: profile.profilePicUrl as string | undefined,
            followersCount: profile.followersCount as number,
            followingCount: profile.followsCount as number,
            postsCount: profile.postsCount as number,
            isPrivate: profile.private as boolean,
            isVerified: profile.verified as boolean,
        };
    } catch (error) {
        console.error(`Failed to get profile for ${username}:`, error);
        return null;
    }
}

async function getFollowers(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const run = await client.actor('datadoping/instagram-followers-scraper').call({
        usernames: [username],
        max_count: limit,
    });
    if (run.status === 'ABORTED') throw new Error('스크래핑이 중단되었습니다.');
    if (run.status === 'FAILED') throw new Error('SCRAPING_ERROR: 팔로워 수집에 실패했습니다.');

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    if (items.length === 0) {
        throw new Error('SCRAPING_ERROR: 팔로워 목록을 가져올 수 없습니다. 계정 접근이 차단되었을 수 있습니다.');
    }

    return items.map((item: Record<string, unknown>) => ({
        username: item.username as string,
        fullName: item.full_name as string | undefined,
        profilePicUrl: item.profile_pic_url as string | undefined,
        isPrivate: (item.is_private as boolean) ?? false,
        isVerified: (item.is_verified as boolean) ?? false,
    }));
}

async function getProfilesBatch(usernames: string[], batchSize: number = 10): Promise<InstagramProfile[]> {
    const results: InstagramProfile[] = [];

    for (let i = 0; i < usernames.length; i += batchSize) {
        const batch = usernames.slice(i, i + batchSize);
        try {
            const run = await client.actor('apify/instagram-profile-scraper').call({ usernames: batch });
            if (run.status === 'ABORTED') throw new Error('Scraping run aborted by user');

            const { items } = await client.dataset(run.defaultDatasetId).listItems();
            for (const item of items) {
                const profile = item as Record<string, unknown>;
                results.push({
                    username: profile.username as string,
                    fullName: profile.fullName as string | undefined,
                    bio: profile.biography as string | undefined,
                    externalUrl: profile.externalUrl as string | undefined,
                    profilePicUrl: profile.profilePicUrl as string | undefined,
                    followersCount: profile.followersCount as number,
                    followingCount: profile.followsCount as number,
                    postsCount: profile.postsCount as number,
                    isPrivate: profile.private as boolean,
                    isVerified: profile.verified as boolean,
                    latestPosts: parseLatestPosts(profile.latestPosts as unknown[]),
                });
            }
        } catch (error) {
            console.error('Failed to get profiles batch:', error);
        }
    }
    return results;
}

export const apifyProvider: ScraperProvider = {
    name: 'apify',
    getProfile,
    getFollowers,
    getProfilesBatch,
};
```

- [ ] **Step 4: 테스트 + 타입체크**

Run: `npx vitest run lib/services/instagram/providers/apify.test.ts && npx tsc --noEmit`
Expected: PASS (1 passed), 타입 에러 없음

- [ ] **Step 5: Commit**

```bash
git add lib/services/instagram/providers/apify.ts lib/services/instagram/providers/apify.test.ts
git commit -m "refactor: extract apify logic into apifyProvider"
```

---

### Task 4: RapidAPI 프로바이더 분리 (providers/rapidapi.ts)

기존 `scraper.ts`의 RapidAPI following 로직을 복사한다(원본은 Task 8까지 유지).

**Files:**
- Create: `lib/services/instagram/providers/rapidapi.ts`
- Test: `lib/services/instagram/providers/rapidapi.test.ts`

**Interfaces:**
- Consumes: `ScraperProvider` (Task 1).
- Produces: `export const rapidApiProvider: ScraperProvider` (getFollowing만 구현).

- [ ] **Step 1: 테스트 작성**

Create `lib/services/instagram/providers/rapidapi.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { rapidApiProvider } from './rapidapi';

describe('rapidApiProvider', () => {
    it('getFollowing만 지원한다', () => {
        expect(rapidApiProvider.name).toBe('rapidapi');
        expect(typeof rapidApiProvider.getFollowing).toBe('function');
        expect(rapidApiProvider.getProfile).toBeUndefined();
        expect(rapidApiProvider.getFollowers).toBeUndefined();
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run lib/services/instagram/providers/rapidapi.test.ts`
Expected: FAIL ("Cannot find module './rapidapi'")

- [ ] **Step 3: rapidapi.ts 구현 (기존 로직 이동)**

Create `lib/services/instagram/providers/rapidapi.ts`:
```ts
import type { InstagramFollower } from '@/lib/types/instagram';
import type { ScraperProvider } from './types';

const RAPIDAPI_FOLLOWING_PATH = '/get_ig_user_followers_v2.php';

function getRapidApiConfig() {
    const key = process.env.RAPIDAPI_KEY;
    const host = process.env.RAPIDAPI_HOST;
    if (!key || !host) {
        throw new Error('SCRAPING_CONFIG_ERROR: RAPIDAPI_KEY와 RAPIDAPI_HOST가 설정되지 않았습니다.');
    }
    return { key, host, baseUrl: `https://${host}` };
}

function extractUserList(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    const record = data as Record<string, unknown>;
    for (const key of ['data', 'users', 'items', 'followers', 'following']) {
        const value = record[key];
        if (Array.isArray(value)) return value;
    }
    if ('0' in record) return Object.values(record);
    return [];
}

function mapFollowerItem(item: unknown): InstagramFollower | null {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const user = record.user && typeof record.user === 'object'
        ? (record.user as Record<string, unknown>)
        : record;
    const username = user.username;
    if (typeof username !== 'string' || username.length === 0) return null;

    return {
        username,
        fullName: (user.full_name || user.fullName) as string | undefined,
        profilePicUrl: (user.profile_pic_url || user.profilePicUrl) as string | undefined,
        isPrivate: (user.is_private ?? user.isPrivate ?? false) as boolean,
        isVerified: (user.is_verified ?? user.isVerified ?? false) as boolean,
    };
}

async function getFollowing(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const { key, host, baseUrl } = getRapidApiConfig();
    const body = new URLSearchParams({
        username_or_url: username,
        data: 'following',
        amount: String(limit),
    });

    const response = await fetch(`${baseUrl}${RAPIDAPI_FOLLOWING_PATH}`, {
        method: 'POST',
        headers: {
            'x-rapidapi-key': key,
            'x-rapidapi-host': host,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    });

    const text = await response.text();
    let data: unknown = text;
    try {
        data = JSON.parse(text);
    } catch {
        // API 장애 시 HTML/text 응답 가능
    }

    if (!response.ok) {
        throw new Error(`SCRAPING_ERROR: 팔로잉 수집에 실패했습니다. HTTP ${response.status}`);
    }
    if (data && typeof data === 'object' && ('error' in data || 'message' in data)) {
        const errorData = data as { error?: unknown; message?: unknown };
        throw new Error(`SCRAPING_ERROR: 팔로잉 수집에 실패했습니다. ${String(errorData.error || errorData.message)}`);
    }

    const items = extractUserList(data)
        .map(mapFollowerItem)
        .filter((item): item is InstagramFollower => item !== null)
        .slice(0, limit);

    if (items.length === 0) {
        throw new Error('SCRAPING_ERROR: 팔로잉 목록을 가져올 수 없습니다. 계정 접근이 제한되었을 수 있습니다.');
    }
    return items;
}

export const rapidApiProvider: ScraperProvider = {
    name: 'rapidapi',
    getFollowing,
};
```

- [ ] **Step 4: 테스트 + 타입체크**

Run: `npx vitest run lib/services/instagram/providers/rapidapi.test.ts && npx tsc --noEmit`
Expected: PASS, 타입 에러 없음

- [ ] **Step 5: Commit**

```bash
git add lib/services/instagram/providers/rapidapi.ts lib/services/instagram/providers/rapidapi.test.ts
git commit -m "refactor: extract rapidapi following into rapidApiProvider"
```

---

### Task 5: 자체 크롤러 매퍼 (selfhosted/mappers.ts)

인스타 `web_profile_info` 응답의 `data.user` JSON을 `InstagramProfile`/`InstagramPost`로 변환한다. 순수 함수 + 픽스처 단위테스트.

**Files:**
- Create: `lib/services/instagram/providers/selfhosted/mappers.ts`
- Create: `lib/services/instagram/providers/selfhosted/__fixtures__/web-profile-info.json`
- Test: `lib/services/instagram/providers/selfhosted/mappers.test.ts`

**Interfaces:**
- Produces: `mapUserToProfile(user: Record<string, unknown>): InstagramProfile`, `extractHashtags(caption?: string): string[]`, `extractMentions(caption?: string): string[]`.

- [ ] **Step 1: 픽스처 작성**

Create `lib/services/instagram/providers/selfhosted/__fixtures__/web-profile-info.json` (실제 응답 축약 형태):
```json
{
  "data": {
    "user": {
      "username": "sample_user",
      "full_name": "샘플 유저",
      "biography": "안녕하세요 @friend_a 놀러오세요 #daily #seoul",
      "external_url": "https://example.com",
      "profile_pic_url_hd": "https://cdn.example.com/pic_hd.jpg",
      "profile_pic_url": "https://cdn.example.com/pic.jpg",
      "is_private": false,
      "is_verified": true,
      "edge_followed_by": { "count": 1234 },
      "edge_follow": { "count": 321 },
      "edge_owner_to_timeline_media": {
        "count": 87,
        "edges": [
          {
            "node": {
              "id": "111",
              "shortcode": "ABC111",
              "__typename": "GraphImage",
              "display_url": "https://cdn.example.com/post1.jpg",
              "is_video": false,
              "taken_at_timestamp": 1700000000,
              "edge_media_preview_like": { "count": 42 },
              "edge_media_to_comment": { "count": 5 },
              "edge_media_to_caption": { "edges": [ { "node": { "text": "좋은 하루 @friend_b #선릉" } } ] },
              "edge_media_to_tagged_user": {
                "edges": [ { "node": { "user": { "username": "tagged_c" } } } ]
              }
            }
          },
          {
            "node": {
              "id": "222",
              "shortcode": "ABC222",
              "__typename": "GraphVideo",
              "display_url": "https://cdn.example.com/post2.jpg",
              "video_url": "https://cdn.example.com/post2.mp4",
              "is_video": true,
              "taken_at_timestamp": 1700000500,
              "edge_liked_by": { "count": 10 },
              "edge_media_to_comment": { "count": 1 },
              "edge_media_to_caption": { "edges": [] },
              "edge_media_to_tagged_user": { "edges": [] }
            }
          }
        ]
      }
    }
  }
}
```

- [ ] **Step 2: 실패 테스트 작성**

Create `lib/services/instagram/providers/selfhosted/mappers.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import fixture from './__fixtures__/web-profile-info.json';
import { mapUserToProfile, extractHashtags, extractMentions } from './mappers';

const user = (fixture as { data: { user: Record<string, unknown> } }).data.user;

describe('mapUserToProfile', () => {
    const profile = mapUserToProfile(user);

    it('프로필 스칼라 필드를 매핑한다', () => {
        expect(profile.username).toBe('sample_user');
        expect(profile.fullName).toBe('샘플 유저');
        expect(profile.followersCount).toBe(1234);
        expect(profile.followingCount).toBe(321);
        expect(profile.postsCount).toBe(87);
        expect(profile.isPrivate).toBe(false);
        expect(profile.isVerified).toBe(true);
        expect(profile.externalUrl).toBe('https://example.com');
    });

    it('profile_pic_url_hd를 우선 사용한다', () => {
        expect(profile.profilePicUrl).toBe('https://cdn.example.com/pic_hd.jpg');
    });

    it('게시물을 최대 10개, 타입/좋아요/이미지와 함께 매핑한다', () => {
        expect(profile.latestPosts).toHaveLength(2);
        const [p1, p2] = profile.latestPosts!;
        expect(p1.type).toBe('image');
        expect(p1.imageUrl).toBe('https://cdn.example.com/post1.jpg');
        expect(p1.likesCount).toBe(42);
        expect(p1.commentsCount).toBe(5);
        expect(p2.type).toBe('video');
        expect(p2.videoUrl).toBe('https://cdn.example.com/post2.mp4');
        expect(p2.likesCount).toBe(10);
    });

    it('캡션에서 태그된 유저, 멘션, 해시태그를 추출한다', () => {
        const [p1] = profile.latestPosts!;
        expect(p1.taggedUsers).toContain('tagged_c');
        expect(p1.mentionedUsers).toContain('friend_b');
        expect(p1.hashtags).toContain('선릉');
    });
});

describe('extractHashtags / extractMentions', () => {
    it('해시태그를 # 없이 추출한다', () => {
        expect(extractHashtags('a #one 그리고 #둘_2 끝')).toEqual(['one', '둘_2']);
    });
    it('멘션을 @ 없이 추출한다', () => {
        expect(extractMentions('hi @friend_a and @b.c_1')).toEqual(['friend_a', 'b.c_1']);
    });
    it('빈 입력은 빈 배열', () => {
        expect(extractHashtags(undefined)).toEqual([]);
        expect(extractMentions(undefined)).toEqual([]);
    });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/mappers.test.ts`
Expected: FAIL ("Cannot find module './mappers'")

- [ ] **Step 4: mappers.ts 구현**

Create `lib/services/instagram/providers/selfhosted/mappers.ts`:
```ts
import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';

export function extractHashtags(caption?: string): string[] {
    if (!caption) return [];
    return (caption.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1));
}

export function extractMentions(caption?: string): string[] {
    if (!caption) return [];
    return (caption.match(/@[A-Za-z0-9._]+/g) || []).map((m) => m.slice(1));
}

function num(value: unknown): number {
    return typeof value === 'number' ? value : 0;
}

function count(node: Record<string, unknown>, key: string): number {
    const edge = node[key] as { count?: unknown } | undefined;
    return num(edge?.count);
}

function mapPost(node: Record<string, unknown>): InstagramPost {
    const typename = node.__typename as string | undefined;
    const type: InstagramPost['type'] =
        typename === 'GraphVideo' || node.is_video === true
            ? 'video'
            : typename === 'GraphSidecar'
              ? 'carousel'
              : 'image';

    const captionEdges = (node.edge_media_to_caption as { edges?: Array<{ node?: { text?: unknown } }> })?.edges;
    const caption =
        Array.isArray(captionEdges) && captionEdges[0]?.node?.text
            ? String(captionEdges[0].node.text)
            : undefined;

    const taggedEdges = (node.edge_media_to_tagged_user as { edges?: Array<{ node?: { user?: { username?: unknown } } }> })?.edges;
    const taggedUsers: string[] = [];
    if (Array.isArray(taggedEdges)) {
        for (const e of taggedEdges) {
            const u = e?.node?.user?.username;
            if (typeof u === 'string') taggedUsers.push(u);
        }
    }

    const likes =
        count(node, 'edge_media_preview_like') || count(node, 'edge_liked_by');

    return {
        id: (node.id as string) || '',
        shortCode: (node.shortcode as string) || '',
        caption,
        hashtags: extractHashtags(caption),
        imageUrl: node.display_url as string | undefined,
        videoUrl: node.video_url as string | undefined,
        type,
        likesCount: likes,
        commentsCount: count(node, 'edge_media_to_comment'),
        timestamp: node.taken_at_timestamp ? String(node.taken_at_timestamp) : '',
        taggedUsers,
        mentionedUsers: extractMentions(caption),
    };
}

export function mapUserToProfile(user: Record<string, unknown>): InstagramProfile {
    const mediaEdges = (user.edge_owner_to_timeline_media as { edges?: Array<{ node?: Record<string, unknown> }> })?.edges;
    const latestPosts: InstagramPost[] = Array.isArray(mediaEdges)
        ? mediaEdges
              .slice(0, 10)
              .map((e) => (e?.node ? mapPost(e.node) : null))
              .filter((p): p is InstagramPost => p !== null)
        : [];

    return {
        username: user.username as string,
        fullName: user.full_name as string | undefined,
        bio: user.biography as string | undefined,
        externalUrl: user.external_url as string | undefined,
        profilePicUrl: (user.profile_pic_url_hd || user.profile_pic_url) as string | undefined,
        followersCount: count(user, 'edge_followed_by'),
        followingCount: count(user, 'edge_follow'),
        postsCount: count(user, 'edge_owner_to_timeline_media'),
        isPrivate: (user.is_private as boolean) ?? false,
        isVerified: (user.is_verified as boolean) ?? false,
        latestPosts,
    };
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/mappers.test.ts`
Expected: PASS (7 passed)

- [ ] **Step 6: Commit**

```bash
git add lib/services/instagram/providers/selfhosted/mappers.ts lib/services/instagram/providers/selfhosted/mappers.test.ts lib/services/instagram/providers/selfhosted/__fixtures__/web-profile-info.json
git commit -m "feat: add web_profile_info -> InstagramProfile mappers"
```

---

### Task 6: 자체 크롤러 transport + rate-limit

무료 우선 요청 전송 계층. transport 모드(direct/scrape-api/http-proxy)와 동시성 제한/재시도.

**Files:**
- Create: `lib/services/instagram/providers/selfhosted/transport.ts`
- Create: `lib/services/instagram/providers/selfhosted/rate-limit.ts`
- Test: `lib/services/instagram/providers/selfhosted/transport.test.ts`
- Test: `lib/services/instagram/providers/selfhosted/rate-limit.test.ts`

**Interfaces:**
- Produces (transport): `getTransportConfig(env?): TransportConfig`, `buildRequest(targetUrl, cfg): { url: string; dispatcher?: unknown }`, `TransportConfig` 타입, `TransportMode` 타입.
- Produces (rate-limit): `pLimit(concurrency): <T>(fn: () => Promise<T>) => Promise<T>`, `withRetry<T>(fn, opts?): Promise<T>`.

- [ ] **Step 1: rate-limit 실패 테스트 작성**

Create `lib/services/instagram/providers/selfhosted/rate-limit.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { pLimit, withRetry } from './rate-limit';

describe('pLimit', () => {
    it('동시 실행 수를 제한한다', async () => {
        const limit = pLimit(2);
        let active = 0;
        let maxActive = 0;
        const task = () =>
            limit(async () => {
                active++;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 10));
                active--;
            });
        await Promise.all(Array.from({ length: 6 }, task));
        expect(maxActive).toBeLessThanOrEqual(2);
    });
});

describe('withRetry', () => {
    it('실패 후 재시도하여 성공하면 값을 반환한다', async () => {
        const fn = vi.fn()
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce('ok');
        const result = await withRetry(fn, { retries: 2, baseDelayMs: 1 });
        expect(result).toBe('ok');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    it('재시도 소진 시 마지막 에러를 throw한다', async () => {
        const fn = vi.fn().mockRejectedValue(new Error('always'));
        await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toThrow('always');
        expect(fn).toHaveBeenCalledTimes(3);
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/rate-limit.test.ts`
Expected: FAIL ("Cannot find module './rate-limit'")

- [ ] **Step 3: rate-limit.ts 구현**

Create `lib/services/instagram/providers/selfhosted/rate-limit.ts`:
```ts
/** 동시 실행 개수를 concurrency로 제한하는 러너를 만든다. */
export function pLimit(concurrency: number) {
    let active = 0;
    const queue: Array<() => void> = [];

    const next = () => {
        active--;
        const run = queue.shift();
        if (run) run();
    };

    return function <T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const run = () => {
                active++;
                fn().then(resolve, reject).finally(next);
            };
            if (active < concurrency) run();
            else queue.push(run);
        });
    };
}

export interface RetryOptions {
    retries?: number;
    baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 지수 백오프 + 지터로 재시도. retries회 추가 시도. */
export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions = {}
): Promise<T> {
    const retries = opts.retries ?? 2;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                const jitter = Math.random() * baseDelayMs;
                await sleep(baseDelayMs * 2 ** attempt + jitter);
            }
        }
    }
    throw lastError;
}
```

- [ ] **Step 4: rate-limit 통과 확인**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/rate-limit.test.ts`
Expected: PASS (3 passed)

- [ ] **Step 5: transport 실패 테스트 작성**

Create `lib/services/instagram/providers/selfhosted/transport.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { getTransportConfig, buildRequest } from './transport';

describe('getTransportConfig', () => {
    it('기본은 direct', () => {
        expect(getTransportConfig({}).mode).toBe('direct');
    });
    it('env로 모드를 고른다', () => {
        const c = getTransportConfig({ IG_TRANSPORT: 'http-proxy', IG_PROXY_URL: 'http://u:p@host:1' });
        expect(c.mode).toBe('http-proxy');
        expect(c.proxyUrl).toBe('http://u:p@host:1');
    });
});

describe('buildRequest', () => {
    const target = 'https://www.instagram.com/api/v1/users/web_profile_info/?username=x';

    it('direct는 타겟 URL을 그대로 쓴다', () => {
        const { url, dispatcher } = buildRequest(target, { mode: 'direct' });
        expect(url).toBe(target);
        expect(dispatcher).toBeUndefined();
    });

    it('scrape-api는 타겟을 래핑한다', () => {
        const { url } = buildRequest(target, {
            mode: 'scrape-api',
            scrapeApiUrl: 'http://api.scraperapi.com',
            scrapeApiKey: 'KEY',
        });
        expect(url).toContain('api.scraperapi.com');
        expect(url).toContain('api_key=KEY');
        expect(url).toContain(encodeURIComponent(target));
    });

    it('http-proxy는 dispatcher를 반환한다', () => {
        const { url, dispatcher } = buildRequest(target, {
            mode: 'http-proxy',
            proxyUrl: 'http://u:p@host:1',
        });
        expect(url).toBe(target);
        expect(dispatcher).toBeDefined();
    });
});
```

- [ ] **Step 6: 실패 확인**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/transport.test.ts`
Expected: FAIL ("Cannot find module './transport'")

- [ ] **Step 7: transport.ts 구현**

Create `lib/services/instagram/providers/selfhosted/transport.ts`:
```ts
import { ProxyAgent } from 'undici';

export type TransportMode = 'direct' | 'scrape-api' | 'http-proxy';

export interface TransportConfig {
    mode: TransportMode;
    scrapeApiUrl?: string;
    scrapeApiKey?: string;
    proxyUrl?: string;
}

export function getTransportConfig(
    env: Record<string, string | undefined> = process.env
): TransportConfig {
    const raw = (env.IG_TRANSPORT || 'direct').trim();
    const mode: TransportMode =
        raw === 'scrape-api' || raw === 'http-proxy' ? raw : 'direct';
    return {
        mode,
        scrapeApiUrl: env.IG_SCRAPE_API_URL,
        scrapeApiKey: env.IG_SCRAPE_API_KEY,
        proxyUrl: env.IG_PROXY_URL,
    };
}

/**
 * transport 모드에 맞춰 실제 요청 URL과 (필요 시) undici dispatcher를 만든다.
 * dispatcher는 fetch 옵션의 `dispatcher`로 넘긴다 (Node/undici 확장).
 */
export function buildRequest(
    targetUrl: string,
    cfg: TransportConfig
): { url: string; dispatcher?: ProxyAgent } {
    if (cfg.mode === 'scrape-api') {
        if (!cfg.scrapeApiUrl || !cfg.scrapeApiKey) {
            throw new Error('SCRAPING_CONFIG_ERROR: IG_SCRAPE_API_URL/KEY가 설정되지 않았습니다.');
        }
        const sep = cfg.scrapeApiUrl.includes('?') ? '&' : '?';
        const url = `${cfg.scrapeApiUrl}${sep}api_key=${encodeURIComponent(cfg.scrapeApiKey)}&url=${encodeURIComponent(targetUrl)}`;
        return { url };
    }
    if (cfg.mode === 'http-proxy') {
        if (!cfg.proxyUrl) {
            throw new Error('SCRAPING_CONFIG_ERROR: IG_PROXY_URL이 설정되지 않았습니다.');
        }
        return { url: targetUrl, dispatcher: new ProxyAgent(cfg.proxyUrl) };
    }
    return { url: targetUrl };
}
```

- [ ] **Step 8: transport 통과 확인 + 타입체크**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/transport.test.ts && npx tsc --noEmit`
Expected: PASS (5 passed), 타입 에러 없음

- [ ] **Step 9: Commit**

```bash
git add lib/services/instagram/providers/selfhosted/transport.ts lib/services/instagram/providers/selfhosted/rate-limit.ts lib/services/instagram/providers/selfhosted/transport.test.ts lib/services/instagram/providers/selfhosted/rate-limit.test.ts
git commit -m "feat: add selfhosted transport (free-first) + rate limiting"
```

---

### Task 7: 자체 크롤러 web-client + 프로바이더 + 2단계 스캐폴드

**Files:**
- Create: `lib/services/instagram/providers/selfhosted/web-client.ts`
- Create: `lib/services/instagram/providers/selfhosted/followers-client.ts`
- Create: `lib/services/instagram/providers/selfhosted/session.ts`
- Create: `lib/services/instagram/providers/selfhosted/index.ts`
- Test: `lib/services/instagram/providers/selfhosted/index.test.ts`

**Interfaces:**
- Consumes: `mapUserToProfile` (Task 5), `getTransportConfig`/`buildRequest` (Task 6), `pLimit`/`withRetry` (Task 6), `ScraperProvider` (Task 1).
- Produces: `export const selfHostedProvider: ScraperProvider` (getProfile, getProfilesBatch 구현; getFollowers/getFollowing은 2단계 미구현 throw). `fetchWebProfileUser(username, deps?): Promise<Record<string,unknown> | null>` (web-client, null=계정없음, throw=차단/오류).

- [ ] **Step 1: 실패 테스트 작성 (의존성 주입으로 네트워크 없이 검증)**

Create `lib/services/instagram/providers/selfhosted/index.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import fixture from './__fixtures__/web-profile-info.json';
import { makeSelfHostedProvider } from './index';

const user = (fixture as { data: { user: Record<string, unknown> } }).data.user;

describe('selfHostedProvider', () => {
    it('getProfile은 web-client 결과를 InstagramProfile로 매핑한다', async () => {
        const fetchUser = vi.fn().mockResolvedValue(user);
        const provider = makeSelfHostedProvider({ fetchUser });
        const profile = await provider.getProfile!('sample_user');
        expect(profile?.username).toBe('sample_user');
        expect(profile?.latestPosts).toHaveLength(2);
        expect(fetchUser).toHaveBeenCalledWith('sample_user');
    });

    it('getProfile은 계정 없음(null)을 그대로 null로 반환한다', async () => {
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn().mockResolvedValue(null) });
        expect(await provider.getProfile!('ghost')).toBeNull();
    });

    it('getProfilesBatch는 개별 실패를 건너뛰고 성공분만 모은다', async () => {
        const fetchUser = vi.fn()
            .mockResolvedValueOnce(user)
            .mockRejectedValueOnce(new Error('blocked'));
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });
        const results = await provider.getProfilesBatch!(['a', 'b']);
        expect(results).toHaveLength(1);
        expect(results[0].username).toBe('sample_user');
    });

    it('getFollowers는 2단계 미구현 에러를 throw한다', async () => {
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn() });
        await expect(provider.getFollowers!('x', 10)).rejects.toThrow('2단계');
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/index.test.ts`
Expected: FAIL ("Cannot find module './index'")

- [ ] **Step 3: web-client.ts 구현**

Create `lib/services/instagram/providers/selfhosted/web-client.ts`:
```ts
import { getTransportConfig, buildRequest, type TransportConfig } from './transport';

const IG_APP_ID = '936619743392459';
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function profileUrl(username: string): string {
    return `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
}

/**
 * web_profile_info를 호출해 data.user를 반환.
 * - 계정 없음(404/유효 JSON에 user 없음) → null
 * - 차단/네트워크/파싱 오류 → throw (라우터 폴백 트리거 가능)
 */
export async function fetchWebProfileUser(
    username: string,
    cfg: TransportConfig = getTransportConfig()
): Promise<Record<string, unknown> | null> {
    const { url, dispatcher } = buildRequest(profileUrl(username), cfg);

    const response = await fetch(url, {
        headers: {
            'x-ig-app-id': IG_APP_ID,
            'User-Agent': USER_AGENT,
            Accept: '*/*',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
        },
        // undici 확장 옵션
        ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);

    if (response.status === 404) return null;
    if (!response.ok) {
        throw new Error(`SCRAPING_ERROR: web_profile_info 요청 실패 (HTTP ${response.status}).`);
    }

    let json: unknown;
    try {
        json = await response.json();
    } catch {
        throw new Error('SCRAPING_ERROR: 프로필 응답 파싱 실패 (차단되었을 수 있습니다).');
    }

    const user = (json as { data?: { user?: Record<string, unknown> } })?.data?.user;
    if (!user || typeof user !== 'object') return null;
    return user;
}
```

- [ ] **Step 4: 2단계 스캐폴드 (followers-client.ts, session.ts)**

Create `lib/services/instagram/providers/selfhosted/session.ts`:
```ts
/**
 * [2단계 스캐폴드] 팔로워/팔로잉 자체 수집용 인스타 계정 세션 관리.
 * 계정 풀 + 세션 쿠키 로테이션이 여기에 구현될 예정. 현재는 미구현.
 */
export interface IgSession {
    sessionId: string;
    csrfToken: string;
    userId: string;
}

export function getSessionPool(): IgSession[] {
    return [];
}
```

Create `lib/services/instagram/providers/selfhosted/followers-client.ts`:
```ts
import type { InstagramFollower } from '@/lib/types/instagram';

const NOT_IMPLEMENTED =
    'SCRAPING_ERROR: 자체 팔로워/팔로잉 수집은 2단계에서 지원됩니다. 현재는 SCRAPER_FOLLOWERS/FOLLOWING을 apify/rapidapi로 두거나 SCRAPER_FALLBACK=true를 사용하세요.';

/** [2단계 스캐폴드] friendships/{id}/followers — 세션 필요. 현재 미구현. */
export async function fetchFollowers(_username: string, _limit: number): Promise<InstagramFollower[]> {
    throw new Error(NOT_IMPLEMENTED);
}

/** [2단계 스캐폴드] friendships/{id}/following — 세션 필요. 현재 미구현. */
export async function fetchFollowing(_username: string, _limit: number): Promise<InstagramFollower[]> {
    throw new Error(NOT_IMPLEMENTED);
}
```

- [ ] **Step 5: index.ts (SelfHostedProvider) 구현**

Create `lib/services/instagram/providers/selfhosted/index.ts`:
```ts
import type { InstagramProfile } from '@/lib/types/instagram';
import type { ScraperProvider } from '../types';
import { mapUserToProfile } from './mappers';
import { pLimit, withRetry } from './rate-limit';
import { fetchWebProfileUser } from './web-client';
import { fetchFollowers, fetchFollowing } from './followers-client';

interface SelfHostedDeps {
    fetchUser?: (username: string) => Promise<Record<string, unknown> | null>;
    concurrency?: number;
    retries?: number;
}

export function makeSelfHostedProvider(deps: SelfHostedDeps = {}): ScraperProvider {
    const fetchUser = deps.fetchUser ?? ((u: string) => fetchWebProfileUser(u));
    const concurrency = deps.concurrency ?? 3;
    const retries = deps.retries ?? 2;

    async function getProfile(username: string): Promise<InstagramProfile | null> {
        const user = await withRetry(() => fetchUser(username), { retries });
        return user ? mapUserToProfile(user) : null;
    }

    async function getProfilesBatch(usernames: string[]): Promise<InstagramProfile[]> {
        const limit = pLimit(concurrency);
        const settled = await Promise.allSettled(
            usernames.map((u) =>
                limit(async () => {
                    const user = await withRetry(() => fetchUser(u), { retries });
                    return user ? mapUserToProfile(user) : null;
                })
            )
        );
        const results: InstagramProfile[] = [];
        for (const s of settled) {
            if (s.status === 'fulfilled' && s.value) results.push(s.value);
        }
        return results;
    }

    return {
        name: 'selfhosted',
        getProfile,
        getProfilesBatch,
        getFollowers: (username: string, limit: number) => fetchFollowers(username, limit),
        getFollowing: (username: string, limit: number) => fetchFollowing(username, limit),
    };
}

export const selfHostedProvider: ScraperProvider = makeSelfHostedProvider();
```

- [ ] **Step 6: 테스트 통과 확인 + 타입체크**

Run: `npx vitest run lib/services/instagram/providers/selfhosted/index.test.ts && npx tsc --noEmit`
Expected: PASS (4 passed), 타입 에러 없음

- [ ] **Step 7: Commit**

```bash
git add lib/services/instagram/providers/selfhosted/web-client.ts lib/services/instagram/providers/selfhosted/followers-client.ts lib/services/instagram/providers/selfhosted/session.ts lib/services/instagram/providers/selfhosted/index.ts lib/services/instagram/providers/selfhosted/index.test.ts
git commit -m "feat: add selfhosted web-client + provider (phase 2 scaffold)"
```

---

### Task 8: 라우터 (scraper.ts 재작성) + 자동 폴백

`scraper.ts`를 프로바이더 위임 라우터로 재작성한다. 공개 함수 시그니처는 유지하고, 인라인 Apify/RapidAPI 구현은 제거(providers로 이동 완료). 순수 헬퍼(`extractMutualFollows`, `classifyByPrivacy`)는 유지.

**Files:**
- Modify: `lib/services/instagram/scraper.ts` (전체 재작성)
- Test: `lib/services/instagram/scraper.test.ts`

**Interfaces:**
- Consumes: `getScraperConfig`, `EXTERNAL_DEFAULT` (Task 2); `apifyProvider` (Task 3), `rapidApiProvider` (Task 4), `selfHostedProvider` (Task 7); `ScraperProvider`, `Capability` (Task 1).
- Produces (시그니처 불변): `getInstagramProfile`, `getFollowers`, `getFollowing`, `getProfilesBatch`, `extractMutualFollows`, `classifyByPrivacy`. 신규: `__setProvidersForTest(map)` (테스트 주입용).

- [ ] **Step 1: 라우터/폴백 실패 테스트 작성**

Create `lib/services/instagram/scraper.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ScraperProvider } from './providers/types';
import {
    getInstagramProfile,
    extractMutualFollows,
    classifyByPrivacy,
    __setProvidersForTest,
    __resetProvidersForTest,
} from './scraper';

afterEach(() => __resetProvidersForTest());

function providerWith(over: Partial<ScraperProvider>): ScraperProvider {
    return { name: 'selfhosted', ...over } as ScraperProvider;
}

describe('라우팅', () => {
    it('SCRAPER_PROFILE=selfhosted면 selfhosted.getProfile을 쓴다', async () => {
        const getProfile = vi.fn().mockResolvedValue({ username: 'x' });
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted' },
            { selfhosted: providerWith({ name: 'selfhosted', getProfile }) }
        );
        const p = await getInstagramProfile('x');
        expect(p).toEqual({ username: 'x' });
        expect(getProfile).toHaveBeenCalledWith('x');
    });
});

describe('폴백', () => {
    it('fallback=true면 selfhosted 실패 시 외부(apify)로 폴백한다', async () => {
        const selfFail = vi.fn().mockRejectedValue(new Error('SCRAPING_ERROR: blocked'));
        const apifyOk = vi.fn().mockResolvedValue({ username: 'fallback' });
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted', SCRAPER_FALLBACK: 'true' },
            {
                selfhosted: providerWith({ name: 'selfhosted', getProfile: selfFail }),
                apify: providerWith({ name: 'apify', getProfile: apifyOk }),
            }
        );
        const p = await getInstagramProfile('x');
        expect(p).toEqual({ username: 'fallback' });
        expect(selfFail).toHaveBeenCalled();
        expect(apifyOk).toHaveBeenCalled();
    });

    it('fallback=false면 selfhosted 실패가 그대로 throw된다', async () => {
        const selfFail = vi.fn().mockRejectedValue(new Error('SCRAPING_ERROR: blocked'));
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted', SCRAPER_FALLBACK: 'false' },
            { selfhosted: providerWith({ name: 'selfhosted', getProfile: selfFail }) }
        );
        await expect(getInstagramProfile('x')).rejects.toThrow('blocked');
    });
});

describe('순수 헬퍼', () => {
    it('extractMutualFollows는 교집합을 낸다', () => {
        const a = [{ username: 'u1' }, { username: 'u2' }] as never[];
        const b = [{ username: 'u2' }, { username: 'u3' }] as never[];
        expect(extractMutualFollows(a, b).map((x) => x.username)).toEqual(['u2']);
    });
    it('classifyByPrivacy는 공개/비공개로 나눈다', () => {
        const accts = [
            { username: 'a', isPrivate: false },
            { username: 'b', isPrivate: true },
        ] as never[];
        const { publicAccounts, privateAccounts } = classifyByPrivacy(accts);
        expect(publicAccounts).toHaveLength(1);
        expect(privateAccounts).toHaveLength(1);
    });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx vitest run lib/services/instagram/scraper.test.ts`
Expected: FAIL (`__setProvidersForTest` export 없음)

- [ ] **Step 3: scraper.ts 재작성**

Replace 전체 내용 of `lib/services/instagram/scraper.ts`:
```ts
import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';
import type { Capability, ProviderName, ScraperProvider } from './providers/types';
import { getScraperConfig, EXTERNAL_DEFAULT, type ScraperConfig } from './config';
import { apifyProvider } from './providers/apify';
import { rapidApiProvider } from './providers/rapidapi';
import { selfHostedProvider } from './providers/selfhosted';

// ── 프로바이더 레지스트리 (테스트에서 주입 가능) ──
let providers: Record<ProviderName, ScraperProvider> = {
    apify: apifyProvider,
    rapidapi: rapidApiProvider,
    selfhosted: selfHostedProvider,
};
let configOverride: Record<string, string | undefined> | null = null;

function config(): ScraperConfig {
    return getScraperConfig(configOverride ?? process.env);
}

/** 지정한 프로바이더의 메서드를 실행하고, 필요 시 외부 기본 프로바이더로 폴백한다. */
async function route<T>(
    capability: Capability,
    selected: ProviderName,
    call: (p: ScraperProvider) => Promise<T> | undefined,
    fallbackEnabled: boolean
): Promise<T> {
    const primary = providers[selected];
    const primaryCall = primary && call(primary);
    if (primaryCall === undefined) {
        throw new Error(`SCRAPING_ERROR: 프로바이더 '${selected}'가 '${capability}'를 지원하지 않습니다.`);
    }
    try {
        return await primaryCall;
    } catch (error) {
        const external = EXTERNAL_DEFAULT[capability];
        if (fallbackEnabled && selected === 'selfhosted' && external !== 'selfhosted') {
            const fb = providers[external];
            const fbCall = fb && call(fb);
            if (fbCall !== undefined) {
                console.warn(`[scraper] selfhosted ${capability} 실패 → ${external}로 폴백:`, error);
                return await fbCall;
            }
        }
        throw error;
    }
}

export async function getInstagramProfile(username: string): Promise<InstagramProfile | null> {
    const c = config();
    return route('profile', c.profile, (p) => p.getProfile?.(username), c.fallback);
}

export async function getFollowers(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const c = config();
    return route('followers', c.followers, (p) => p.getFollowers?.(username, limit), c.fallback);
}

export async function getFollowing(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const c = config();
    return route('following', c.following, (p) => p.getFollowing?.(username, limit), c.fallback);
}

export async function getProfilesBatch(usernames: string[], batchSize?: number): Promise<InstagramProfile[]> {
    const c = config();
    return route('profilesBatch', c.profilesBatch, (p) => p.getProfilesBatch?.(usernames, batchSize), c.fallback);
}

// ── 프로바이더 무관 순수 헬퍼 ──
export function extractMutualFollows(
    followers: InstagramFollower[],
    following: InstagramFollower[]
): InstagramFollower[] {
    const followerSet = new Set(followers.map((f) => f.username));
    return following.filter((f) => followerSet.has(f.username));
}

export function classifyByPrivacy(accounts: InstagramFollower[]): {
    publicAccounts: InstagramFollower[];
    privateAccounts: InstagramFollower[];
} {
    return {
        publicAccounts: accounts.filter((a) => !a.isPrivate),
        privateAccounts: accounts.filter((a) => a.isPrivate),
    };
}

// ── 테스트 전용 훅 ──
export function __setProvidersForTest(
    env: Record<string, string | undefined>,
    overrides: Partial<Record<ProviderName, ScraperProvider>>
): void {
    configOverride = env;
    providers = { ...providers, ...overrides } as Record<ProviderName, ScraperProvider>;
}

export function __resetProvidersForTest(): void {
    configOverride = null;
    providers = { apify: apifyProvider, rapidapi: rapidApiProvider, selfhosted: selfHostedProvider };
}
```

- [ ] **Step 4: 테스트 통과 확인 + 타입체크 + 린트**

Run: `npx vitest run lib/services/instagram/scraper.test.ts && npx tsc --noEmit && npm run lint`
Expected: PASS (전체), 타입/린트 에러 없음

- [ ] **Step 5: 전체 테스트 실행**

Run: `npm test`
Expected: 모든 테스트 PASS

- [ ] **Step 6: Commit**

```bash
git add lib/services/instagram/scraper.ts lib/services/instagram/scraper.test.ts
git commit -m "refactor: make scraper.ts a provider router with fallback"
```

---

### Task 9: 문서화 + env 예시 + 스모크 스크립트

프로바이더 전환 방법을 코드베이스에 남긴다(다른 세션이 찾을 수 있게). 무료 조달 옵션도 요약.

**Files:**
- Create: `lib/services/instagram/README.md`
- Create: `lib/services/instagram/providers/selfhosted/web-client.smoke.test.ts`
- Modify: `.env.example` (SCRAPER_*, IG_TRANSPORT 블록 추가)
- Modify: `CLAUDE.md` (아키텍처 섹션에 전환 요약 + README 링크)

- [ ] **Step 1: README.md 작성**

Create `lib/services/instagram/README.md`:
```markdown
# 인스타그램 스크래핑 프로바이더 전환 가이드

수집 기능 4개를 각각 외부(Apify/RapidAPI) 또는 자체 호스팅 크롤러로 **env로 전환**한다.
`scraper.ts`는 라우터이고 실제 구현은 `providers/*`에 있다. 공개 함수 시그니처는 고정.

## 전환 스위치 (env)

| env | 허용값 | 기본값 | 대상 기능 |
|---|---|---|---|
| `SCRAPER_PROFILE` | `apify` \| `selfhosted` | `apify` | 대상 프로필 1건 |
| `SCRAPER_PROFILES_BATCH` | `apify` \| `selfhosted` | `apify` | 프로필+게시물 배치(비용 대부분) |
| `SCRAPER_FOLLOWERS` | `apify` \| `selfhosted` | `apify` | 팔로워 목록 (selfhosted는 2단계 미구현) |
| `SCRAPER_FOLLOWING` | `rapidapi` \| `selfhosted` | `rapidapi` | 팔로잉 목록 (selfhosted는 2단계 미구현) |
| `SCRAPER_FALLBACK` | `true` \| `false` | `false` | selfhosted 실패 시 외부로 자동 폴백 |

## 절차

- **외부 → 자체 전환**: 해당 `SCRAPER_*`를 `selfhosted`로. 재배포 불필요(런타임 env 읽음). 1단계는 `SCRAPER_PROFILES_BATCH=selfhosted`(+`SCRAPER_PROFILE=selfhosted`)만 켠다.
- **자체 → 외부 복원**: 값을 `apify`/`rapidapi`로 되돌린다. 외부 코드는 `providers/apify.ts`, `providers/rapidapi.ts`에 그대로 있다.
- **안전 전환**: `SCRAPER_FALLBACK=true`로 두면 자체 실패 시 자동으로 외부로 폴백(무중단).

## 자체 크롤러 transport (무료 우선)

selfhosted는 `web_profile_info`(로그인 불필요)로 프로필+게시물을 수집한다. 요청 경로는 `IG_TRANSPORT`로 고른다.

| `IG_TRANSPORT` | 비용 | 설명 |
|---|---|---|
| `direct` (기본) | 무료 | 실행 환경 IP로 직접. 자택 상시 머신(레지던셜 IP)에서 돌리면 무료+저차단. Vercel(데이터센터 IP)은 소량만. |
| `scrape-api` | 무료 티어 | ScraperAPI(월 1,000요청 무료) 등 무료 크레딧 언블록 프록시. `IG_SCRAPE_API_URL`+`IG_SCRAPE_API_KEY`. Vercel에서 바로 사용. |
| `http-proxy` | 유료 | 레지던셜 프록시 `IG_PROXY_URL`. 볼륨 확장 시. |

**무료 최우선 권장**: Vercel에선 `scrape-api` 무료 티어로 시작 → 처리량 필요 시 자택 워커+`direct`.

## 2단계 (팔로워/팔로잉 자체화, 미구현)

`providers/selfhosted/followers-client.ts`, `session.ts`는 스캐폴드다. 계정 세션 풀이 필요하며 현재는 호출 시 에러를 던진다. 그때까지 팔로워/팔로잉은 외부 유지 또는 `SCRAPER_FALLBACK=true` 사용.
```

- [ ] **Step 2: .env.example에 블록 추가**

`.env.example` 맨 아래에 추가:
```bash

# ── 스크래핑 프로바이더 스위치 (자세한 내용: lib/services/instagram/README.md) ──
SCRAPER_PROFILE=apify            # apify | selfhosted
SCRAPER_PROFILES_BATCH=apify     # apify | selfhosted
SCRAPER_FOLLOWERS=apify          # apify | selfhosted (selfhosted는 2단계 미구현)
SCRAPER_FOLLOWING=rapidapi       # rapidapi | selfhosted (selfhosted는 2단계 미구현)
SCRAPER_FALLBACK=false           # true면 selfhosted 실패 시 외부로 자동 폴백

# 자체 크롤러 transport (selfhosted 사용 시, 무료 우선)
IG_TRANSPORT=direct              # direct | scrape-api | http-proxy
IG_SCRAPE_API_URL=               # scrape-api 모드 (예: http://api.scraperapi.com)
IG_SCRAPE_API_KEY=
IG_PROXY_URL=                    # http-proxy 모드 (예: http://user:pass@host:port)
```

- [ ] **Step 3: CLAUDE.md 아키텍처 섹션 갱신**

`CLAUDE.md`의 "Instagram Scraping: Apify" 관련 서술 근처(Tech Stack 하단 또는 Architecture)에 아래 문단 추가:
```markdown
### Instagram Scraping (전환 가능)
스크래핑은 기능별로 외부/자체 프로바이더를 env로 전환한다. `lib/services/instagram/scraper.ts`는 라우터이고, `SCRAPER_PROFILE`/`SCRAPER_PROFILES_BATCH`/`SCRAPER_FOLLOWERS`/`SCRAPER_FOLLOWING`으로 `apify`/`rapidapi`/`selfhosted` 중 선택한다. `SCRAPER_FALLBACK=true`면 자체 실패 시 외부로 자동 폴백. 자세한 전환 방법은 `lib/services/instagram/README.md` 참고.
```

- [ ] **Step 4: 스모크 테스트 작성 (기본 skip)**

Create `lib/services/instagram/providers/selfhosted/web-client.smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { fetchWebProfileUser } from './web-client';
import { mapUserToProfile } from './mappers';

// 실제 인스타 호출. 기본 skip. 실행: RUN_SMOKE=1 IG_TRANSPORT=direct npx vitest run **/web-client.smoke.test.ts
const run = process.env.RUN_SMOKE === '1';

describe.skipIf(!run)('web-client 스모크 (실네트워크)', () => {
    it('공개 계정 프로필을 가져와 매핑한다', async () => {
        const user = await fetchWebProfileUser('instagram');
        expect(user).not.toBeNull();
        const profile = mapUserToProfile(user!);
        expect(profile.username).toBe('instagram');
        expect(profile.followersCount).toBeGreaterThan(0);
    }, 30_000);
});
```

- [ ] **Step 5: 전체 테스트가 여전히 통과하는지 확인 (스모크는 skip)**

Run: `npm test`
Expected: 모든 테스트 PASS, 스모크는 skipped

- [ ] **Step 6: Commit**

```bash
git add lib/services/instagram/README.md lib/services/instagram/providers/selfhosted/web-client.smoke.test.ts .env.example CLAUDE.md
git commit -m "docs: document provider switching + free-first transport"
```

---

### Task 10: 최종 검증

**Files:** (없음 — 검증만)

- [ ] **Step 1: 전체 단위 테스트**

Run: `npm test`
Expected: 전체 PASS (스모크 skip)

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음

- [ ] **Step 3: 린트**

Run: `npm run lint`
Expected: 에러 없음

- [ ] **Step 4: 프로덕션 빌드 (파이프라인 무수정 확인)**

Run: `npm run build`
Expected: 빌드 성공 (`app/api/analysis/run`, `step` 라우트 포함)

- [ ] **Step 5: 실네트워크 스모크 (선택, 무료 direct)**

Run: `RUN_SMOKE=1 IG_TRANSPORT=direct npx vitest run lib/services/instagram/providers/selfhosted/web-client.smoke.test.ts`
Expected: PASS 또는 (차단 시) `SCRAPING_ERROR` — 후자면 무료 `scrape-api` 티어 필요를 문서대로 안내.

- [ ] **Step 6: 기본 동작 회귀 확인**

`SCRAPER_*` env를 설정하지 않은 상태에서 `getScraperConfig({})`가 apify/apify/apify/rapidapi/false를 반환하는지 config 테스트로 재확인(이미 Task 2에 포함). 즉 이 변경만으로 프로덕션 동작 불변.

---

## Self-Review 결과

- **Spec coverage**: 4번(아키텍처)=Task 2/8, 5번(파일구조)=전 Task, 6번(1단계 기술)=Task 5/7, 7번(무료 transport)=Task 6/9, 자동폴백=Task 8, 9번(문서화)=Task 9, 10번(테스트)=각 Task+Task 10, 11번(범위밖 2단계 스캐폴드)=Task 7. 누락 없음.
- **Placeholder scan**: 모든 코드 스텝에 실제 코드 포함. `session.ts`/`followers-client.ts`는 의도된 스캐폴드(명시적 throw)로 플레이스홀더 아님.
- **Type consistency**: `ScraperProvider`, `ProviderName`, `Capability`, `TransportConfig`, `getScraperConfig`, `mapUserToProfile`, `fetchWebProfileUser`, `makeSelfHostedProvider`, `__setProvidersForTest`/`__resetProvidersForTest` 명칭이 정의 Task와 소비 Task에서 일치.
```
