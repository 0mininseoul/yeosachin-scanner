import { supabaseAdmin } from '@/lib/supabase/admin';
import { summarizeCherryAccount } from './ai-summary';
import { collectCherryProfiles } from './checks';
import { CherryDeferError, cherryErrorCode } from './errors';
import { storeCherryImage, type CherryStoredImage } from './images';
import type { CherryProfile } from './instagram';
import { assertNoDatabaseError, cherryRpc } from './rpc';
import { loadCherrySettings, type CherryEventImage, type CherryEventRow, type CherryReportRow } from './store';

/** Details are read for the first accounts of a day; the rest stay a plain list. */
export const CHERRY_REPORT_DETAIL_LIMIT = 10;
const MAX_ATTEMPTS = 4;
/** A notice must not wait on details for longer than this. */
const MAX_WAIT_MS = 90 * 60_000;
const AI_CONCURRENCY = 2;

async function loadEvents(reportId: string): Promise<CherryEventRow[]> {
    const { data, error } = await supabaseAdmin.from('cherry_mutual_events').select('*').eq('report_id', reportId).order('position');
    assertNoDatabaseError('report_events', error);
    return (data ?? []) as CherryEventRow[];
}

async function updateEvent(id: string, patch: Record<string, unknown>): Promise<void> {
    const { error } = await supabaseAdmin.from('cherry_mutual_events').update(patch).eq('id', id);
    assertNoDatabaseError('report_event_update', error);
}

async function storeImages(report: CherryReportRow, event: CherryEventRow, profile: CherryProfile): Promise<CherryStoredImage[]> {
    const sources = [
        ...(profile.profilePicUrl ? [{ slot: 'profile', url: profile.profilePicUrl, role: 'profile' as const, shortCode: null }] : []),
        ...profile.posts.flatMap((post, index) => post.imageUrl
            ? [{ slot: `post-${index}`, url: post.imageUrl, role: 'post' as const, shortCode: post.shortCode }] : []),
    ];
    const settled = await Promise.allSettled(sources.map(source => storeCherryImage({
        subscriptionId: report.subscription_id, eventId: event.id, slot: source.slot, url: source.url,
    })));
    const images: CherryEventImage[] = [];
    const stored: CherryStoredImage[] = [];
    settled.forEach((item, index) => {
        if (item.status !== 'fulfilled') return;
        stored.push(item.value);
        images.push({ key: item.value.key, role: sources[index].role, shortCode: sources[index].shortCode });
    });
    await updateEvent(event.id, { images });
    return stored;
}

async function buildEvent(report: CherryReportRow, event: CherryEventRow, profile: CherryProfile, aiEnabled: boolean): Promise<void> {
    await updateEvent(event.id, { profile: {
        biography: profile.biography, followersCount: profile.followersCount,
        followingCount: profile.followingCount, postsCount: profile.postsCount,
    }, is_private: profile.isPrivate, is_verified: profile.isVerified });
    const images = await storeImages(report, event, profile);
    await updateEvent(event.id, { detail_status: 'done' });
    // A private account shows nothing to summarize.
    if (!aiEnabled || profile.isPrivate || (profile.posts.length === 0 && !profile.biography)) {
        await updateEvent(event.id, { ai_status: 'skipped' });
        return;
    }
    try {
        const summary = await summarizeCherryAccount({
            eventId: event.id, username: event.username, fullName: event.full_name, biography: profile.biography,
            captions: profile.posts.map(post => post.caption.slice(0, 300)).filter(Boolean),
            images: images.map(image => image.jpegBase64), attempt: report.attempts,
        });
        await updateEvent(event.id, { summary, ai_status: 'done' });
    } catch {
        // The notice does not depend on the summary.
        await updateEvent(event.id, { ai_status: 'failed' });
    }
}

async function runLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
    const queue = [...items];
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
    }));
}

export function claimCherryReports(limit: number, leaseSeconds: number): Promise<CherryReportRow[]> {
    return cherryRpc<CherryReportRow[]>('cherry_claim_reports', { p_limit: limit, p_lease_seconds: leaseSeconds });
}

export async function processCherryReport(report: CherryReportRow, deadlineAtMs: number): Promise<{ outcome: 'done' | 'deferred'; code?: string }> {
    const events = await loadEvents(report.id);
    const pending = events.filter(event => event.detail_status === 'pending').slice(0, CHERRY_REPORT_DETAIL_LIMIT);
    const overdue = Date.now() - Date.parse(report.created_at) > MAX_WAIT_MS || report.attempts >= MAX_ATTEMPTS;
    try {
        if (pending.length > 0) {
            const settings = await loadCherrySettings();
            const profiles = await collectCherryProfiles({
                ownerKey: `report:${report.id}`, operation: `details_${events.length}`, subscriptionId: report.subscription_id,
                slot: 'secondary', usernames: pending.map(event => event.username), deadlineAtMs,
            });
            await runLimited(pending, AI_CONCURRENCY, async event => {
                const found = profiles.get(event.username.toLowerCase());
                // The same handle must still be the account that was detected.
                if (found?.status === 'found' && found.profile.id === event.instagram_id) {
                    await buildEvent(report, event, found.profile, settings.ai_enabled);
                } else {
                    await updateEvent(event.id, { detail_status: 'failed', ai_status: 'skipped' });
                }
            });
        }
    } catch (error) {
        if (!overdue) {
            // The lease is released early so the next minute can resume the same paid run.
            const delay = error instanceof CherryDeferError ? error.options.delaySeconds : 300;
            const { error: releaseError } = await supabaseAdmin.from('cherry_reports')
                .update({ lease_expires_at: new Date(Date.now() + delay * 1000).toISOString() })
                .eq('id', report.id).eq('lease_token', report.lease_token);
            assertNoDatabaseError('report_release', releaseError);
            return { outcome: 'deferred', code: cherryErrorCode(error) };
        }
    }
    const left = (await loadEvents(report.id)).filter(event => event.detail_status === 'pending');
    for (const event of left) await updateEvent(event.id, { detail_status: 'skipped', ai_status: 'skipped' });
    await cherryRpc('cherry_finish_report', { p_report: report.id, p_lease: report.lease_token });
    return { outcome: 'done' };
}
