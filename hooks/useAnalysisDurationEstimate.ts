'use client';

import { useEffect, useState } from 'react';
import type { AnalysisDurationEstimate } from '@/lib/domain/analysis/duration-estimate';

export type HydratedDurationEstimate =
    | Readonly<{ source: 'workload'; estimate: AnalysisDurationEstimate }>
    | Readonly<{ source: 'demo'; lowSeconds: 60; highSeconds: 90 }>;

function parseEstimate(value: unknown): HydratedDurationEstimate | null {
    if (!value || typeof value !== 'object') return null;
    const response = value as Record<string, unknown>;
    if (response.source === 'demo'
        && response.version === 'demo-v1'
        && response.rangeSeconds
        && typeof response.rangeSeconds === 'object') {
        const range = response.rangeSeconds as Record<string, unknown>;
        return Object.keys(response).every(key => (
            key === 'source' || key === 'version' || key === 'rangeSeconds'
        ))
            && Object.keys(range).every(key => key === 'lowSeconds' || key === 'highSeconds')
            && range.lowSeconds === 60 && range.highSeconds === 90
            ? { source: 'demo', lowSeconds: 60, highSeconds: 90 }
            : null;
    }
    if (!Object.keys(response).every(key => key === 'estimate')) return null;
    if (!response.estimate || typeof response.estimate !== 'object') return null;
    const estimate = response.estimate as Record<string, unknown>;
    const range = estimate.range;
    if (!Object.keys(estimate).every(key => key === 'version' || key === 'band' || key === 'range')) {
        return null;
    }
    if (estimate.version !== 'v1' || !range || typeof range !== 'object') return null;
    const minutes = range as Record<string, unknown>;
    const validRanges = new Set(['4:6', '5:8', '8:12', '10:15']);
    if (!Object.keys(minutes).every(key => key === 'lowMinutes' || key === 'highMinutes')
        || !['small', 'typical', 'large', 'largest'].includes(String(estimate.band))
        || !validRanges.has(`${minutes.lowMinutes}:${minutes.highMinutes}`)) return null;
    return {
        source: 'workload',
        estimate: estimate as unknown as AnalysisDurationEstimate,
    };
}

/** Fetches the owner-only, range-only stage-two duration projection. */
export function useAnalysisDurationEstimate(input: {
    requestId: string;
    enabled: boolean;
    refreshKey?: string | number | null;
}) {
    const [estimate, setEstimate] = useState<HydratedDurationEstimate | null>(null);

    useEffect(() => {
        if (!input.enabled) {
            return;
        }
        const controller = new AbortController();
        void fetch(`/api/analysis/duration/${encodeURIComponent(input.requestId)}`, {
            cache: 'no-store', signal: controller.signal,
        })
            .then(async response => response.ok ? response.json() : null)
            .then(payload => {
                if (!controller.signal.aborted) setEstimate(parseEstimate(payload));
            })
            .catch(() => {
                if (!controller.signal.aborted) setEstimate(null);
            });
        return () => controller.abort();
    }, [input.enabled, input.refreshKey, input.requestId]);

    return estimate;
}

export const __test__ = { parseEstimate };
