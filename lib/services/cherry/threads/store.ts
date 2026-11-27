import 'server-only';
import { z } from 'zod';
import { supabaseAdmin as db } from '@/lib/supabase/admin';
import { decryptToken, encryptToken, metaConfigured, postInsights, recentThreadsPosts } from './meta';
import { type Correction, type DraftBatch, type Theme, THEMES } from '@/lib/contracts/cherry-threads';
import { type DraftRepository } from './editorial';

export const postColumns = 'id,batch_id,ordinal,body,reply,version,state,scheduled_at,permalink,published_at,reply_state,views,reader_replies,measured_at,error_code';
export const dateKST = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const dateString = z.iso.date();
const uuid = z.uuid();
const text = z.string().trim().min(1).max(500);
const reason = z.string().trim().min(1).max(1000);
const version = z.number().int().positive();
export const adminAction = z.discriminatedUnion('action', [
    z.object({ action: z.literal('generate'), date: dateString, theme: z.enum(THEMES), count: z.number().int().min(1).max(20) }),
    z.object({ action: z.literal('retry_drafts'), batch: uuid }),
    z.object({ action: z.literal('correct'), id: uuid, version, body: text, reply: text.nullable(), reason }),
    z.object({ action: z.literal('record_removed'), id: uuid, version, reason }),
    z.object({ action: z.literal('correction_active'), id: uuid, active: z.boolean() }),
    z.object({ action: z.literal('approve'), batch: uuid, slots: z.array(z.object({
        id: uuid, version, slot: z.iso.datetime({ offset: true }),
    })).min(1).max(20) }),
    z.object({ action: z.literal('sync') }),
    z.object({ action: z.literal('verify'), id: uuid }),
    z.object({ action: z.literal('automation'), enabled: z.boolean(), hour: z.number().int().min(0).max(23),
        minute: z.number().int().refine(m => m === 0 || m === 20 || m === 40), count: z.number().int().min(1).max(20) }),
]);

export type Connection = { account_id: string; token_ciphertext: string; expires_at: string; refresh_after: string };

export function requireData<T>(result: { data: T; error: unknown }): T {
    if (result.error) throw new Error('database');
    return result.data;
}

export function requireRows<T>(result: { data: T[] | null; error: unknown }): T[] {
    return requireData(result) ?? [];
}

export async function currentConnection() {
    return requireData(await db.from('cherry_threads_connection')
        .select('account_id,token_ciphertext,expires_at,refresh_after').eq('id', true).maybeSingle()) as Connection | null;
}

export async function writeConnection(account: string, token: string, expiresIn: number) {
    const now = Date.now();
    requireData(await db.from('cherry_threads_connection').upsert({
        id: true, account_id: account, token_ciphertext: encryptToken(token),
        expires_at: new Date(now + expiresIn * 1000).toISOString(),
        refresh_after: new Date(now + Math.max(86_460, expiresIn - 604_800) * 1000).toISOString(),
    }));
}

export async function loadEditorialConsole() {
    const [batches, corrections, connection, preferences] = await Promise.all([
        db.from('cherry_threads_batches').select('*').order('run_date', { ascending: false }).limit(14),
        db.from('cherry_threads_corrections').select('*').order('created_at', { ascending: false }).limit(100),
        db.from('cherry_threads_connection').select('expires_at').eq('id', true).maybeSingle(),
        db.from('cherry_threads_preferences').select('*').eq('id', true).single(),
    ]);
    const editorialBatches = requireRows(batches) as DraftBatch[];
    const recentCorrections = requireRows(corrections) as Correction[];
    const visibleIds = new Set(recentCorrections.map(row => row.id));
    const missingIds = [...new Set(editorialBatches.flatMap(batch => batch.correction_ids))]
        .filter(id => !visibleIds.has(id));
    const [posts, usedCorrections] = await Promise.all([
        editorialBatches.length ? db.from('cherry_threads_posts').select(postColumns)
            .in('batch_id', editorialBatches.map(batch => batch.id)).order('ordinal').limit(280).then(requireRows) : [],
        missingIds.length ? db.from('cherry_threads_corrections').select('*').in('id', missingIds).then(requireRows) : [],
    ]);
    return {
        batches: editorialBatches,
        posts,
        corrections: [...recentCorrections, ...usedCorrections],
        connection: requireData(connection),
        preferences: requireData(preferences),
        metaConfigured: metaConfigured(),
        aiConfigured: Boolean(process.env.CHERRY_OPENAI_API_KEY),
        serverPublishing: process.env.CHERRY_THREADS_PUBLISH_ENABLED === 'true',
        today: dateKST.format(),
        observed: requireRows(await db.from('cherry_threads_posts').select(postColumns).is('batch_id', null)
            .order('published_at', { ascending: false }).limit(25)),
    };
}

export const draftRepository: DraftRepository = {
    async corrections(theme) {
        return requireRows(await db.from('cherry_threads_corrections').select('*').eq('theme', theme)
            .eq('active', true).order('created_at', { ascending: false }).limit(12)) as Correction[];
    },
    async examples(theme) {
        const sameTheme = requireRows(await db.from('cherry_threads_batches').select('id').eq('theme', theme)
            .order('run_date', { ascending: false }).limit(12));
        const recent = db.from('cherry_threads_posts').select('body,views,reader_replies,reader_examples')
            .eq('state', 'published').not('measured_at', 'is', null).order('published_at', { ascending: false }).limit(8);
        return requireRows(await (sameTheme.length
            ? recent.or(`observed_theme.eq.${theme},batch_id.in.(${sameTheme.map(row => row.id).join(',')})`)
            : recent.eq('observed_theme', theme)));
    },
    async save(batch, posts, correctionIds) {
        return requireData(await db.rpc('cherry_threads_save_drafts', {
            p_batch: batch.id, p_started: batch.started_at, p_posts: posts, p_corrections: correctionIds,
        }));
    },
};

async function importRecent() {
    const connection = await currentConnection();
    if (!connection || Date.parse(connection.expires_at) <= Date.now()) return false;
    const token = decryptToken(connection.token_ciphertext);
    const existing = await recentThreadsPosts(token);
    const items = existing.flatMap(post => {
        if (!post.text?.trim() || post.text.length > 500) return [];
        const matches = new Set<Theme>();
        const labels = { '전남친': 'ex', '전남자친구': 'ex', '전애인': 'ex', '남친': 'partner',
            '남자친구': 'partner', '짝남': 'crush', '썸남': 'situationship' } as const;
        for (const text of post.text.matchAll(/전\s?(?:남친|남자친구|애인)|남자친구|남친|짝남|썸남/g)) {
            matches.add(labels[text[0].replace(/\s/g, '') as keyof typeof labels]);
        }
        return [{
            media_id: post.id, body: post.text, observed_theme: matches.size === 1 ? [...matches][0] : null,
            published_at: post.timestamp, permalink: post.permalink,
        }];
    });
    const imported = requireData(await db.rpc('cherry_threads_import', { p_items: items }));
    // Make the latest result visible immediately. The worker processes the remaining snapshots.
    const first = existing.find(post => post.text?.trim() && post.text.length <= 500);
    if (first) {
        const measured = await postInsights(token, first.id).catch(() => null);
        if (measured) requireData(await db.from('cherry_threads_posts')
            .update({ ...measured, measured_at: new Date().toISOString() }).eq('media_id', first.id).is('batch_id', null));
    }
    return { imported };
}

export async function applyEditorialAction(a: z.infer<typeof adminAction>) {
    switch (a.action) {
        case 'generate':
            if (a.date < dateKST.format() || !process.env.CHERRY_OPENAI_API_KEY) return false;
            return requireRows(await db.from('cherry_threads_batches').upsert({
                run_date: a.date, theme: a.theme, requested_count: a.count,
            }, { onConflict: 'run_date', ignoreDuplicates: true }).select('id')).length === 1;
        case 'retry_drafts':
            return requireRows(await db.from('cherry_threads_batches').update({ state: 'queued', error_code: null })
                .eq('id', a.batch).eq('state', 'failed').select('id')).length === 1;
        case 'correct':
        case 'record_removed':
            return requireData(await db.rpc('cherry_threads_correct', {
                p_id: a.id, p_version: a.version, p_body: a.action === 'correct' ? a.body : '',
                p_reply: a.action === 'correct' ? a.reply : null, p_reason: a.reason, p_removed: a.action === 'record_removed',
            }));
        case 'correction_active':
            return requireRows(await db.from('cherry_threads_corrections').update({ active: a.active })
                .eq('id', a.id).select('id')).length === 1;
        case 'approve':
            if (process.env.CHERRY_THREADS_PUBLISH_ENABLED !== 'true') return false;
            const connection = await currentConnection();
            if (!connection || Date.parse(connection.expires_at) <= Date.now()) return false;
            return requireData(await db.rpc('cherry_threads_approve', { p_batch: a.batch, p_schedule: a.slots }));
        case 'sync':
            return importRecent();
        case 'verify': {
            const { verifyPublishedPost } = await import('./worker');
            return verifyPublishedPost(a.id);
        }
        case 'automation':
            requireData(await db.from('cherry_threads_preferences').update({
                automatic_drafts: a.enabled, draft_hour: a.hour, draft_minute: a.minute, draft_count: a.count,
            }).eq('id', true));
            return true;
    }
}

export function nextEditorialTheme(previous?: Theme) {
    return THEMES[previous ? (THEMES.indexOf(previous) + 1) % THEMES.length : 0];
}
