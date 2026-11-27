import { setTimeout as delay } from 'node:timers/promises';
import { ReaderError, requireReader } from './session.mjs';

export function safeCode(error) {
    if (error instanceof ReaderError && /^[A-Z][A-Z0-9_]{1,64}$/.test(error.message)) return error.message;
    if (/^CLOUD_OWNER_(?:BROWSER|HTTP)_[A-Z_]{1,40}$/.test(error?.message)) return error.message;
    return 'READER_UNAVAILABLE';
}

/** Start each owner's reads as soon as its own authoritative publication is visible. */
export async function monitorReaders(getRows, readOwner, emit, sleep = (ms) => delay(ms), participantCount = 6) {
    const started = new Map();
    const slots = new Map();
    const tasks = [];
    const cutoff = Date.now() + 3 * 60 * 60_000;
    try {
        while (slots.size < participantCount) {
            requireReader(Date.now() < cutoff, 'WAVE_EXPIRED');
            const rows = await getRows();
            requireReader(Array.isArray(rows) && rows.length === participantCount && new Set(rows.map(row => row.slot)).size === participantCount, 'ROSTER');
            for (const row of rows) {
                requireReader(Number.isInteger(row.slot) && row.slot >= 1 && row.slot <= participantCount, 'ROSTER_SLOT');
                if (slots.has(row.slot)) continue;
                if (row.startedAt) {
                    const at = Date.parse(row.startedAt);
                    requireReader(Number.isFinite(at) && (!started.has(row.slot) || started.get(row.slot) === at), 'SEAT_TIMESTAMP');
                    started.set(row.slot, at);
                }
                if (row.status === 'failed') {
                    slots.set(row.slot, { slot: row.slot, failure: 'ANALYSIS_FAILED' });
                    emit({ event: 'analysis_failure', slot: row.slot });
                    continue;
                }
                if (!row.publishedAt) continue;
                const begin = started.get(row.slot);
                const publication = Date.parse(row.publishedAt);
                requireReader(begin !== undefined && publication >= begin && typeof row.requestId === 'string', 'PUBLISHED_TIMESTAMPS');
                const slotResult = { slot: row.slot, publishedMs: publication - begin };
                slots.set(row.slot, slotResult);
                emit({ event: 'publication', slot: row.slot, elapsedMs: slotResult.publishedMs });
                tasks.push((async () => {
                    try {
                        const read = await readOwner(row.slot, row.requestId);
                        const browserMs = Date.parse(read.browser.completedAt) - begin;
                        const allImagesMs = Date.parse(read.http.completedAt) - begin;
                        requireReader(browserMs >= slotResult.publishedMs && allImagesMs >= slotResult.publishedMs, 'OBSERVER_CLOCK');
                        Object.assign(slotResult, { get: read.get, http: read.http, evidence: {
                            slot: row.slot, publishedMs: slotResult.publishedMs, browserMs, allImagesMs,
                            withinHour: Math.max(browserMs, allImagesMs) <= 3_600_000,
                            pages: read.http.pages, images: read.http.images, hydrated: read.browser.hydrated,
                            candidateImageDecoded: read.browser.candidateImageDecoded,
                        } });
                        emit({ event: 'owner_positive', ...slotResult.evidence });
                    } catch (error) {
                        slotResult.failure = safeCode(error);
                        emit({ event: 'owner_failure', slot: row.slot, code: slotResult.failure });
                    }
                })());
            }
            if (slots.size < participantCount) await sleep(5_000);
        }
    } finally {
        await Promise.all(tasks);
    }
    return [...slots.values()].sort((a, b) => a.slot - b.slot);
}
