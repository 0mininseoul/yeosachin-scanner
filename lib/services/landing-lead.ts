import { readAttribution } from './analytics-funnel';

interface ReportLandingLeadInput {
    instagramId: string;
    rawInput: string;
    search: string;
}

// 로그아웃 유저가 로그인 벽에 도달하는 시점에 리드를 기록한다. Fire-and-forget:
// 실패는 삼키고 로그인 흐름을 절대 막지 않는다.
export function reportLandingLead({ instagramId, rawInput, search }: ReportLandingLeadInput): void {
    try {
        const attribution = readAttribution(search);
        const referrer = typeof document !== 'undefined' && document.referrer
            ? document.referrer
            : undefined;
        void fetch('/api/leads', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ instagramId, rawInput, attribution, referrer }),
        }).catch(() => { /* best-effort */ });
    } catch {
        /* best-effort */
    }
}
