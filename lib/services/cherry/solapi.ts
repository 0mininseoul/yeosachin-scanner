import { createHmac, randomBytes } from 'node:crypto';

const ENDPOINT = 'https://api.solapi.com/messages/v4/send-many/fast';
const TIMEOUT_MS = 15_000;

export interface SolapiConfig {
    apiKey: string;
    apiSecret: string;
    sender: string;
    channelId: string | null;
    templates: Readonly<Record<string, string>>;
}

export interface SolapiMessage {
    to: string;
    subject: string;
    text: string;
    /** Present for Alimtalk; the same text is delivered as LMS when Kakao cannot deliver. */
    kakao?: { templateId: string; variables: Record<string, string> };
}

/** The provider answered and refused; nothing was sent. */
export class SolapiRejectedError extends Error {
    constructor(readonly code: string) {
        super('SOLAPI_REJECTED');
        this.name = 'SolapiRejectedError';
    }
}

/** No usable answer; the message may have been sent. */
export class SolapiUnknownError extends Error {
    constructor() {
        super('SOLAPI_UNKNOWN');
        this.name = 'SolapiUnknownError';
    }
}

export function readSolapiConfig(env: Record<string, string | undefined> = process.env): SolapiConfig | null {
    const apiKey = env.CHERRY_SOLAPI_API_KEY?.trim();
    const apiSecret = env.CHERRY_SOLAPI_API_SECRET?.trim();
    const sender = env.CHERRY_SOLAPI_SENDER?.replace(/\D/g, '');
    if (!apiKey || !apiSecret || !sender) return null;
    let templates: Record<string, string> = {};
    try {
        const parsed: unknown = JSON.parse(env.CHERRY_ALIMTALK_TEMPLATES?.trim() || '{}');
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            templates = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));
        }
    } catch {
        // A malformed template map disables Alimtalk and leaves text messages working.
    }
    return { apiKey, apiSecret, sender, channelId: env.CHERRY_KAKAO_CHANNEL_ID?.trim() || null, templates };
}

export function solapiAuthorization(config: Pick<SolapiConfig, 'apiKey' | 'apiSecret'>, date: string, salt: string): string {
    const signature = createHmac('sha256', config.apiSecret).update(date + salt).digest('hex');
    return `HMAC-SHA256 apiKey=${config.apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

export function localKoreanNumber(phone: string): string {
    return phone.replace(/^\+82/, '0').replace(/\D/g, '');
}

export async function sendSolapi(
    config: SolapiConfig, message: SolapiMessage, request: typeof fetch = fetch,
): Promise<{ groupId: string }> {
    const body = { messages: [{
        to: localKoreanNumber(message.to), from: config.sender, text: message.text,
        ...(message.kakao && config.channelId
            ? { type: 'ATA', subject: message.subject, kakaoOptions: {
                pfId: config.channelId, templateId: message.kakao.templateId, disableSms: false,
                variables: Object.fromEntries(Object.entries(message.kakao.variables).map(([key, value]) => [`#{${key}}`, value])),
            } }
            : { type: 'LMS', subject: message.subject }),
    }], allowDuplicates: false };
    let response: Response;
    let data: Record<string, unknown>;
    try {
        response = await request(ENDPOINT, {
            method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: {
                'Content-Type': 'application/json',
                Authorization: solapiAuthorization(config, new Date().toISOString(), randomBytes(16).toString('hex')),
            },
            body: JSON.stringify(body),
        });
        data = await response.json() as Record<string, unknown>;
    } catch {
        throw new SolapiUnknownError();
    }
    if (response.status >= 400 && response.status < 500) {
        throw new SolapiRejectedError(String(data.errorCode ?? `http_${response.status}`).slice(0, 60));
    }
    const group = data.groupInfo as { groupId?: unknown; _id?: unknown; count?: { total?: number; registeredFailed?: number } } | undefined;
    if (!response.ok || !group) throw new SolapiUnknownError();
    if (group.count?.total !== undefined && group.count.total === group.count.registeredFailed) {
        const failed = (data.failedMessageList as { statusCode?: unknown }[] | undefined)?.[0];
        throw new SolapiRejectedError(String(failed?.statusCode ?? 'registered_failed').slice(0, 60));
    }
    return { groupId: String(group.groupId ?? group._id ?? '').slice(0, 120) };
}
