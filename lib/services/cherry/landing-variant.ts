/**
 * Meta A/B test variants of the Cherry pre-reservation landing page.
 * `bf` keeps the original boyfriend copy; `crush` swaps the target to 짝남 (design §6).
 */
export type CherryVariant = 'bf' | 'crush';

export function parseCherryVariant(value: string | null): CherryVariant | null {
    return value === 'bf' || value === 'crush' ? value : null;
}

/**
 * Applied in one left-to-right pass, so a replacement's output is never replaced again.
 * Specific phrases come before the generic word swaps that would otherwise match inside them.
 */
export const CRUSH_REPLACEMENTS: readonly (readonly [from: string, to: string])[] = [
    ['<span>내 남친은 나 몰래</span>', '<span>내 짝남은 내가 모르는 사이</span>'],
    ['내 남친은 나 몰래 누구랑', '내 짝남은 내가 모르는 사이 누구랑'],
    ['<h3>남자친구 비밀번호는 필요 없어요</h3>', '<h3>인스타 아이디 하나면 돼요</h3>'],
    ['짝남, 짝녀, 썸남, 썸녀, 여자친구', '남자친구, 썸남, 짝녀, 썸녀, 여자친구'],
    ['https://yeosachin.com/cherry/og.jpg', 'https://yeosachin.com/cherry/og-crush.jpg'],
    ['남자친구가', '짝남이'],
    ['남자친구', '짝남'],
    ['남친', '짝남'],
];

const crushTargets = new Map(CRUSH_REPLACEMENTS);
const crushPattern = new RegExp(
    CRUSH_REPLACEMENTS.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'g',
);

/**
 * Meta's base pixel code. autoConfig is off so the pixel does not collect page and button metadata on
 * its own. Automatic advanced matching (which could read the form's email and phone) is a separate
 * Events Manager toggle that must be off; the setup guide makes that a gate before ads start.
 */
function metaPixel(pixelId: string): string {
    return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('set','autoConfig',false,'${pixelId}');fbq('init','${pixelId}');fbq('track','PageView');</script>`;
}

export function renderCherryLanding(
    html: string,
    options: { variant: CherryVariant | null; concept?: CherryVariant | null; pixelId: string | null },
): string {
    const { variant, concept = null, pixelId } = options;
    const pageVariant = variant ?? concept;
    let page = pageVariant === 'crush' ? html.replace(crushPattern, (match) => crushTargets.get(match) ?? match) : html;
    if (pageVariant) {
        const organicAttribute = variant ? '' : ' data-organic-concept';
        page = page.replace('<html lang="ko">', `<html lang="ko" data-variant="${pageVariant}"${organicAttribute}>`);
    }
    // Only digits reach the inline script, so a malformed env value cannot inject markup.
    if (pixelId && /^\d{5,20}$/.test(pixelId)) {
        page = page.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n    ${metaPixel(pixelId)}`);
    }
    return page;
}
