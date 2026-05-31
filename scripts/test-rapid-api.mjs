/**
 * RapidAPI Instagram Scraper Stable API 테스트 스크립트
 * 실행: node scripts/test-rapid-api.mjs
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 설정 ────────────────────────────────────────────────────────────────────

const TEST_USERNAME = '0_min._.00';
const TEST_POST_SHORTCODE = 'DMRd7-syDJN';

// ─── 환경변수 로드 ─────────────────────────────────────────────────────────────

function loadEnv() {
    const content = readFileSync(resolve(__dirname, '../.env.local'), 'utf-8');
    const env = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed[0] === '#') continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
    return env;
}

const env = loadEnv();
const KEY = env.RAPIDAPI_KEY;
const HOST = env.RAPIDAPI_HOST;
const BASE = `https://${HOST}`;
const BASE_HEADERS = { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST };

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
    }
    console.log(`  GET  ${url.toString()}`);
    const res = await fetch(url.toString(), { method: 'GET', headers: BASE_HEADERS });
    return parseRes(res);
}

async function post(path, bodyParams = {}) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(bodyParams)) {
        if (v != null) body.set(k, String(v));
    }
    console.log(`  POST ${BASE + path}  body: ${body.toString()}`);
    const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { ...BASE_HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
    });
    return parseRes(res);
}

async function parseRes(res) {
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, ok: res.ok, data };
}

function isSuccess(result) {
    if (!result.ok) return false;
    if (result.data?.error) return false;
    if (result.data?.message) return false;
    return true;
}

function getList(data) {
    if (Array.isArray(data)) return data;
    for (const key of ['data', 'users', 'items', 'followers', 'following', 'posts', 'timeline', 'media']) {
        if (Array.isArray(data?.[key])) return data[key];
    }
    // 숫자 키 객체 (Post Likers 형태: {"0":{...}, "1":{...}})
    if (data && typeof data === 'object' && '0' in data) return Object.values(data);
    return null;
}

function printSample(label, result, fieldChecks = []) {
    const icon = isSuccess(result) ? '✅' : '❌';
    console.log(`\n${icon} [${label}] HTTP ${result.status}`);

    if (!isSuccess(result)) {
        console.log('  응답:', JSON.stringify(result.data).slice(0, 400));
        return null;
    }

    const list = getList(result.data);
    const sample = list ? list[0] : result.data;

    if (list) console.log(`  목록 개수: ${list.length}개`);
    if (sample && typeof sample === 'object') {
        console.log('  샘플 키:', Object.keys(sample).slice(0, 25).join(', '));
    }

    if (fieldChecks.length > 0 && sample && typeof sample === 'object') {
        console.log('  필드 체크:');
        for (const field of fieldChecks) {
            const val = field.split('.').reduce((o, k) => o?.[k], sample);
            const mark = val != null ? '✔' : '✘ 없음';
            const preview = val != null ? ` = ${JSON.stringify(val).slice(0, 80)}` : '';
            console.log(`    ${mark}  ${field}${preview}`);
        }
    }

    // 페이지네이션 정보
    if (result.data && typeof result.data === 'object') {
        const paginationKeys = ['pagination_token', 'next_max_id', 'end_cursor', 'next_cursor', 'has_next_page'];
        const found = paginationKeys.filter(k => result.data[k] != null);
        if (found.length > 0) {
            console.log('  페이지네이션:', found.map(k => `${k}=${JSON.stringify(result.data[k]).slice(0, 40)}`).join(', '));
        }
    }

    return sample;
}

// ─── 테스트 ────────────────────────────────────────────────────────────────────

// 1. Account Data V2
async function test1_AccountData() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('1. Account Data V2  POST /ig_get_fb_profile_v3.php');
    const result = await post('/ig_get_fb_profile_v3.php', {
        username_or_url: TEST_USERNAME,
    });
    printSample('Account Data V2', result, [
        'username', 'full_name', 'biography', 'profile_pic_url',
        'follower_count', 'following_count', 'media_count',
        'is_private', 'is_verified', 'external_url',
    ]);
}

// 2. User Posts  (Basic User + Posts 대체)
async function test2_UserPosts() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('2. User Posts  POST /get_ig_user_posts.php');
    const result = await post('/get_ig_user_posts.php', {
        username_or_url: TEST_USERNAME,
    });
    printSample('User Posts', result, []);

    if (isSuccess(result)) {
        const list = getList(result.data);
        const firstItem = list?.[0];
        // User Posts는 [{node: {...}}, ...] 형태
        const first = firstItem?.node ?? firstItem;
        if (first && typeof first === 'object') {
            console.log('\n  [첫 번째 게시물 node 키]:', Object.keys(first).join(', '));
            console.log('\n  [첫 번째 게시물 상세 필드]');
            const imgUrl = first.display_url || first.thumbnail_src || first.image_url;
            console.log(`  이미지 URL : ${imgUrl?.slice(0, 80) ?? '없음'}`);
            console.log(`  shortcode  : ${first.shortcode ?? first.code ?? '없음'}`);
            const caption = first.caption
                ?? first.edge_media_to_caption?.edges?.[0]?.node?.text
                ?? '없음';
            console.log(`  caption    : ${String(caption).slice(0, 80)}`);
            const likes = first.like_count ?? first.edge_media_preview_like?.count ?? '없음';
            const comments = first.comment_count ?? first.edge_media_to_parent_comment?.count ?? '없음';
            console.log(`  like_count : ${likes}`);
            console.log(`  comment_cnt: ${comments}`);
            console.log(`  timestamp  : ${first.timestamp ?? first.taken_at_timestamp ?? '없음'}`);
            const tagged = first.tagged_users
                ?? first.usertags?.in?.map(u => u.user?.username)
                ?? first.edge_media_to_tagged_user?.edges?.map(e => e.node?.user?.username)
                ?? [];
            console.log(`  tagged     : ${JSON.stringify(tagged).slice(0, 80)}`);
            const carousel = first.edge_sidecar_to_children?.edges ?? first.carousel_media ?? [];
            if (carousel.length > 0) console.log(`  carousel   : ${carousel.length}개 이미지`);
        }
    }
}

// 3. Followers List v2
async function test3_Followers() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('3. Followers List v2  POST /get_ig_user_followers_v2.php  data=followers');
    const result = await post('/get_ig_user_followers_v2.php', {
        username_or_url: TEST_USERNAME,
        data: 'followers',
        amount: '10',
    });
    printSample('Followers List v2', result, [
        'username', 'full_name', 'profile_pic_url', 'is_private', 'is_verified',
    ]);
}

// 4. Following List v2
async function test4_Following() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('4. Following List v2  POST /get_ig_user_followers_v2.php  data=following');
    const result = await post('/get_ig_user_followers_v2.php', {
        username_or_url: TEST_USERNAME,
        data: 'following',
        amount: '10',
    });
    printSample('Following List v2', result, [
        'username', 'full_name', 'profile_pic_url', 'is_private', 'is_verified',
    ]);
}

// 5. Detailed Media Data v2
async function test5_MediaDetails() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('5. Detailed Media Data v2  GET /get_media_data_v2.php');
    const result = await get('/get_media_data_v2.php', { media_code: TEST_POST_SHORTCODE });

    if (isSuccess(result)) {
        const d = result.data;
        console.log('\n✅ [Detailed Media Data v2] HTTP 200');
        console.log('  [실제 필드 매핑]');
        console.log(`  id             : ${d.id}`);
        console.log(`  shortcode      : ${d.shortcode}`);
        console.log(`  display_url    : ${d.display_url?.slice(0, 70)}`);
        console.log(`  caption        : ${JSON.stringify(d.edge_media_to_caption?.edges?.[0]?.node?.text ?? null).slice(0, 80)}`);
        console.log(`  like_count     : ${d.edge_media_preview_like?.count ?? null}`);
        console.log(`  comment_count  : ${d.edge_media_to_parent_comment?.count ?? null}`);
        console.log(`  taken_at       : ${d.taken_at_timestamp ?? null}`);
        const tagged = d.edge_media_to_tagged_user?.edges?.map(e => e.node?.user?.username) ?? [];
        console.log(`  tagged_users   : ${JSON.stringify(tagged)}`);
        const children = d.edge_sidecar_to_children?.edges ?? [];
        if (children.length) console.log(`  carousel       : ${children.length}개 이미지`);
        console.log(`  is_video       : ${d.is_video}`);
    } else {
        console.log(`❌ HTTP ${result.status}:`, JSON.stringify(result.data).slice(0, 200));
    }
}

// 6. Post Likers V2
async function test6_PostLikers() {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('6. Get Post Likers V2  GET /get_post_likers.php');
    const result = await get('/get_post_likers.php', { post_code: TEST_POST_SHORTCODE });
    printSample('Post Likers V2', result, [
        'username', 'full_name', 'profile_pic_url', 'is_verified',
    ]);
}

// ─── 메인 ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=================================================');
    console.log(' RapidAPI Instagram Scraper Stable API 테스트');
    console.log(`  계정: @${TEST_USERNAME}  |  게시물: ${TEST_POST_SHORTCODE}`);
    console.log('=================================================');

    await test1_AccountData();
    await test2_UserPosts();
    await test3_Followers();
    await test4_Following();
    await test5_MediaDetails();
    await test6_PostLikers();

    console.log('\n=================================================');
    console.log(' 완료');
    console.log('=================================================');
}

main().catch(e => { console.error('에러:', e.message); process.exit(1); });
