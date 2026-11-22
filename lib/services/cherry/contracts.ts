import { z } from 'zod';

/** Bump when any consent sentence changes; the accepted version is stored with the subscription. */
export const CHERRY_TERMS_VERSION = 'cherry-2026-11-v1';
export const CHERRY_LIST_PRICE_KRW = 9900;

export const CHERRY_CONSENTS = [
    {
        id: 'detection',
        label: '확인 방식과 한계를 확인했어요',
        detail: [
            '매일 공개된 팔로워·팔로잉 숫자를 확인하고, 숫자가 바뀌면 바뀐 목록을 다시 읽어요.',
            '숫자가 그대로인 교체는 최대 14일 뒤에 확인될 수 있고, 확인 사이에 생겼다가 사라진 맞팔은 알 수 없어요.',
            '변화가 아주 잦은 계정은 며칠에 한 번 모아서 확인해요.',
            '인스타그램이 목록에서 일부 계정을 빼고 보여줄 때가 있어요. 예전부터 맞팔이었을 가능성이 있으면 따로 표시해요.',
        ],
    },
    {
        id: 'price',
        label: '요금과 환불 조건에 동의해요',
        detail: [
            '이용 기간은 첫 목록을 저장한 때부터 1개월이에요.',
            '첫 목록이 24시간 안에 저장되지 않으면 전액 취소할 수 있어요.',
            '등록한 계정이 비공개로 바뀌거나 사라지면 이용을 멈추고 남은 기간 요금을 환불해요.',
            '해지하면 다음 결제가 없고, 이미 결제한 기간까지 이용할 수 있어요.',
        ],
    },
    {
        id: 'privacy',
        label: '개인정보 수집·이용에 동의해요',
        detail: [
            '수집 항목: 카카오 계정의 휴대폰 번호·이메일, 등록한 인스타그램 아이디, 결제 기록.',
            '등록한 계정의 공개 프로필과 공개된 팔로워·팔로잉 목록, 새 맞팔 계정의 공개 프로필·게시물을 알림과 리포트에 사용해요.',
            '리포트 사진은 30일, 목록과 리포트는 이용 종료 30일 뒤에 삭제해요. 결제 기록은 관련 법령에 따라 보관해요.',
        ],
    },
    {
        id: 'notice',
        label: '카카오톡·문자·이메일 알림을 받을게요',
        detail: ['새 맞팔과 이용 안내를 내 카카오 계정의 휴대폰 번호로 보내요. 전송이 안 되면 문자나 이메일로 보낼 수 있어요.'],
    },
] as const;

export type CherryConsentId = typeof CHERRY_CONSENTS[number]['id'];

export const checkoutRequestSchema = z.object({
    targetCheckId: z.string().uuid(),
    /** The price the member saw; a different one is never charged. */
    expectedAmountKrw: z.number().int().positive(),
    termsVersion: z.literal(CHERRY_TERMS_VERSION),
    consents: z.object({
        detection: z.literal(true), price: z.literal(true), privacy: z.literal(true), notice: z.literal(true),
    }).strict(),
}).strict();

export const renewRequestSchema = z.object({ expectedAmountKrw: z.number().int().positive() }).strict();
export const targetRequestSchema = z.object({ username: z.string().min(1).max(120) }).strict();
export const memberActionSchema = z.object({ action: z.enum(['cancel', 'resume', 'cancel_preparing']) }).strict();

/** Everything a browser may be told about an account lookup. */
export interface CherryTargetView {
    id: string;
    status: 'pending' | 'done';
    result: 'ok' | 'private' | 'not_found' | 'too_large' | 'too_small' | 'verified' | 'blocked' | 'unavailable' | null;
    username: string;
    fullName: string | null;
    followersCount: number | null;
    followingCount: number | null;
    postsCount: number | null;
    imagePath: string | null;
}

export type CherryCheckoutOutcome = 'ready' | 'sales_closed' | 'account_unavailable' | 'phone_required' | 'already_subscribed'
    | 'target_check_required' | 'target_blocked' | 'capacity_wait' | 'payment_unavailable' | 'payment_in_progress' | 'not_renewable'
    | 'price_changed' | 'reservation_in_use';
