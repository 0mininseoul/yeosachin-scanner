import * as amplitude from '@amplitude/analytics-browser';

let isInitialized = false;

/**
 * Amplitude 초기화
 */
export function initAmplitude() {
    if (isInitialized || typeof window === 'undefined') return;

    const apiKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY;
    if (!apiKey || apiKey === 'xxx') {
        console.warn('Amplitude API key not configured');
        return;
    }

    amplitude.init(apiKey, {
        defaultTracking: {
            sessions: true,
            pageViews: true,
            formInteractions: true,
        },
    });

    isInitialized = true;
}

/**
 * 이벤트 트래킹
 */
export function trackEvent(
    eventName: string,
    properties?: Record<string, unknown>
) {
    if (!isInitialized) return;
    amplitude.track(eventName, properties);
}

/**
 * 유저 식별
 */
export function identifyUser(userId: string) {
    if (!isInitialized) return;
    amplitude.setUserId(userId);
}

/**
 * 유저 속성 설정
 */
export function setUserProperties(properties: {
    analysisCount?: number;
    isPaidUser?: boolean;
    signupDate?: string;
    lastAnalysisDate?: string;
}) {
    if (!isInitialized) return;

    const identify = new amplitude.Identify();

    if (properties.analysisCount !== undefined) {
        identify.set('analysis_count', properties.analysisCount);
    }
    if (properties.isPaidUser !== undefined) {
        identify.set('paid_user', properties.isPaidUser);
    }
    if (properties.signupDate) {
        identify.set('signup_date', properties.signupDate);
    }
    if (properties.lastAnalysisDate) {
        identify.set('last_analysis_date', properties.lastAnalysisDate);
    }

    amplitude.identify(identify);
}

// 정의된 이벤트 상수
export const EVENTS = {
    // 퍼널
    PAGE_VIEW_LANDING: 'page_view_landing',
    CLICK_CTA_START: 'click_cta_start',
    AUTH_COMPLETE: 'auth_complete',
    ANALYSIS_START: 'analysis_start',
    ANALYSIS_COMPLETE: 'analysis_complete',
    VIEW_RESULT: 'view_result',

    // 공유
    CLICK_SHARE_KAKAO: 'click_share_kakao',
    CLICK_SHARE_INSTAGRAM: 'click_share_instagram',

    CLICK_DEEP_SCAN: 'click_deep_scan',
    VIEW_DEEP_SCAN_BETA_MODAL: 'view_deep_scan_beta_modal',
} as const;
