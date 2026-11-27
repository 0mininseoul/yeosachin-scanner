import 'server-only';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { DraftError, generateBatchDrafts } from './editorial';
import { type DraftBatch, type Theme } from '@/lib/contracts/cherry-threads';
import {
    currentConnection, dateKST, draftRepository, nextEditorialTheme, requireData, requireRows, writeConnection,
} from './store';
import { containerStatus, createContainer, decryptToken, getThreadsPost, matchingOwnerReply, postInsights, publishContainer, recentThreadsPosts, refreshThreads } from './meta';

type Post = {
    id: string; body: string; reply: string | null; batch_id: string | null; state: string;
    scheduled_at: string | null; publish_slot: string | null; container_id: string | null;
    media_id: string | null; reply_container_id: string | null; reply_state: string;
};
const nowIso = () => new Date().toISOString();
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const kstClock = new Intl.DateTimeFormat('en-GB', {
    hour12: false, timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit',
});

async function automaticDraftBatch() {
    if (!process.env.CHERRY_OPENAI_API_KEY) return;
    const settings = requireData(await db.from('cherry_threads_preferences').select('*').eq('id', true).single());
    if (!settings.automatic_drafts) return;
    const [hour, minute] = kstClock.format().split(':').map(Number);
    if (hour * 60 + minute < settings.draft_hour * 60 + settings.draft_minute) return;
    const date = dateKST.format();
    const previous = requireData(await db.from('cherry_threads_batches').select('theme,run_date')
        .lte('run_date', date).order('run_date', { ascending: false }).limit(1).maybeSingle());
    if (previous?.run_date === date) return;
    requireData(await db.from('cherry_threads_batches').upsert({
        run_date: date, theme: nextEditorialTheme(previous?.theme as Theme | undefined), requested_count: settings.draft_count,
    }, { onConflict: 'run_date', ignoreDuplicates: true }));
}

async function draftWork() {
    await automaticDraftBatch();
    requireData(await db.from('cherry_threads_batches').update({ state: 'failed', error_code: 'ai_interrupted' })
        .eq('state', 'generating').lt('started_at', ago(5 * 60_000)));
    const candidate = requireData(await db.from('cherry_threads_batches').select('id')
        .eq('state', 'queued').order('created_at').limit(1).maybeSingle());
    if (!candidate) return;
    const batch = requireData(await db.from('cherry_threads_batches')
        .update({ state: 'generating', started_at: nowIso() })
        .eq('id', candidate.id).eq('state', 'queued').select('*').maybeSingle()) as DraftBatch | null;
    if (!batch) return;
    try {
        await generateBatchDrafts(batch, draftRepository);
    } catch (error) {
        requireData(await db.from('cherry_threads_batches').update({
            state: 'failed', error_code: error instanceof DraftError ? error.code : 'ai_unavailable',
        }).eq('id', batch.id).eq('state', 'generating').eq('started_at', batch.started_at!));
    }
}

async function persistPublished(post: Post, token: string, id: string) {
    // Merge any copy already discovered through read-only synchronization.
    const saved = requireData(await db.rpc('cherry_threads_confirm_published', { p_id: post.id, p_media: id }));
    if (!saved) return false;
    const details = await getThreadsPost(token, id).catch(() => null);
    if (details) requireData(await db.from('cherry_threads_posts').update({
        permalink: details.permalink, published_at: details.timestamp,
    }).eq('id', post.id).eq('media_id', id));
    return true;
}

async function incrementPostState(post: Post, expected: string, changes: Record<string, unknown>) {
    return requireRows(await db.from('cherry_threads_posts').update({ ...changes, touched_at: nowIso() })
        .eq('id', post.id).eq('state', expected).select('id')).length === 1;
}

async function publishRoot(token: string) {
    const [post] = requireData(await db.rpc('cherry_threads_claim_post')) as Post[];
    if (!post) return;
    let container = post.container_id;
    if (!container) {
        try {
            container = (await createContainer(token, post.body)).id;
        } catch {
            // Containers have no public effect until explicitly published.
            await incrementPostState(post, 'publishing', { state: 'scheduled', error_code: 'container_retry' });
            return;
        }
    }
    if (!await incrementPostState(post, 'publishing', { container_id: container })) return;
    const readiness = await containerStatus(token, container).catch(() => null);
    if (readiness !== 'FINISHED') {
        if (readiness === 'PUBLISHED') {
            await incrementPostState(post, 'publishing', { state: 'review', error_code: 'publish_unconfirmed' });
        } else {
            await incrementPostState(post, 'publishing', {
                state: 'scheduled', error_code: 'container_retry',
                ...(readiness === 'EXPIRED' || readiness === 'ERROR' ? { container_id: null } : {}),
            });
        }
        return;
    }
    try {
        const receipt = await publishContainer(token, container);
        await persistPublished(post, token, receipt.id);
    } catch {
        await incrementPostState(post, 'publishing', { state: 'review', error_code: 'publish_unconfirmed' });
    }
}

async function publishReply(token: string) {
    const post = requireData(await db.from('cherry_threads_posts').select('*')
        .eq('state', 'published').eq('reply_state', 'pending').order('published_at').limit(1).maybeSingle()) as Post | null;
    if (!post?.media_id || !post.reply) return;
    const transition = async (from: string, changes: Record<string, unknown>) => requireRows(await db
        .from('cherry_threads_posts').update({ ...changes, touched_at: nowIso() })
        .eq('id', post.id).eq('state', 'published').eq('reply_state', from).select('id')).length === 1;
    if (!await transition('pending', { reply_state: 'sending' })) return;
    let container = post.reply_container_id;
    if (!container) {
        try {
            container = (await createContainer(token, post.reply, post.media_id)).id;
        } catch {
            await transition('sending', { reply_state: 'pending', error_code: 'reply_container_retry' });
            return;
        }
    }
    if (!await transition('sending', { reply_container_id: container })) return;
    const readiness = await containerStatus(token, container).catch(() => null);
    if (readiness !== 'FINISHED') {
        if (readiness === 'PUBLISHED') {
            await transition('sending', { reply_state: 'review', error_code: 'reply_unconfirmed' });
        } else {
            await transition('sending', {
                reply_state: 'pending', error_code: 'reply_container_retry',
                ...(readiness === 'ERROR' || readiness === 'EXPIRED' ? { reply_container_id: null } : {}),
            });
        }
        return;
    }
    try {
        const receipt = await publishContainer(token, container);
        await transition('sending', { reply_state: 'published', reply_media_id: receipt.id, error_code: null });
    } catch {
        await transition('sending', { reply_state: 'review', error_code: 'reply_unconfirmed' });
    }
}

export async function verifyPublishedPost(id: string) {
    const [connection, result] = await Promise.all([
        currentConnection(), db.from('cherry_threads_posts').select('*').eq('id', id).maybeSingle(),
    ]);
    const post = requireData(result) as Post | null;
    if (!post || !connection || Date.parse(connection.expires_at) <= Date.now()) return false;
    const token = decryptToken(connection.token_ciphertext);
    if (post.state === 'published' && post.reply_state === 'review' && post.reply && post.media_id) {
        const status = post.reply_container_id ? await containerStatus(token, post.reply_container_id) : 'EXPIRED';
        if (status === 'PUBLISHED') {
            const match = await matchingOwnerReply(token, post.media_id, post.reply);
            if (!match) return false;
            return requireRows(await db.from('cherry_threads_posts').update({
                reply_state: 'published', reply_media_id: match, error_code: null,
            }).eq('id', post.id).eq('state', 'published').eq('reply_state', 'review').select('id')).length === 1;
        }
        if (status === 'IN_PROGRESS') return false;
        return requireRows(await db.from('cherry_threads_posts').update({
            reply_state: 'pending', error_code: null,
            ...(status === 'FINISHED' ? {} : { reply_container_id: null }),
        }).eq('id', post.id).eq('state', 'published').eq('reply_state', 'review').select('id')).length === 1;
    }
    if (post.state !== 'review' || !post.publish_slot || !post.batch_id) return false;
    const readiness = post.container_id ? await containerStatus(token, post.container_id) : 'EXPIRED';
    if (readiness === 'IN_PROGRESS') return false;
    if (readiness !== 'PUBLISHED') {
        const batch = requireData(await db.from('cherry_threads_batches').select('run_date')
            .eq('id', post.batch_id).single());
        if (!batch) return false;
        const deadline = Date.parse(batch.run_date + 'T03:20:00+09:00') + 86_400_000;
        if (Date.now() >= deadline) return false;
        return incrementPostState(post, 'review', {
            state: 'scheduled', error_code: null, ...(readiness === 'FINISHED' ? {} : { container_id: null }),
        });
    }
    const attemptedAt = Date.parse(post.publish_slot);
    const candidates = (await recentThreadsPosts(token)).filter(item => {
        const time = Date.parse(item.timestamp);
        return item.text?.trim() === post.body.trim() && time >= attemptedAt && time < attemptedAt + 20 * 60_000;
    });
    if (candidates.length !== 1) return false;
    return persistPublished(post, token, candidates[0].id);
}

async function readPendingInsights(token: string) {
    const candidates = requireRows(await db.from('cherry_threads_posts').select('id,media_id')
        .eq('state', 'published').not('media_id', 'is', null).is('measured_at', null)
        .lte('published_at', ago(24 * 60 * 60_000)).or(`insight_retry_at.is.null,insight_retry_at.lte.${nowIso()}`)
        .order('published_at').limit(4));
    await Promise.all(candidates.map(async row => {
        const metrics = await postInsights(token, row.media_id).catch(() => null);
        requireData(await db.from('cherry_threads_posts').update(metrics
            ? { ...metrics, measured_at: nowIso(), insight_retry_at: null }
            : { insight_retry_at: new Date(Date.now() + 6 * 60 * 60_000).toISOString() },
        ).eq('id', row.id).is('measured_at', null));
    }));
}

async function threadsWork() {
    const connection = await currentConnection();
    if (!connection || Date.parse(connection.expires_at) <= Date.now()) return;
    let token = decryptToken(connection.token_ciphertext);
    if (Date.parse(connection.refresh_after) <= Date.now()) {
        const renewed = await refreshThreads(token).catch(() => null);
        if (renewed) {
            token = renewed.access_token;
            await writeConnection(connection.account_id, token, renewed.expires_in);
        }
    }
    const enabled = process.env.CHERRY_THREADS_PUBLISH_ENABLED === 'true';
    if (enabled) {
        await Promise.all([
            db.from('cherry_threads_posts').update({ state: 'review', error_code: 'publish_unconfirmed' })
                .eq('state', 'publishing').lt('touched_at', ago(5 * 60_000)).then(requireData),
            db.from('cherry_threads_posts').update({ reply_state: 'review', error_code: 'reply_unconfirmed' })
                .eq('reply_state', 'sending').lt('touched_at', ago(5 * 60_000)).then(requireData),
        ]);
        await publishRoot(token);
        await publishReply(token);
    }
    await readPendingInsights(token);
}

export async function workOnCherryThreads() {
    const results = await Promise.allSettled([draftWork(), threadsWork()]);
    return {
        draftOk: results[0].status === 'fulfilled',
        threadsOk: results[1].status === 'fulfilled',
    };
}
