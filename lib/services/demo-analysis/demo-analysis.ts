import 'server-only';

import { access } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type {
    AnalysisResultSummaryV1,
    FemaleResultRowV1,
    PrivateResultRowV1,
    ProgressEventV1,
    ProgressSnapshotV1,
} from '@/lib/contracts/analysis-v2';
import { paginateAnalysisResults } from '@/lib/domain/analysis/result-pagination';
import { ANALYSIS_PLAN_CATALOG, PLAN_PRICING_VERSION, buildPlanSelectionCards } from '@/lib/domain/analysis/plan-catalog';
import { DEMO_V3_SOURCE_FIXTURE } from './demo-v3-source-fixture';
import { DEMO_V4_SOURCE_FIXTURE } from './demo-v4-source-fixture';

/** The only canonical demo target. Do not duplicate this value in route or SQL code. */
export const DEMO_TARGET_USERNAME = 'junho_dem' as const;
/** Legacy run rows must retain their original deterministic presentation. */
export const LEGACY_DEMO_FIXTURE_VERSION = 'synthetic-fixture-v1' as const;
/** Existing v2 rows remain replayable after v3 becomes the default. */
export const AUTHORIZED_TEXT_DEMO_FIXTURE_VERSION = 'authorized-text-fixture-v2' as const;
/** Persisted v3 rows remain replayable after the bijective v4 fixture becomes current. */
export const REDACTED_DEMO_FIXTURE_VERSION = 'authorized-redacted-fixture-v3' as const;
/** New runs use the bijective redacted fixture and locally baked source-derived avatar assets. */
export const DEMO_FIXTURE_VERSION = 'authorized-redacted-fixture-v4' as const;
export type DemoFixtureVersion =
    | typeof LEGACY_DEMO_FIXTURE_VERSION
    | typeof AUTHORIZED_TEXT_DEMO_FIXTURE_VERSION
    | typeof REDACTED_DEMO_FIXTURE_VERSION
    | typeof DEMO_FIXTURE_VERSION;
export const DEMO_ASSET_PREFIX = '/demo-avatars/synthetic-blurred-avatar-' as const;
export const DEMO_V3_ASSET_PREFIX = '/demo-avatars/demo-v3-' as const;
export const DEMO_PREFLIGHT_TTL_MS = 30 * 60_000;

export function demoResponseCapabilities() {
    return {
        'X-Analytics-Eligible': '0',
        'X-External-Profile-Links': 'disabled',
        'X-Result-Actions': 'disabled',
    } as const;
}

/**
 * Public contract for every response after a request has been recognized as a
 * demo fixture request. Keep this free of internal run state: clients only
 * need to know that analytics and actionable result affordances are disabled.
 */
export function demoResponseHeaders() {
    return {
        ...demoResponseCapabilities(),
        'Cache-Control': 'private, no-store, max-age=0',
        Vary: 'Cookie',
    } as const;
}

/** Deployment/test guard: demo profiles may only reference these local rasters. */
export async function validateDemoAssetManifest(): Promise<string[]> {
    const assets = [
        ...[1, 2, 3, 4].map(index => `${DEMO_ASSET_PREFIX}${index}-v1.png`),
        `${DEMO_V3_ASSET_PREFIX}target-000.webp`,
        ...Array.from({ length: 84 }, (_, index) => `${DEMO_V3_ASSET_PREFIX}female-${String(index + 1).padStart(3, '0')}.webp`),
        ...Array.from({ length: 145 }, (_, index) => `${DEMO_V3_ASSET_PREFIX}private-${String(index + 85).padStart(3, '0')}.webp`),
    ];
    await Promise.all(assets.map(async asset => {
        const diskPath = path.join(process.cwd(), 'public', asset);
        await access(diskPath);
        const metadata = await sharp(diskPath).metadata();
        if (!['png', 'webp'].includes(metadata.format ?? '') || !metadata.width || !metadata.height) {
            throw new Error(`Invalid demo fixture image: ${asset}`);
        }
        const { data, info } = await sharp(diskPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let edgeTotal = 0;
        let edgeCount = 0;
        for (let y = 1; y < info.height; y += 8) for (let x = 1; x < info.width; x += 8) {
            const offset = (y * info.width + x) * info.channels;
            const left = (y * info.width + x - 1) * info.channels;
            const up = ((y - 1) * info.width + x) * info.channels;
            edgeTotal += Math.abs(data[offset]! - data[left]!) + Math.abs(data[offset]! - data[up]!);
            edgeCount += 2;
        }
        if (edgeTotal / Math.max(1, edgeCount) > 35) throw new Error(`Synthetic demo image is not sufficiently defocused: ${asset}`);
    }));
    return assets;
}

type DemoEnvironment = Readonly<{
    DEMO_ANALYSIS_ENABLED?: string;
    DEMO_ANALYSIS_OPERATOR_USER_IDS?: string;
    DEMO_ANALYSIS_DURATION_SECONDS?: string;
}>;

export function demoDurationSeconds(env: DemoEnvironment = process.env as DemoEnvironment): number {
    const value = Number.parseInt(env.DEMO_ANALYSIS_DURATION_SECONDS ?? '', 10);
    if (!Number.isFinite(value)) return 38;
    return Math.max(30, Math.min(45, value));
}

export function demoPreflightLifecycle(
    run: { created_at: string; started_at: string | null },
    now: Date = new Date(),
): 'ready' | 'expired' | 'consumed' {
    if (run.started_at) return 'consumed';
    return new Date(run.created_at).getTime() + DEMO_PREFLIGHT_TTL_MS <= now.getTime()
        ? 'expired'
        : 'ready';
}

export function isDemoEligible(
    userId: string,
    rawTargetInstagramId: unknown,
    env: DemoEnvironment = process.env as DemoEnvironment,
): boolean {
    if (rawTargetInstagramId !== DEMO_TARGET_USERNAME) return false;
    return isDemoOperator(userId, env);
}

export function isDemoOperator(userId: string, env: DemoEnvironment = process.env as DemoEnvironment): boolean {
    if (env.DEMO_ANALYSIS_ENABLED !== 'true') return false;
    const operators = (env.DEMO_ANALYSIS_OPERATOR_USER_IDS ?? '')
        .split(',')
        .filter(value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
    return operators.includes(userId);
}

function avatar(index: number): string {
    return `${DEMO_ASSET_PREFIX}${(index % 4) + 1}-v1.png`;
}

function v3Avatar(kind: 'target' | 'female' | 'private', sortOrdinal: number): string {
    return `${DEMO_V3_ASSET_PREFIX}${kind}-${String(sortOrdinal).padStart(3, '0')}.webp`;
}

function isRedactedFixture(fixtureVersion: string | undefined): boolean {
    const version = fixtureVersion ?? DEMO_FIXTURE_VERSION;
    return version === REDACTED_DEMO_FIXTURE_VERSION || version === DEMO_FIXTURE_VERSION;
}

function isV3Fixture(fixtureVersion: string): boolean {
    return fixtureVersion === REDACTED_DEMO_FIXTURE_VERSION;
}

export type DemoSourceProfileFixture = Readonly<{
    instagramId: string;
    fullName: string | null;
    bio: string | null;
}>;

/**
 * Authorized source text is copied here once for this isolated v2 fixture.
 * Runtime code must never read an analysis table or external profile source.
 */
export const DEMO_SOURCE_PROFILE_FIXTURE: readonly DemoSourceProfileFixture[] = [
    {
        "instagramId": "lotusonthepond",
        "fullName": "윤하",
        "bio": null
    },
    {
        "instagramId": "clover_hee__",
        "fullName": "윤희원",
        "bio": null
    },
    {
        "instagramId": "graceintheseo",
        "fullName": "恩",
        "bio": "SAY MA GRACE"
    },
    {
        "instagramId": "yun_ten_quadrillion",
        "fullName": "윤경",
        "bio": "univ . music ."
    },
    {
        "instagramId": "uiwahyou",
        "fullName": "혜민 Hailey",
        "bio": null
    },
    {
        "instagramId": "jinjintonique",
        "fullName": "임효진",
        "bio": null
    },
    {
        "instagramId": "o_aaaaasis",
        "fullName": "정서진 Seojin J",
        "bio": "Hi ⠀ What’s in my 🔍 Contact DM"
    },
    {
        "instagramId": "hxxuiou",
        "fullName": "한결",
        "bio": null
    },
    {
        "instagramId": "lululajin",
        "fullName": "최유진",
        "bio": null
    },
    {
        "instagramId": "vel.ote",
        "fullName": "윤예진 イェジン",
        "bio": "35J"
    },
    {
        "instagramId": "growth_yule",
        "fullName": "율공이이",
        "bio": "🎓 서울대 자연대 이과생 🧠 연구실 & 대학 현실 기록 🔥 회사와 창업을 거쳐 연구로 ➡️ 매일 릴스 올려요"
    },
    {
        "instagramId": "nveouir",
        "fullName": "명은",
        "bio": "Myungeun"
    },
    {
        "instagramId": "yoonsuumi",
        "fullName": "윤수미",
        "bio": null
    },
    {
        "instagramId": "choahly",
        "fullName": "Choah",
        "bio": "singer-songwriter🇰🇷 choahlee1014 [Blonde] Full Album Cover out now on YouTube🍋"
    },
    {
        "instagramId": "0rion_25",
        "fullName": null,
        "bio": "오윤아"
    },
    {
        "instagramId": "oojookim",
        "fullName": "MinJoo Kim",
        "bio": null
    },
    {
        "instagramId": "5una.9",
        "fullName": "윤선아",
        "bio": null
    },
    {
        "instagramId": "iam_usb_",
        "fullName": "유수빈",
        "bio": null
    },
    {
        "instagramId": "chaechae.jpg",
        "fullName": "Chae",
        "bio": "ʕ•ع•ʔ"
    },
    {
        "instagramId": "babebettyyy",
        "fullName": "베티",
        "bio": "I'm Betty :)"
    },
    {
        "instagramId": "marcymarcelinee",
        "fullName": "안시나",
        "bio": null
    },
    {
        "instagramId": "ysleei1021",
        "fullName": "이예슬",
        "bio": null
    },
    {
        "instagramId": "hayoung.emily",
        "fullName": null,
        "bio": null
    },
    {
        "instagramId": "dx.kxm",
        "fullName": "김도현",
        "bio": null
    },
    {
        "instagramId": "ch__n1",
        "fullName": "정창은",
        "bio": null
    },
    {
        "instagramId": "what_a_jia",
        "fullName": "김지아",
        "bio": null
    },
    {
        "instagramId": "ny.hssh",
        "fullName": null,
        "bio": null
    },
    {
        "instagramId": "huse_birdcage",
        "fullName": "휴세 (Huse)",
        "bio": "수장"
    },
    {
        "instagramId": "jmni_x",
        "fullName": "김지민",
        "bio": "🎵"
    },
    {
        "instagramId": "ryu.seonhee",
        "fullName": "유선희",
        "bio": "✝️ Romans 8:18 CCC 성남지구 순장 대학생 2002.12.11 e-mail: seonhee021211"
    },
    {
        "instagramId": "_i_.s0",
        "fullName": null,
        "bio": null
    },
    {
        "instagramId": "heimish_msc",
        "fullName": "서연우",
        "bio": "🎹 Piano account SPO 서포터즈 12기"
    },
    {
        "instagramId": "__van.ne",
        "fullName": "최가은",
        "bio": null
    },
    {
        "instagramId": "ixxahn",
        "fullName": "이다현",
        "bio": null
    },
    {
        "instagramId": "yemlxm",
        "fullName": "예림",
        "bio": null
    },
    {
        "instagramId": "mymyyyk",
        "fullName": "MyungJi Seo",
        "bio": null
    },
    {
        "instagramId": "makechanges0040",
        "fullName": "시니 | 04년생 스타트업 대표",
        "bio": "평범한 대학생이 창업 성공 할 수 있을까❓ CEO 💪팔로우하고 같이 성장해요!🪽 - 📩seo1a62"
    },
    {
        "instagramId": "hyunsssplend",
        "fullName": "Hyunseo Kang",
        "bio": "잔잔한 기쁨과 넉넉한 마음"
    },
    {
        "instagramId": "mountainheee",
        "fullName": "▫️◤hee",
        "bio": "firmitas, utilitas, venustas."
    },
    {
        "instagramId": "two__silver_a",
        "fullName": "이은아",
        "bio": null
    },
    {
        "instagramId": "z.fuul",
        "fullName": "지풀",
        "bio": "공연 섭외 및 각종 협업 DM🌱"
    },
    {
        "instagramId": "seoul_sfiz",
        "fullName": "정이 jeongi",
        "bio": "유월 삼십일은 해의 절반 📮jeongiseoul"
    },
    {
        "instagramId": "suhyen_o727",
        "fullName": "수현",
        "bio": null
    },
    {
        "instagramId": "mwrluna",
        "fullName": "민소",
        "bio": null
    },
    {
        "instagramId": "kx_.hui",
        "fullName": "희 †",
        "bio": "ᴊᴜꜱᴛ ᴀꜱ ᴛʜᴇ ꜰᴀᴛʜᴇʀ ʟᴏᴠᴇꜱ ᴍᴇ, ꜱᴏ ɪ ʟᴏᴠᴇ ʏᴏᴜ. ꜱᴛᴀʏ ɪɴ ᴍʏ ʟᴏᴠᴇ -`♥ ́-"
    },
    {
        "instagramId": "ryusxmin",
        "fullName": "유세민",
        "bio": null
    },
    {
        "instagramId": "yoonyooniii",
        "fullName": "윤윤 yoonyoon",
        "bio": "7월 30일 우주정거장 로켓라이브 7월 31일 우무지 경이로운 금요일"
    },
    {
        "instagramId": "s2_heebin",
        "fullName": "이희빈",
        "bio": "본캐🍀🍀 부캐 -"
    },
    {
        "instagramId": "wnwndusdus",
        "fullName": "주연",
        "bio": "Piano Instructor Composer & Producer"
    },
    {
        "instagramId": "thisistaam",
        "fullName": "탬",
        "bio": "🧡 🍒 🐣"
    },
    {
        "instagramId": "_juzila",
        "fullName": null,
        "bio": null
    },
    {
        "instagramId": "seoheeeeeeee",
        "fullName": "박서희",
        "bio": "📧 seohee.mp3"
    },
    {
        "instagramId": "ecitsuj_s",
        "fullName": "의정",
        "bio": null
    },
    {
        "instagramId": "_ashl2y_",
        "fullName": "Ashley",
        "bio": "🎶🎸🎤"
    },
    {
        "instagramId": "se.__.eun",
        "fullName": "김세은",
        "bio": "Leben und Leben lassen 🐬📷 🎧🍅 🥪☕️"
    },
    {
        "instagramId": "fmpark0213",
        "fullName": "박승민",
        "bio": null
    },
    {
        "instagramId": "glwormun",
        "fullName": null,
        "bio": null
    },
    {
        "instagramId": "pxssword486",
        "fullName": "최찬미",
        "bio": null
    },
    {
        "instagramId": "this.is.where.i.thrash",
        "fullName": "조수현 Skylar",
        "bio": null
    },
    {
        "instagramId": "yuzexxiv",
        "fullName": "유혜진혜유",
        "bio": null
    },
    {
        "instagramId": "a_trac._9",
        "fullName": "권하은",
        "bio": null
    },
    {
        "instagramId": "hayoon.pp",
        "fullName": "헤어메이크업 하윤",
        "bio": "̊✧+⁎❝᷀ົཽ≀ˍ̮ ❝᷀ົཽ⁎+˳✧༚MAKE UP/HAIR ̊✧+⁎❝᷀ົཽ≀ˍ̮ ❝᷀ົཽ⁎+˳✧༚ Pslam23"
    },
    {
        "instagramId": "sejinmanmanse",
        "fullName": "세진만만세",
        "bio": null
    },
    {
        "instagramId": "letsmusiq",
        "fullName": "I LOVE R&B",
        "bio": null
    },
    {
        "instagramId": "its.yxxng",
        "fullName": "이채영",
        "bio": "🎗"
    },
    {
        "instagramId": "smouse0213",
        "fullName": "eunji",
        "bio": null
    },
    {
        "instagramId": "jinse_bb",
        "fullName": "이세진",
        "bio": "Lee sejin"
    },
    {
        "instagramId": "kwdozer",
        "fullName": "Hyeokyeon 혁연",
        "bio": "Yeon"
    },
    {
        "instagramId": "jukeecandle",
        "fullName": null,
        "bio": null
    },
    {
        "instagramId": "naengs_ppl",
        "fullName": "냉이의 인물",
        "bio": "냉이의 인생무물 <냉이의 인물>은 다채로운 인물들의 일상을 소개하는 카드뉴스 인터뷰입니다. 여러분의 물음표는 무엇인가요? 독자들에게 여러분의 일상을 나누어주세요. _contact : DM"
    },
    {
        "instagramId": "seo_yeon.zip",
        "fullName": "Seoyeon Hong",
        "bio": "홍서연의 과일가게 📑 #대외활동 #공모전 본 계정 🏫 GCU Industrial Engineering 📍 SNU 과학영재교육원 생물 사사 📍 PCEO 9 📍 TEU MED 5 📍 GCS 7"
    },
    {
        "instagramId": "_butterflies_fly_",
        "fullName": "나영 Nayoung / Sally",
        "bio": null
    },
    {
        "instagramId": "euyuina",
        "fullName": "김의나",
        "bio": null
    },
    {
        "instagramId": "ppo_sseun_._._",
        "fullName": "이서은",
        "bio": "24 셀프네일"
    },
    {
        "instagramId": "eu__njjii",
        "fullName": "신은지 Eunji Shin",
        "bio": null
    },
    {
        "instagramId": "uz._yo2n",
        "fullName": "우지윤 jiyoon",
        "bio": null
    },
    {
        "instagramId": "redwestyear",
        "fullName": "홍서연",
        "bio": null
    },
    {
        "instagramId": "hayoung.st",
        "fullName": "하영 HAYOUNG",
        "bio": "hayoung.st(ory) hayoungchokr"
    },
    {
        "instagramId": "nusimik_",
        "fullName": "민선",
        "bio": null
    },
    {
        "instagramId": "muzartlsyn",
        "fullName": "소영",
        "bio": null
    },
    {
        "instagramId": "gaeun____._",
        "fullName": "이가은",
        "bio": null
    },
    {
        "instagramId": "realizewhatuwant",
        "fullName": "유진",
        "bio": "마음이 가는 곳으로 . 작업물 기록"
    },
    {
        "instagramId": "sselrevil",
        "fullName": "노가은",
        "bio": "🥐 🎵"
    },
    {
        "instagramId": "hyson_18",
        "fullName": "Yeson Hong",
        "bio": null
    },
    {
        "instagramId": "s._.dam2",
        "fullName": "박새담",
        "bio": "장면 같은 하루들🌫 📩 collab DM"
    },
    {
        "instagramId": "humming_moon70",
        "fullName": "歌う月",
        "bio": "2000年生まれ|シンガーソングライター 「人生はきっと涙忘れ歩く日の連続」 ▶︎ ▶︎ チケット予約はプロフURLから ☽ 📍7/24 南堀江knave"
    }
];

export const DEMO_SOURCE_HANDLE_FIXTURE = DEMO_SOURCE_PROFILE_FIXTURE.map(row => row.instagramId);

/**
 * Deliberately fictional fallback copy for legacy v1 rows and the v2 rows
 * beyond the approved source profile subset. V2's approved source handles and
 * text are defined above; no version contains source images, URLs, or runtime
 * reads from a production data source.
 */
const DEMO_PUBLIC_HANDLES = [
    'dawn.notebook', 'mood.weekend', 'olive.window', 'slow.morning',
    'paper.and.light', 'tiny.blue.room', 'walk.after.rain', 'blooming.shelf',
    'film.in.april', 'softly.recorded', 'bookish.afternoon', 'cloudy.kitchen',
    'dayoff.palette', 'smalltown.frame', 'sunny.corner', 'weekend.postcard',
    'quietly.made', 'garden.on.table', 'little.moonlog', 'warmth.archive',
    'everyday.glass', 'notes.by.river', 'tangerine.desk', 'mellow.weekdays',
] as const;

const DEMO_PUBLIC_NAMES = [
    '윤하린', '서유진', '김도아', '박나율', '한소민', '이채온',
    '정유라', '최다은', '문서연', '강하진', '오지안', '류세빈',
    '배수아', '신예린', '임다현', '권유나', '남지수', '송하은',
    '장민서', '노아린', '황지우', '백소율', '유채린', '조은별',
] as const;

const DEMO_PUBLIC_BIOS = [
    '아침 산책과 작은 기록을 좋아해요.',
    '주말마다 새로운 전시를 찾아갑니다.',
    '커피, 책, 그리고 느린 오후.',
    '집밥과 계절 꽃을 담아두는 중이에요.',
    '필름 카메라로 일상을 남깁니다.',
    '퇴근 뒤 가볍게 달리고 있어요.',
    '좋아하는 음악을 차곡차곡 모읍니다.',
    '낯선 동네의 빵집을 기록해요.',
    '반려식물과 함께 사는 집의 이야기.',
    '여행 전에는 꼭 지도를 오래 봐요.',
    '손으로 만드는 취미를 좋아합니다.',
    '비 오는 날의 창가를 특히 좋아해요.',
    '친구들과 나눈 식사를 기억합니다.',
    '작은 운동 루틴을 이어가는 중이에요.',
    '읽고 본 것들을 천천히 정리합니다.',
    '도시의 저녁 풍경을 자주 찍어요.',
    '매일 한 장의 사진을 남기고 있어요.',
    '주말의 여유를 배우는 중입니다.',
] as const;

const DEMO_PUBLIC_OVERVIEWS = [
    '공개 프로필의 최근 기록에서 가벼운 참고 신호가 보입니다.',
    '일상 게시물의 흐름을 함께 살펴볼 수 있는 프로필입니다.',
    '공개 범위의 표현은 맥락을 확인하며 참고할 만합니다.',
    '최근 기록은 평이하며 별도의 주의 신호는 크지 않습니다.',
    '공개된 취미 기록이 비교적 일관되게 이어집니다.',
    '게시물의 분위기는 차분하며 판단을 서두를 근거는 없습니다.',
    '공개 프로필의 활동 흐름을 참고 수준으로 확인할 수 있습니다.',
    '일상 사진과 짧은 기록이 자연스럽게 이어지는 계정입니다.',
    '표현의 변화는 있으나 공개 정보만으로 의미를 단정하기 어렵습니다.',
    '공개 범위에서 확인된 내용은 추가 맥락과 함께 보는 편이 좋습니다.',
    '최근 게시물은 일반적인 일상 공유 흐름에 가깝습니다.',
    '프로필 소개와 게시물의 주제가 무난하게 이어집니다.',
    '공개 기록에는 제한적인 참고 요소만 확인됩니다.',
    '짧은 일상 업데이트가 중심인 공개 프로필입니다.',
    '게시물의 흐름은 안정적이며 특별한 경고 신호는 보이지 않습니다.',
    '공개된 정보는 참고용으로만 조심스럽게 해석할 수 있습니다.',
    '최근 활동은 취미와 일상 기록 위주로 구성되어 있습니다.',
    '표현의 결은 다양하지만 단정적인 해석은 피하는 편이 좋습니다.',
] as const;

/**
 * Static selectors for the deterministic fixture. V2 uses authorized static
 * source handles/text for its first public rows; all remaining selectors are
 * fictional fixture copy. Neither version contains source images, URLs, or
 * runtime reads from a production data source.
 */
export type DemoFixtureVariant = Readonly<{
    handleIndex: number;
    nameIndex: number;
    bioIndex: number;
    overviewIndex: number;
}>;

export const DEMO_FIXTURE_VARIANTS: readonly DemoFixtureVariant[] = [
    { handleIndex: 4, nameIndex: 18, bioIndex: 0, overviewIndex: 6 }, { handleIndex: 13, nameIndex: 21, bioIndex: 7, overviewIndex: 4 }, { handleIndex: 20, nameIndex: 11, bioIndex: 2, overviewIndex: 12 }, { handleIndex: 8, nameIndex: 0, bioIndex: 10, overviewIndex: 12 },
    { handleIndex: 9, nameIndex: 20, bioIndex: 1, overviewIndex: 0 }, { handleIndex: 6, nameIndex: 13, bioIndex: 6, overviewIndex: 0 }, { handleIndex: 8, nameIndex: 23, bioIndex: 16, overviewIndex: 7 }, { handleIndex: 3, nameIndex: 5, bioIndex: 4, overviewIndex: 3 },
    { handleIndex: 18, nameIndex: 23, bioIndex: 10, overviewIndex: 17 }, { handleIndex: 13, nameIndex: 23, bioIndex: 9, overviewIndex: 10 }, { handleIndex: 5, nameIndex: 0, bioIndex: 15, overviewIndex: 5 }, { handleIndex: 6, nameIndex: 21, bioIndex: 16, overviewIndex: 12 },
    { handleIndex: 2, nameIndex: 3, bioIndex: 0, overviewIndex: 4 }, { handleIndex: 10, nameIndex: 18, bioIndex: 15, overviewIndex: 7 }, { handleIndex: 4, nameIndex: 22, bioIndex: 13, overviewIndex: 6 }, { handleIndex: 23, nameIndex: 23, bioIndex: 16, overviewIndex: 2 },
    { handleIndex: 20, nameIndex: 4, bioIndex: 7, overviewIndex: 8 }, { handleIndex: 6, nameIndex: 12, bioIndex: 2, overviewIndex: 13 }, { handleIndex: 2, nameIndex: 20, bioIndex: 10, overviewIndex: 14 }, { handleIndex: 22, nameIndex: 5, bioIndex: 3, overviewIndex: 12 },
    { handleIndex: 18, nameIndex: 8, bioIndex: 2, overviewIndex: 10 }, { handleIndex: 13, nameIndex: 21, bioIndex: 3, overviewIndex: 3 }, { handleIndex: 5, nameIndex: 11, bioIndex: 0, overviewIndex: 10 }, { handleIndex: 5, nameIndex: 2, bioIndex: 9, overviewIndex: 14 },
    { handleIndex: 23, nameIndex: 1, bioIndex: 16, overviewIndex: 0 }, { handleIndex: 14, nameIndex: 5, bioIndex: 2, overviewIndex: 5 }, { handleIndex: 5, nameIndex: 17, bioIndex: 0, overviewIndex: 2 }, { handleIndex: 2, nameIndex: 9, bioIndex: 12, overviewIndex: 7 },
    { handleIndex: 18, nameIndex: 16, bioIndex: 8, overviewIndex: 16 }, { handleIndex: 7, nameIndex: 6, bioIndex: 17, overviewIndex: 12 }, { handleIndex: 18, nameIndex: 14, bioIndex: 4, overviewIndex: 0 }, { handleIndex: 17, nameIndex: 19, bioIndex: 5, overviewIndex: 6 },
    { handleIndex: 13, nameIndex: 3, bioIndex: 1, overviewIndex: 5 }, { handleIndex: 8, nameIndex: 4, bioIndex: 13, overviewIndex: 2 }, { handleIndex: 12, nameIndex: 3, bioIndex: 3, overviewIndex: 6 }, { handleIndex: 22, nameIndex: 9, bioIndex: 8, overviewIndex: 1 },
    { handleIndex: 14, nameIndex: 0, bioIndex: 4, overviewIndex: 16 }, { handleIndex: 12, nameIndex: 8, bioIndex: 5, overviewIndex: 13 }, { handleIndex: 9, nameIndex: 4, bioIndex: 1, overviewIndex: 4 }, { handleIndex: 17, nameIndex: 23, bioIndex: 12, overviewIndex: 8 },
    { handleIndex: 0, nameIndex: 0, bioIndex: 2, overviewIndex: 4 }, { handleIndex: 22, nameIndex: 8, bioIndex: 1, overviewIndex: 6 }, { handleIndex: 12, nameIndex: 1, bioIndex: 5, overviewIndex: 5 }, { handleIndex: 7, nameIndex: 5, bioIndex: 1, overviewIndex: 0 },
    { handleIndex: 14, nameIndex: 22, bioIndex: 4, overviewIndex: 2 }, { handleIndex: 1, nameIndex: 21, bioIndex: 10, overviewIndex: 0 }, { handleIndex: 14, nameIndex: 7, bioIndex: 13, overviewIndex: 13 }, { handleIndex: 11, nameIndex: 4, bioIndex: 9, overviewIndex: 13 },
    { handleIndex: 12, nameIndex: 4, bioIndex: 0, overviewIndex: 7 }, { handleIndex: 5, nameIndex: 5, bioIndex: 6, overviewIndex: 6 }, { handleIndex: 17, nameIndex: 18, bioIndex: 7, overviewIndex: 8 }, { handleIndex: 6, nameIndex: 20, bioIndex: 13, overviewIndex: 10 },
    { handleIndex: 4, nameIndex: 21, bioIndex: 3, overviewIndex: 11 }, { handleIndex: 13, nameIndex: 15, bioIndex: 2, overviewIndex: 5 }, { handleIndex: 16, nameIndex: 0, bioIndex: 2, overviewIndex: 17 }, { handleIndex: 5, nameIndex: 6, bioIndex: 5, overviewIndex: 4 },
    { handleIndex: 20, nameIndex: 7, bioIndex: 12, overviewIndex: 11 }, { handleIndex: 8, nameIndex: 6, bioIndex: 7, overviewIndex: 0 }, { handleIndex: 6, nameIndex: 19, bioIndex: 17, overviewIndex: 7 }, { handleIndex: 17, nameIndex: 8, bioIndex: 12, overviewIndex: 15 },
    { handleIndex: 7, nameIndex: 20, bioIndex: 5, overviewIndex: 17 }, { handleIndex: 3, nameIndex: 4, bioIndex: 8, overviewIndex: 10 }, { handleIndex: 6, nameIndex: 8, bioIndex: 16, overviewIndex: 13 }, { handleIndex: 0, nameIndex: 8, bioIndex: 16, overviewIndex: 9 },
    { handleIndex: 14, nameIndex: 11, bioIndex: 3, overviewIndex: 6 }, { handleIndex: 0, nameIndex: 20, bioIndex: 4, overviewIndex: 17 }, { handleIndex: 1, nameIndex: 2, bioIndex: 11, overviewIndex: 7 }, { handleIndex: 1, nameIndex: 12, bioIndex: 2, overviewIndex: 14 },
    { handleIndex: 16, nameIndex: 1, bioIndex: 2, overviewIndex: 11 }, { handleIndex: 1, nameIndex: 13, bioIndex: 16, overviewIndex: 1 }, { handleIndex: 2, nameIndex: 17, bioIndex: 12, overviewIndex: 13 }, { handleIndex: 23, nameIndex: 3, bioIndex: 15, overviewIndex: 6 },
    { handleIndex: 10, nameIndex: 21, bioIndex: 1, overviewIndex: 13 }, { handleIndex: 8, nameIndex: 23, bioIndex: 16, overviewIndex: 4 }, { handleIndex: 12, nameIndex: 2, bioIndex: 9, overviewIndex: 10 }, { handleIndex: 16, nameIndex: 2, bioIndex: 9, overviewIndex: 2 },
    { handleIndex: 13, nameIndex: 11, bioIndex: 2, overviewIndex: 2 }, { handleIndex: 12, nameIndex: 0, bioIndex: 7, overviewIndex: 10 }, { handleIndex: 1, nameIndex: 6, bioIndex: 9, overviewIndex: 7 }, { handleIndex: 14, nameIndex: 5, bioIndex: 17, overviewIndex: 4 },
    { handleIndex: 5, nameIndex: 17, bioIndex: 11, overviewIndex: 15 }, { handleIndex: 3, nameIndex: 12, bioIndex: 11, overviewIndex: 10 }, { handleIndex: 18, nameIndex: 6, bioIndex: 1, overviewIndex: 3 }, { handleIndex: 2, nameIndex: 23, bioIndex: 9, overviewIndex: 16 },
    { handleIndex: 18, nameIndex: 17, bioIndex: 11, overviewIndex: 1 }, { handleIndex: 19, nameIndex: 14, bioIndex: 2, overviewIndex: 4 },
] as const;

const DEMO_PRIVATE_HANDLES = [
    'locked.dawn', 'locked.mood', 'locked.olive', 'locked.slow',
    'locked.paper', 'locked.blue', 'locked.walk', 'locked.bloom',
    'locked.film', 'locked.soft', 'locked.book', 'locked.cloud',
    'locked.palette', 'locked.frame', 'locked.sunny', 'locked.postcard',
    'locked.quiet', 'locked.garden', 'locked.moon', 'locked.warmth',
    'locked.glass', 'locked.river', 'locked.tangerine', 'locked.mellow',
] as const;

const DEMO_PRIVATE_NAMES = [
    '김가을', '이유빈', '박소정', '최하나', '정유빈', '한예원',
    '오서진', '문하늘', '배유나', '신다인', '임수빈', '권채아',
    '남유리', '송예진', '장서아', '노유진', '황다빈', '백하린',
    '유소연', '조다은', '차예린', '진수아', '표지민', '구채원',
] as const;

function fixtureIdentifier(stems: readonly string[], index: number): string {
    return `${stems[index % stems.length]}.${String(index + 1).padStart(3, '0')}`;
}

function publicAccount(index: number): FemaleResultRowV1 {
    const sourceProfile = DEMO_SOURCE_PROFILE_FIXTURE[index] ?? null;
    const variant = DEMO_FIXTURE_VARIANTS[
        index % DEMO_FIXTURE_VARIANTS.length
    ]!;
    const riskBand = index === 0 ? 'high_risk' : index < 3 ? 'caution' : 'normal';
    const displayScore = index === 0
        ? 8
        : index === 1
            ? 6
            : index === 2
                ? 5
                : sourceProfile
                    ? 3
                    : [2, 1][index % 2]!;
    return {
        instagramId: sourceProfile?.instagramId
            ?? fixtureIdentifier(DEMO_PUBLIC_HANDLES, variant.handleIndex + index * DEMO_PUBLIC_HANDLES.length),
        fullName: sourceProfile ? sourceProfile.fullName : DEMO_PUBLIC_NAMES[variant.nameIndex]!,
        profileImage: avatar(index),
        bio: sourceProfile ? sourceProfile.bio : DEMO_PUBLIC_BIOS[variant.bioIndex]!,
        displayScore,
        riskBand,
        featuredRank: index === 0 ? 1 : index < 3 ? index + 1 : null,
        recentMutualRank: index < 10 ? index + 1 : null,
        analysisDepth: index === 0 ? 'narrative' : 'features',
        oneLineOverview: DEMO_PUBLIC_OVERVIEWS[variant.overviewIndex]!,
        highRiskNarrative: index === 0
            ? [
                '공개 프로필과 최근 흐름은 굳이 눈에 띄지만, 단정할 근거는 아닙니다.',
                '좋아요 흔적은 제법 친절하지만 수집 범위 밖의 맥락까지 없다고 믿기는 이릅니다.',
            ]
            : null,
    };
}

function v3PublicAccount(index: number): FemaleResultRowV1 {
    const source = DEMO_V3_SOURCE_FIXTURE.public[index]!;
    return {
        instagramId: source.instagramId,
        fullName: source.fullName,
        profileImage: v3Avatar('female', source.imageSortOrdinal),
        bio: source.bio,
        displayScore: source.displayScore,
        riskBand: source.riskBand,
        featuredRank: source.featuredRank,
        recentMutualRank: source.recentMutualRank,
        analysisDepth: source.analysisDepth,
        oneLineOverview: source.oneLineOverview,
        highRiskNarrative: source.highRiskNarrative
            ? [source.highRiskNarrative[0], source.highRiskNarrative[1]]
            : null,
    };
}

function v4PublicAccount(index: number): FemaleResultRowV1 {
    const source = DEMO_V4_SOURCE_FIXTURE.public[index]!;
    return {
        instagramId: source.instagramId,
        fullName: source.fullName,
        profileImage: v3Avatar('female', source.imageSortOrdinal),
        bio: source.bio,
        displayScore: source.displayScore,
        riskBand: source.riskBand,
        featuredRank: source.featuredRank,
        recentMutualRank: source.recentMutualRank,
        analysisDepth: source.analysisDepth,
        oneLineOverview: source.oneLineOverview,
        highRiskNarrative: source.highRiskNarrative
            ? [source.highRiskNarrative[0], source.highRiskNarrative[1]]
            : null,
    };
}

/**
 * Canonical first-release v1 generator, retained for every persisted v1 row.
 * A later development-only rewrite mistakenly reused the same v1 version
 * marker, so its layout cannot be identified safely; historical rows always
 * use this original versioned presentation.
 */
function legacyFixtureIdentifier(index: number): string {
    const stems = ['mira.lane', 'sori.park', 'dana.river', 'june.willow'];
    return `${stems[index % stems.length]}.${String(index + 1).padStart(3, '0')}`;
}

function legacyPublicAccount(index: number): FemaleResultRowV1 {
    const riskBand = index === 0 ? 'high_risk' : index < 3 ? 'caution' : 'normal';
    const displayScore = index === 0 ? 8 : index < 3 ? 5 : 3;
    return {
        instagramId: legacyFixtureIdentifier(index),
        fullName: ['미라 류', '서린 박', '다나 윤', '주은 한'][index % 4],
        profileImage: avatar(index),
        bio: '일상과 취미를 기록하는 공개 프로필입니다.',
        displayScore,
        riskBand,
        featuredRank: index === 0 ? 1 : index < 3 ? index + 1 : null,
        recentMutualRank: index < 10 ? index + 1 : null,
        analysisDepth: index === 0 ? 'narrative' : 'features',
        oneLineOverview: index === 0
            ? '공개 프로필의 표현과 흐름이 눈에 띄지만 단정할 근거는 아닙니다.'
            : index < 3
                ? '공개 프로필의 최근 표현을 참고 신호로 살펴볼 수 있습니다.'
                : '공개 프로필에서 특별한 주의 신호는 확인되지 않았습니다.',
        highRiskNarrative: index === 0
            ? [
                '공개 프로필의 표현과 흐름이 눈에 띄지만, 굳이 단정할 근거는 아닙니다.',
                '공개 범위에서 확인된 좋아요 표현은 참고 신호이며 수집 범위의 한계가 있습니다.',
            ]
            : null,
    };
}

function legacyPrivateAccount(index: number): PrivateResultRowV1 {
    return {
        instagramId: `quiet.${['mira', 'sori', 'dana', 'june'][index % 4]}.${String(index + 1).padStart(3, '0')}`,
        fullName: ['민아 류', '소연 박', '다은 윤', '지우 한'][index % 4],
        profileImage: avatar(index),
    };
}

function demoProgressProfileId(progressBp: number): string {
    const index = Math.floor(progressBp / 1_000) % DEMO_SOURCE_HANDLE_FIXTURE.length;
    return `${DEMO_SOURCE_HANDLE_FIXTURE[index] ?? 'demo.profile'}*`;
}

function v3ProgressProfileId(progressBp: number): string {
    const index = Math.floor(progressBp / 1_000) % DEMO_V3_SOURCE_FIXTURE.public.length;
    return `${DEMO_V3_SOURCE_FIXTURE.public[index]!.instagramId}*`;
}

function v4ProgressProfileId(progressBp: number): string {
    const index = Math.floor(progressBp / 1_000) % DEMO_V4_SOURCE_FIXTURE.public.length;
    return `${DEMO_V4_SOURCE_FIXTURE.public[index]!.instagramId}*`;
}

function privateAccount(index: number): PrivateResultRowV1 {
    return {
        instagramId: fixtureIdentifier(DEMO_PRIVATE_HANDLES, index),
        fullName: DEMO_PRIVATE_NAMES[index % DEMO_PRIVATE_NAMES.length]!,
        profileImage: avatar(index),
    };
}

function v3PrivateAccount(index: number): PrivateResultRowV1 {
    const source = DEMO_V3_SOURCE_FIXTURE.private[index % DEMO_V3_SOURCE_FIXTURE.private.length]!;
    return {
        instagramId: source.instagramId,
        fullName: source.fullName,
        profileImage: v3Avatar('private', source.imageSortOrdinal),
    };
}

function v4PrivateAccount(index: number): PrivateResultRowV1 {
    const source = DEMO_V4_SOURCE_FIXTURE.private[index]!;
    return {
        instagramId: source.instagramId,
        fullName: source.fullName,
        profileImage: v3Avatar('private', source.imageSortOrdinal),
    };
}

export interface DemoFixture {
    /** Static versions are historical; database versions are operator-published. */
    version: string;
    summary: AnalysisResultSummaryV1;
    publicAccounts: FemaleResultRowV1[];
    privateAccounts: PrivateResultRowV1[];
}

export function demoReadyPreflight(
    run: { id: string; created_at: string },
    fixtureVersion: string = DEMO_FIXTURE_VERSION,
    fixtureTarget?: { fullName: string | null; bio: string | null; profileImage: string; followersCount: number; followingCount: number; isPrivate: false },
) {
    const counts = fixtureTarget
        ? { followers: fixtureTarget.followersCount, following: fixtureTarget.followingCount }
        : { followers: 600, following: 580 };
    const catalog = {
        ...ANALYSIS_PLAN_CATALOG,
        plus: { ...ANALYSIS_PLAN_CATALOG.plus, launchStatus: 'disabled' as const },
    };
    const cards = buildPlanSelectionCards(counts, { catalog });
    return {
        schemaVersion: 1 as const,
        preflightId: run.id,
        expiresAt: new Date(new Date(run.created_at).getTime() + DEMO_PREFLIGHT_TTL_MS).toISOString(),
        status: 'ready' as const,
        exclusionDecision: 'skip' as const,
        target: {
            username: DEMO_TARGET_USERNAME,
            fullName: fixtureTarget?.fullName ?? (fixtureVersion === LEGACY_DEMO_FIXTURE_VERSION
                ? '준호의 공개 프로필'
                : '모의 분석용 공개 계정'),
            bio: fixtureTarget?.bio ?? (fixtureVersion === LEGACY_DEMO_FIXTURE_VERSION
                ? '사진과 일상을 기록하는 공개 프로필입니다.'
                : '산책과 사진을 기록하는 데모 프로필입니다.'),
            profileImage: fixtureTarget?.profileImage ?? (isRedactedFixture(fixtureVersion) ? v3Avatar('target', 0) : avatar(0)),
            followersCount: counts.followers,
            followingCount: counts.following,
            isPrivate: fixtureTarget?.isPrivate ?? false,
        },
        accessMode: 'production' as const,
        capacityRequiredPlan: 'standard' as const,
        requiredPlan: 'standard' as const,
        plans: cards.map(card => ({
            planId: card.planId,
            launchStatus: catalog[card.planId].launchStatus,
            relationshipCapacity: catalog[card.planId].relationshipCapacity,
            detailedMutualLimit: catalog[card.planId].detailedMutualLimit,
            selectionState: card.selectionState,
            unavailableReason: card.unavailableReason,
            pricingVersion: PLAN_PRICING_VERSION,
            price: catalog[card.planId].price,
            remainingSlots: null,
        })),
        pricingVersion: PLAN_PRICING_VERSION,
    };
}

/** Fixed seed-equivalent generator that dispatches only between persisted fixture versions. */
export function createDemoFixture(
    requestId: string,
    fixtureVersion: DemoFixtureVersion = DEMO_FIXTURE_VERSION,
): DemoFixture {
    if (!requestId) throw new TypeError('A demo run id is required.');
    const publicAccounts = fixtureVersion === DEMO_FIXTURE_VERSION
        ? DEMO_V4_SOURCE_FIXTURE.public.map((_, index) => v4PublicAccount(index))
        : Array.from({ length: 242 }, (_, index) => fixtureVersion === LEGACY_DEMO_FIXTURE_VERSION
            ? legacyPublicAccount(index)
            : isV3Fixture(fixtureVersion)
                ? v3PublicAccount(index)
                : publicAccount(index));
    const privateAccounts = fixtureVersion === DEMO_FIXTURE_VERSION
        ? DEMO_V4_SOURCE_FIXTURE.private.map((_, index) => v4PrivateAccount(index))
        : Array.from({ length: 142 }, (_, index) => fixtureVersion === LEGACY_DEMO_FIXTURE_VERSION
            ? legacyPrivateAccount(index)
            : isV3Fixture(fixtureVersion)
                ? v3PrivateAccount(index)
                : privateAccount(index));
    const isV4Fixture = fixtureVersion === DEMO_FIXTURE_VERSION;
    return {
        version: fixtureVersion,
        summary: {
            targetInstagramId: DEMO_TARGET_USERNAME,
            targetFullName: '김준호',
            targetProfileImage: isRedactedFixture(fixtureVersion) ? v3Avatar('target', 0) : avatar(0),
            planId: 'standard',
            followers: { declared: 600, collected: 600, coverageRatio: 1, meetsCoverageGate: true, exactCountMatch: true },
            following: { declared: 580, collected: 580, coverageRatio: 1, meetsCoverageGate: true, exactCountMatch: true },
            detectedMutuals: isV4Fixture ? 229 : 384,
            publicMutuals: publicAccounts.length,
            privateMutuals: privateAccounts.length,
            screenedMutuals: publicAccounts.length,
            genderStats: isV4Fixture ? { male: 0, female: 84, unknown: 0 } : { male: 112, female: 96, unknown: 34 },
            notScreenedMutuals: 0,
            exclusionApplied: false,
            scorePolicyVersion: 'risk-policy-v2.3',
        },
        publicAccounts,
        privateAccounts,
    };
}

export function demoResultPage(input: {
    requestId: string;
    fixtureVersion?: DemoFixtureVersion;
    femaleCursor: string | null;
    privateCursor: string | null;
    pageSize: number;
}) {
    return demoResultPageFromFixture(createDemoFixture(input.requestId, input.fixtureVersion), input);
}

export function demoResultPageFromFixture(fixture: DemoFixture, input: {
    requestId: string;
    femaleCursor: string | null;
    privateCursor: string | null;
    pageSize: number;
}) {
    const publicPage = paginateAnalysisResults(fixture.publicAccounts, {
        list: 'public', direction: 'desc', sortKeyType: 'number', cursor: input.femaleCursor,
        pageSize: input.pageSize, getSortKey: row => row.displayScore, getCandidateId: row => row.instagramId,
    });
    const privatePage = paginateAnalysisResults(fixture.privateAccounts, {
        list: 'private', direction: 'asc', sortKeyType: 'string', cursor: input.privateCursor,
        pageSize: input.pageSize, getSortKey: row => row.instagramId, getCandidateId: row => row.instagramId,
    });
    return {
        schemaVersion: 1 as const,
        requestId: input.requestId,
        summary: fixture.summary,
        femaleAccounts: publicPage.items,
        privateAccounts: privatePage.items,
        femaleNextCursor: publicPage.nextCursor,
        privateNextCursor: privatePage.nextCursor,
    };
}

function track(progressBp: number, start: number, end: number, code: string) {
    const ratio = Math.max(0, Math.min(1, (progressBp - start) / Math.max(1, end - start)));
    const done = Math.round(ratio * 100);
    return { state: done === 100 ? 'completed' as const : done === 0 ? 'pending' as const : 'running' as const, stageCode: code, done, total: 100, progressBp: done * 100 };
}

function demoTrack(
    progressBp: number,
    start: number,
    end: number,
    runningCode: string,
    pendingCode: string,
    completedCode: string,
) {
    const projected = track(progressBp, start, end, runningCode);
    return {
        ...projected,
        stageCode: projected.state === 'completed'
            ? completedCode
            : projected.state === 'pending' ? pendingCode : runningCode,
    };
}

/** Canonical synthetic progression; the sequence mirrors the production V2 DAG. */
export const DEMO_PROGRESS_STAGE_SCHEDULE = [
    ['TARGET_PROFILE_READY', 0],
    ['RELATIONSHIPS_COLLECTING', 750],
    ['TARGET_INTERACTIONS_COLLECTING', 1500],
    ['PUBLIC_PROFILES_COLLECTING', 2250],
    ['PROFILE_SCREENING', 3000],
    ['PRIVATE_NAMES_SCREENING', 3750],
    ['EVIDENCE_JOINING', 4500],
    ['CANDIDATES_RANKING', 5250],
    ['SHORTLIST_INTERACTIONS_COLLECTING', 6000],
    ['PARTNER_CONTEXT_CHECKING', 6750],
    ['FINAL_SCORE_CALCULATING', 7500],
    ['HIGH_RISK_NARRATIVES_WRITING', 8250],
    ['RESULT_FINALIZING', 9000],
    ['ANALYSIS_COMPLETED', 10000],
] as const;

export function projectDemoProgress(input: {
    requestId: string;
    fixtureVersion?: string;
    startedAt: Date;
    durationSeconds: number;
    now: Date;
    afterSequence?: number;
    eventLimit?: number;
    fixture?: DemoFixture;
}): { snapshot: ProgressSnapshotV1; events: ProgressEventV1[] } {
    const elapsed = Math.max(0, input.now.getTime() - input.startedAt.getTime());
    const progressBp = Math.min(10_000, Math.floor(elapsed / (input.durationSeconds * 1_000) * 10_000));
    const completed = progressBp === 10_000;
    const activeStageCode = [...DEMO_PROGRESS_STAGE_SCHEDULE].reverse()
        .find(([, threshold]) => progressBp >= threshold)![0];
    const tracks = {
        relationshipAi: demoTrack(progressBp, 0, 5_250, activeStageCode, 'RELATIONSHIP_AI_QUEUED', 'RELATIONSHIP_AI_COMPLETE'),
        interactions: demoTrack(progressBp, 1_500, 7_500, activeStageCode, 'INTERACTIONS_QUEUED', 'INTERACTIONS_COMPLETE'),
        finalization: demoTrack(progressBp, 7_500, 10_000, activeStageCode, 'FINALIZATION_QUEUED', 'FINALIZATION_COMPLETE'),
    };
    if (completed) {
        tracks.relationshipAi = demoTrack(10_000, 0, 5_250, activeStageCode, 'RELATIONSHIP_AI_QUEUED', 'RELATIONSHIP_AI_COMPLETE');
        tracks.interactions = demoTrack(10_000, 1_500, 7_500, activeStageCode, 'INTERACTIONS_QUEUED', 'INTERACTIONS_COMPLETE');
        tracks.finalization = demoTrack(10_000, 7_500, 10_000, activeStageCode, 'FINALIZATION_QUEUED', 'FINALIZATION_COMPLETE');
    }
    const allEvents: ProgressEventV1[] = DEMO_PROGRESS_STAGE_SCHEDULE.filter((entry) => progressBp >= entry[1]).map(([copyCode, threshold], index) => ({
        schemaVersion: 1, requestId: input.requestId, seq: index + 1, revision: index + 1,
        occurredAt: new Date(input.startedAt.getTime() + input.durationSeconds * 1_000 * threshold / 10_000).toISOString(), state: 'confirmed',
        eventCode: copyCode === 'ANALYSIS_COMPLETED' ? 'ANALYSIS_COMPLETED' : index === 0 ? 'TARGET_PROFILE_READY' : index === 4 ? 'PROFILE_SCREENED' : 'RELATIONSHIP_PROGRESS',
        copyCode, aggregateCount: null,
    }));
    const afterSequence = Math.max(0, input.afterSequence ?? 0);
    const eventLimit = Math.max(1, input.eventLimit ?? 100);
    const events = allEvents.filter(event => event.seq > afterSequence).slice(0, eventLimit);
    return {
        snapshot: {
            schemaVersion: 1, requestId: input.requestId, revision: allEvents.length,
            status: completed ? 'completed' : 'processing', progressBp, backgroundProcessing: !completed,
            tracks,
            activeProfile: completed ? null : {
                maskedUsername: input.fixtureVersion === LEGACY_DEMO_FIXTURE_VERSION
                    ? 'profile.***'
                    : input.fixture
                        ? `${input.fixture.publicAccounts[Math.floor(progressBp / 1_000) % input.fixture.publicAccounts.length]!.instagramId}*`
                        : isRedactedFixture(input.fixtureVersion)
                        ? isV3Fixture(input.fixtureVersion ?? DEMO_FIXTURE_VERSION)
                            ? v3ProgressProfileId(progressBp)
                            : v4ProgressProfileId(progressBp)
                        : demoProgressProfileId(progressBp),
                imageUrl: input.fixture?.summary.targetProfileImage ?? (isRedactedFixture(input.fixtureVersion) ? v3Avatar('target', 0) : avatar(0)),
            },
            etaRange: completed ? null : { lowSeconds: Math.ceil((10_000 - progressBp) / 10_000 * input.durationSeconds), highSeconds: Math.ceil((10_000 - progressBp) / 10_000 * input.durationSeconds) },
            lastEventSeq: allEvents.length,
        },
        events,
    };
}
