/**
 * FlashAPI - Following 엔드포인트 테스트
 * 실행: node scripts/test-flashapi-following.mjs
 *
 * 0_min._.00의 correct pk: 6094781602
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const HOST = 'flashapi1.p.rapidapi.com';
const BASE = `https://${HOST}`;
const HEADERS = { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST };

// 0_min._.00 의 Apify legacy pk (= Account Data V2의 pk 필드)
const USER_PK = '6094781602';

async function get(path, params = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) {
        if (v != null) url.searchParams.set(k, String(v));
    }
    console.log(`  GET  ${url.toString()}`);
    const res = await fetch(url.toString(), { method: 'GET', headers: HEADERS });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, ok: res.ok, data };
}

function printResult(label, result) {
    const icon = result.ok ? '✅' : '❌';
    console.log(`\n${icon} [${label}] HTTP ${result.status}`);

    if (!result.ok) {
        console.log('  응답:', JSON.stringify(result.data).slice(0, 400));
        return;
    }

    const d = result.data;
    // 리스트 추출
    let list = null;
    if (Array.isArray(d)) list = d;
    else {
        for (const key of ['following', 'followers', 'data', 'users', 'items']) {
            if (Array.isArray(d?.[key])) { list = d[key]; break; }
        }
    }

    if (list) {
        console.log(`  목록 개수: ${list.length}개`);
        if (list.length > 0) {
            const sample = list[0];
            console.log('  첫 번째 샘플 키:', Object.keys(sample).slice(0, 20).join(', '));
            console.log(`  username    : ${sample.username ?? sample.user?.username ?? '없음'}`);
            console.log(`  full_name   : ${sample.full_name ?? sample.user?.full_name ?? '없음'}`);
            console.log(`  is_private  : ${sample.is_private ?? sample.user?.is_private ?? '없음'}`);
            // 처음 5개 username 출력
            console.log('  처음 5개:', list.slice(0, 5).map(u => u.username ?? u.user?.username ?? '?').join(', '));
        }
    } else {
        console.log('  응답 키:', Object.keys(d).slice(0, 20).join(', '));
        console.log('  전체 응답(400자):', JSON.stringify(d).slice(0, 400));
    }

    // 페이지네이션
    if (d && typeof d === 'object') {
        const pagKeys = ['next_max_id', 'pagination_token', 'end_cursor', 'next_cursor', 'has_next_page'];
        const found = pagKeys.filter(k => d[k] != null);
        if (found.length > 0) console.log('  페이지네이션:', found.map(k => `${k}=${JSON.stringify(d[k]).slice(0, 40)}`).join(', '));
    }
}

async function main() {
    console.log('=================================================');
    console.log(' FlashAPI Following 엔드포인트 테스트');
    console.log(`  pk: ${USER_PK}  (0_min._.00)`);
    console.log('=================================================');

    // 시도 1: /ig/following/
    console.log('\n━━━ 시도 1: GET /ig/following/ ━━━');
    const r1 = await get('/ig/following/', { id_user: USER_PK });
    printResult('FlashAPI /ig/following/', r1);

    // 시도 2: /ig/followers/ (같은 URL로 following 파라미터가 있는지 확인)
    console.log('\n━━━ 시도 2: GET /ig/followers/ (비교용) ━━━');
    const r2 = await get('/ig/followers/', { id_user: USER_PK });
    printResult('FlashAPI /ig/followers/', r2);

    console.log('\n=================================================');
    console.log(' 완료');
    console.log('=================================================');
}

main().catch(e => { console.error('에러:', e.message); process.exit(1); });
