import { parsePhoneNumberFromString } from 'libphonenumber-js/max';

const E164_KOREAN_MOBILE = /^\+8210\d{8}$/;

export function normalizeKoreanMobileNumber(
    input: string | null | undefined
): string | null {
    if (typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    const candidate = trimmed.startsWith('82') && !trimmed.startsWith('+')
        ? `+${trimmed}`
        : trimmed;
    const parsed = parsePhoneNumberFromString(candidate, {
        defaultCountry: 'KR',
        extract: false,
    });
    if (!parsed?.isValid() || parsed.ext || parsed.country !== 'KR') return null;
    const normalized = parsed.number;
    return E164_KOREAN_MOBILE.test(normalized) ? normalized : null;
}
