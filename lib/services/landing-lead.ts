import { readAttribution } from './analytics-funnel';
import { anonymousPreflightDeviceId } from './analysis/anonymous-preflight-device';

const CAPTURE_TOKEN_STORAGE_KEY = 'landing:lead-capture-token';
const CAPTURE_TOKEN_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

let memoryCaptureToken: string | null = null;

function sessionStorageIfAvailable(): Storage | null {
    if (typeof window === 'undefined') return null;
    try {
        return window.sessionStorage;
    } catch {
        return null;
    }
}

function rememberLandingLeadCaptureToken(token: unknown): void {
    if (typeof token !== 'string' || !CAPTURE_TOKEN_PATTERN.test(token)) return;
    memoryCaptureToken = token;
    try {
        sessionStorageIfAvailable()?.setItem(CAPTURE_TOKEN_STORAGE_KEY, token);
    } catch {
        // Browser storage is optional; the in-memory handoff still works.
    }
}

export function readLandingLeadCaptureToken(): string | null {
    if (memoryCaptureToken) return memoryCaptureToken;
    try {
        const stored = sessionStorageIfAvailable()?.getItem(CAPTURE_TOKEN_STORAGE_KEY);
        return stored && CAPTURE_TOKEN_PATTERN.test(stored) ? stored : null;
    } catch {
        return null;
    }
}

export function consumeLandingLeadCaptureToken(): string | null {
    const token = readLandingLeadCaptureToken();
    memoryCaptureToken = null;
    try {
        sessionStorageIfAvailable()?.removeItem(CAPTURE_TOKEN_STORAGE_KEY);
    } catch {
        // Ignore unavailable browser storage.
    }
    return token;
}

interface ReportLandingLeadInput {
    instagramId: string;
    rawInput: string;
    search: string;
}

// 로그아웃 유저가 로그인 벽에 도달하는 시점에 리드를 기록한다. Fire-and-forget:
// 실패는 삼키고 로그인 흐름을 절대 막지 않는다.
export function reportLandingLead({ instagramId, rawInput, search }: ReportLandingLeadInput): void {
    try {
        const deviceId = anonymousPreflightDeviceId();
        const attribution = readAttribution(search);
        const referrer = typeof document !== 'undefined' && document.referrer
            ? document.referrer
            : undefined;
        void fetch('/api/leads', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(deviceId
                    ? { 'x-anonymous-device-id': deviceId }
                    : {}),
            },
            body: JSON.stringify({ instagramId, rawInput, attribution, referrer }),
        }).then(async response => {
            if (!response.ok) return;
            try {
                const payload: unknown = await response.json();
                if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
                    rememberLandingLeadCaptureToken(Reflect.get(payload, 'captureToken'));
                }
            } catch {
                // The lead is already durably captured; token handoff is optional.
            }
        }).catch(() => { /* best-effort */ });
    } catch {
        /* best-effort */
    }
}
