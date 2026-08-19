import { describe, expect, it } from 'vitest';
import {
    targetProfileFullNameFromStepData,
    targetProfileImageFromStepData,
    toOwnerResultInteractionSummary,
    toResultInteractionSummary,
    toSafeRiskAnalysis,
} from './result-interactions';

describe('toResultInteractionSummary', () => {
    it('publishes only the bounded high-risk narrative', () => {
        expect(toResultInteractionSummary({
            risk_grade: 'high_risk',
            interaction_score: 55,
            interaction_coverage: '0.81234',
            interaction_coverage_status: 'high',
            female_to_target_likes_count: 3,
            female_to_target_comments_count: 2,
            target_to_female_likes_count: 1,
            recency_bonus: '6.667',
            risk_analysis: [
                '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
            ],
        })).toEqual({
            riskAnalysis: [
                '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
            ],
        });
    });

    it('fails closed to safe bounds for legacy or malformed rows', () => {
        expect(toResultInteractionSummary({
            risk_grade: 'high_risk',
            interaction_score: 999,
            interaction_coverage: -3,
            female_to_target_likes_count: 'invalid',
            female_to_target_comments_count: 999,
            target_to_female_likes_count: -1,
            recency_bonus: 999,
            risk_analysis: ['한 줄만 제공된 잘못된 값'],
        })).toEqual({
            riskAnalysis: [],
        });
    });

    it('normalizes exactly two distinct safe analysis lines', () => {
        expect(toSafeRiskAnalysis([
            '  <b>프로필은</b>\n꽤 눈에 띕니다.  ',
            '댓글 흔적은 제법 친절하지만\t수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([
            '프로필은 꽤 눈에 띕니다.',
            '댓글 흔적은 제법 친절하지만 수집 표본 밖 누락은 가능합니다.',
        ]);

        expect(toSafeRiskAnalysis(['중복', '중복'])).toEqual([]);
        expect(toSafeRiskAnalysis(['유효', 42])).toEqual([]);
    });

    it('withholds narratives outside the high-risk grade and rejects leaked metrics', () => {
        const lines = [
            '공개 프로필과 피드에서 위험 신호가 관측됐습니다.',
            '댓글 흔적은 보이지만 수집 표본 밖 누락은 가능합니다.',
        ];

        expect(toResultInteractionSummary({
            risk_grade: 'caution',
            risk_analysis: lines,
        })).toEqual({ riskAnalysis: [] });
        expect(toSafeRiskAnalysis([
            '좋아요 3건이 관측됐습니다.',
            '댓글 1개가 보이지만 수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([]);
        expect(toSafeRiskAnalysis([
            '프로필은 꽤 눈에 띕니다.',
            '좋아요를 세 번 확인했고 수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([]);
        expect(toSafeRiskAnalysis([
            '프로필은 꽤 눈에 띕니다.',
            '댓글은 두 개 보였지만 수집 표본 밖 누락은 가능합니다.',
        ])).toEqual([]);
    });

    it('keeps legacy share semantics while exposing canonical one-line overviews to the owner result', () => {
        const normalOverview = '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.';
        const cautionOverview = '사진과 일상 기록의 흐름이 한눈에 드러나는 공개 계정입니다.';

        expect(toResultInteractionSummary({
            risk_grade: 'normal',
            risk_analysis: [normalOverview],
        })).toEqual({ riskAnalysis: [] });

        expect(toOwnerResultInteractionSummary({
            risk_grade: 'normal',
            one_line_overview: normalOverview,
            risk_analysis: [],
        })).toEqual({ riskAnalysis: [], oneLineOverview: normalOverview });
        expect(toOwnerResultInteractionSummary({
            risk_grade: 'caution',
            one_line_overview: cautionOverview,
            risk_analysis: [],
        })).toEqual({ riskAnalysis: [], oneLineOverview: cautionOverview });
        expect(toOwnerResultInteractionSummary({
            risk_grade: 'high_risk',
            one_line_overview: normalOverview,
            risk_analysis: [
                '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
            ],
        })).toEqual({
            oneLineOverview: normalOverview,
            riskAnalysis: [
                '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
            ],
        });
    });

    it('preserves valid high-risk narratives when the additive overview is missing or invalid', () => {
        const highRiskNarrative = [
            '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
            '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
        ];
        const base = { risk_grade: 'high_risk', risk_analysis: highRiskNarrative };

        expect(toOwnerResultInteractionSummary({
            ...base,
            one_line_overview: null,
        })).toEqual({ riskAnalysis: highRiskNarrative });
        expect(toOwnerResultInteractionSummary({
            ...base,
            one_line_overview: '좋아요 3건이 관측됐습니다.',
        })).toEqual({ riskAnalysis: highRiskNarrative });
    });

    it('keeps normal and caution rows overview-only without inventing narratives', () => {
        const overview = '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.';
        const highRiskNarrative = [
            '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
            '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
        ];

        expect(toOwnerResultInteractionSummary({
            risk_grade: 'normal',
            one_line_overview: overview,
            risk_analysis: highRiskNarrative,
        })).toEqual({ oneLineOverview: overview, riskAnalysis: [] });
        expect(toOwnerResultInteractionSummary({
            risk_grade: 'caution',
            one_line_overview: null,
            risk_analysis: [],
        })).toEqual({ riskAnalysis: [] });
    });

    // Real one_line_overview text captured from canary request
    // 07b8a20f-a91c-4485-9143-10b2cc4afd05 (target handle 9ad8fa.01). Before the
    // candidate/target handle exception, the 7 rows below dropped their overview
    // outright because their own handle or the target's handle contains a digit.
    const CANARY_26_TARGET_USERNAME = '9ad8fa.01';
    const CANARY_26_ROWS = [
        { rank: 1, suspectUsername: 'chan__0.o', oneLineOverview: '채은님은 일본 여행의 추억과 친구들과의 소중한 일상을 공유하며 9ad8fa.01의 게시물에 직접 좋아요를 눌러 긍정적인 관심을 표현한 활달한 성격의 소유자입니다.' },
        { rank: 2, suspectUsername: 'yaannngi', oneLineOverview: '화려한 헤어스타일과 개성 넘치는 패션을 즐기는 YaaLily님은 9ad8fa.01의 게시물에 좋아요를 남기며 적극적인 관심을 표현하고 있습니다.' },
        { rank: 3, suspectUsername: '2ynbiu', oneLineOverview: '2ynbiu는 긴 흑발에 앞머리가 있는 모습으로 주로 흰색 의상을 입고 활동하며 9ad8fa.01의 게시물에 좋아요를 눌러 긍정적인 관심을 표현했습니다.' },
        { rank: 4, suspectUsername: 'asuka1200cc', oneLineOverview: 'asuka1200cc는 육중한 할리데이비슨과 픽업트럭을 배경으로 당당한 포즈를 취하며 서브컬처 아이템과 파격적인 의상을 자유롭게 오가는 도발적인 일상을 공유합니다.' },
        { rank: 5, suspectUsername: 'yul.__.moo', oneLineOverview: 'yul.__.moo는 9ad8fa.01의 게시물에 좋아요를 남겨 관심을 표현했으며 분홍색 드레스를 입은 토끼 캐릭터를 프로필로 사용하며 레코드 숍과 바다 등 여러 장소에서 촬영한 사진을 게시하고 있습니다.' },
        { rank: 6, suspectUsername: 'zi.seolfor', oneLineOverview: '지은님은 편안한 후드티부터 화려한 무대 의상과 핫팬츠까지 완벽하게 소화하며 거울 셀카와 야외 활동을 즐기는 다채로운 매력의 소유자입니다.' },
        { rank: 7, suspectUsername: 'didwldnj.s', oneLineOverview: 'didwldnj.s는 사이버펑크 캐릭터로 분해 담배 연기를 내뿜거나 로블록스 연습생을 자처하며 9ad8fa.01에게 애프터라이프에서 기다리겠다는 도발적인 메시지를 던지는 개성 강한 트러블메이커입니다.' },
        { rank: 8, suspectUsername: 'snreoai4', oneLineOverview: 'snreoai4는 오사카 여행의 여운을 뒤로한 채 반려묘 복덕이와 교감하며 높은 층수까지 걸어 올라가는 일상의 에너지를 가감 없이 드러내는 자유로운 영혼입니다.' },
        { rank: 9, suspectUsername: 'imm.h_l', oneLineOverview: '⠀님은 여행과 시원한 생맥주를 즐기며 일상의 갈증을 해소하는 매력적인 분위기의 소유자로, 다양한 스타일의 의상을 완벽하게 소화하며 세련된 감각을 드러냅니다.' },
        { rank: 10, suspectUsername: 'ou_rlove', oneLineOverview: '여름 , summer in my world님은 사진작가와 모델을 넘나들며 제주 구옥을 직접 고쳐 살 만큼 주관이 뚜렷하고 안경과 선글라스를 활용한 다채로운 스타일링으로 자유로운 예술가적 면모를 가감 없이 드러냅니다.' },
        { rank: 11, suspectUsername: 'i.luvpurple', oneLineOverview: '가민님은 화사한 꽃과 귀여운 고양이들에 둘러싸인 다정한 일상을 공유하면서도 어두운 밤거리에서 세련된 의상을 입고 독보적인 분위기를 자아내며 보는 이의 시선을 단숨에 사로잡습니다.' },
        { rank: 12, suspectUsername: 'edenpicz', oneLineOverview: '이효원, EDÉN님은 가지런한 앞머리와 해맑은 미소 뒤에 직장 동료들과의 즉흥적인 제주 여행을 즐기는 과감함을 숨기고 있으며, 평화와 안정을 강조하면서도 서른의 시작을 누구보다 씩씩하게 준비하는 야심가입니다.' },
        { rank: 13, suspectUsername: 'sr_bbliss_', oneLineOverview: '˓˓ก(⸍⸌̣ẉ̫⸍̣⸌)ค˒˒님은 긴 생머리에 매력적인 눈매를 지닌 미인으로 빈티지한 스타일부터 편안한 스트릿 패션까지 완벽히 소화하며 벚꽃 아래 단체 활동 속에서도 시선을 끄는 다채로운 매력의 소유자입니다.' },
        { rank: 14, suspectUsername: 'starxmz_', oneLineOverview: '민제님은 붉은 머리칼에 토끼 핀을 꽂고 작은 동물과 교감하거나 교복을 입고 풋풋한 분위기를 연출하는 등 다채롭고 생기 넘치는 일상을 공유하는 인물입니다.' },
        { rank: 15, suspectUsername: 'cyber5ni', oneLineOverview: '어두운 밤바다의 허무함을 즐기면서도 헤드셋과 게임 스크린 속에서 자신만의 강렬한 세계를 구축하며 입술 위에 위험한 장난을 더하는 불멸의 적토마님입니다.' },
        { rank: 16, suspectUsername: '_gin_tg_', oneLineOverview: 'GIN님은 아랍에미리트에서 댄스 스튜디오를 운영하며 첫 디지털 싱글을 발표한 예술가로, 일본 여행과 해변 휴양을 즐기며 카메라 앞에서 강렬한 존재감을 드러내는 매혹적인 인물입니다.' },
        { rank: 17, suspectUsername: 'eunbo714', oneLineOverview: '보은님은 싱가포르의 화려한 인피니티 풀부터 고요한 바닷가와 목장까지 넘나들며 긴 생머리와 청순한 스타일로 여행의 순간들을 기록하는 매력적인 인물입니다.' },
        { rank: 18, suspectUsername: 'waytatt.oo', oneLineOverview: '제주타투 웨이타투님은 온몸을 캔버스 삼아 나비와 장미, 화려한 오너먼트 문신을 새기고 해변에서 자유롭게 일상을 즐기는 매혹적인 아티스트입니다.' },
        { rank: 19, suspectUsername: 'h0nglean', oneLineOverview: '예술적 감각이 돋보이는 lean님은 제주와 독일을 배경으로 활동하며 카메라와 노트북을 든 채 몽환적인 분위기를 풍기는 영상 편집자이자 포토그래퍼입니다.' },
        { rank: 20, suspectUsername: 'madey_madey_', oneLineOverview: '예담님은 일본 밤거리를 배경으로 버스킹과 자작곡을 즐기며 자유로운 영혼의 매력을 발산하는 매혹적인 아티스트 타입입니다.' },
        { rank: 21, suspectUsername: 'jo_181911', oneLineOverview: '해변의 붉은 파라솔 아래서 여유를 즐기거나 카페에서 꽃다발을 든 채 사색에 잠기는 경화님은 일상의 모든 순간을 자신만의 뚜렷한 색깔과 매력으로 채워가는 주인공입니다.' },
        { rank: 22, suspectUsername: 'sh._.kk', oneLineOverview: '제주도에서 육지까지 농구 원정을 다닐 정도로 넘치는 에너지를 가진 소희님은 코트 위에서의 열정을 일상에서도 도발적인 매력으로 발산하며 주변의 시선을 즐기는 타입입니다.' },
        { rank: 23, suspectUsername: 'ttuyoli', oneLineOverview: '수 연님은 한라산 관음사 코스를 정복하는 강인한 체력과 좁은 골목길의 서정적인 무드를 동시에 즐길 줄 아는 다채로운 매력의 소유자입니다.' },
        { rank: 24, suspectUsername: 'hyz_ju31', oneLineOverview: '현정님은 선글라스를 끼고 푸른 들판에서 먼 곳을 가리키거나 파도가 치는 바다를 응시하며 자유로운 여행자의 면모를 보여주면서도 비공개된 비밀스러운 관계망을 암시합니다.' },
        { rank: 25, suspectUsername: '_m1njun9', oneLineOverview: '민정님에 대해 공개적으로 드러난 단서가 거의 없어 어떤 사람인지 구체적으로 판단하기에는 현재 남겨진 재료가 매우 부족합니다.' },
        { rank: 26, suspectUsername: 'sojung_sage', oneLineOverview: '소정님에 대해 확인된 정보가 거의 없어 현재로서는 판단을 내릴 만한 뚜렷한 근거가 충분하지 않습니다.' },
    ] as const;
    const CANARY_26_PREVIOUSLY_DROPPED_RANKS = [1, 2, 3, 4, 5, 7, 8];

    it('passes all 26 canary rows once the candidate/target handle exception is applied', () => {
        const outcomes = CANARY_26_ROWS.map((row) => ({
            rank: row.rank,
            passed: toOwnerResultInteractionSummary({
                risk_grade: 'normal',
                one_line_overview: row.oneLineOverview,
                risk_analysis: [],
                suspect_instagram_id: row.suspectUsername,
            }, CANARY_26_TARGET_USERNAME).oneLineOverview !== undefined,
        }));

        expect(outcomes.filter((outcome) => outcome.passed)).toHaveLength(26);
        for (const rank of CANARY_26_PREVIOUSLY_DROPPED_RANKS) {
            expect(outcomes.find((outcome) => outcome.rank === rank)?.passed).toBe(true);
        }
    });

    it('confirms the pre-fix regression: exactly 7 of the 26 canary rows drop their overview without the exception', () => {
        const droppedWithoutException = CANARY_26_ROWS.filter((row) => (
            toOwnerResultInteractionSummary({
                risk_grade: 'normal',
                one_line_overview: row.oneLineOverview,
                risk_analysis: [],
            }).oneLineOverview === undefined
        ));

        expect(droppedWithoutException.map((row) => row.rank)).toEqual(CANARY_26_PREVIOUSLY_DROPPED_RANKS);
        expect(droppedWithoutException).toHaveLength(7);
        expect(26 - droppedWithoutException.length).toBe(19);
    });

    it('allows only normalized Instagram media URLs from step data', () => {
        expect(targetProfileImageFromStepData({
            targetProfileImage: 'https://scontent.cdninstagram.com/avatar.jpg#fragment',
        })).toBe('https://scontent.cdninstagram.com/avatar.jpg');

        expect(targetProfileImageFromStepData({
            targetProfileImage: 'http://scontent.cdninstagram.com/avatar.jpg',
        })).toBeUndefined();
        expect(targetProfileImageFromStepData({
            targetProfileImage: 'https://example.com/avatar.jpg',
        })).toBeUndefined();
        expect(targetProfileImageFromStepData({ targetProfileImage: 42 })).toBeUndefined();
        expect(targetProfileImageFromStepData(null)).toBeUndefined();
    });

    it('reads a bounded concierge target full name and falls back across legacy step-data shapes', () => {
        expect(targetProfileFullNameFromStepData({
            conciergeBatchPublication: { targetFullName: '  임태욱  ' },
        })).toBe('임태욱');
        expect(targetProfileFullNameFromStepData({ targetFullName: '  임태욱  ' })).toBe('임태욱');
        expect(targetProfileFullNameFromStepData({
            conciergeBatchPublication: { targetFullName: '   ' },
            targetFullName: '임태욱',
        })).toBe('임태욱');
        expect(targetProfileFullNameFromStepData({ targetFullName: 'x'.repeat(201) })).toBeUndefined();
    });
});
