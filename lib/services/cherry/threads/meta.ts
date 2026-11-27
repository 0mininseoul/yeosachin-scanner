import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const graph = 'https://graph.threads.com';
const version = '/v1.0';
export const threadsUsername = 'youlovecherry_';
const user = z.object({ id: z.string(), username: z.string() });
const idResult = z.object({ id: z.string() });
const tokenResult = z.object({ access_token: z.string(), expires_in: z.number().int().positive() });
const post = z.object({
    id: z.string(), text: z.string().nullish(), timestamp: z.string(),
    permalink: z.string().url().nullish(), is_reply: z.boolean().optional(),
});
const conversation = z.object({
    data: z.array(z.object({ id: z.string(), username: z.string().nullish(), text: z.string().nullish() })),
    paging: z.object({ cursors: z.object({ after: z.string().optional() }).optional(), next: z.string().optional() }).optional(),
});
const metrics = z.object({ data: z.array(z.object({
    name: z.string(), values: z.array(z.object({ value: z.number().nonnegative().int() })).optional(),
})) });

export function metaConfigured() {
    return Boolean(process.env.CHERRY_THREADS_APP_ID && process.env.CHERRY_THREADS_APP_SECRET
        && process.env.CHERRY_THREADS_REDIRECT_URI && process.env.CHERRY_THREADS_TOKEN_KEY);
}

function tokenKey() {
    const key = Buffer.from(process.env.CHERRY_THREADS_TOKEN_KEY || '', 'base64');
    if (key.length !== 32) throw new Error('threads_token_key');
    return key;
}

export function encryptToken(token: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', tokenKey(), iv);
    const payload = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
}

export function decryptToken(encoded: string) {
    const val = Buffer.from(encoded, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', tokenKey(), val.subarray(0, 12));
    cipher.setAuthTag(val.subarray(12, 28));
    return Buffer.concat([cipher.update(val.subarray(28)), cipher.final()]).toString('utf8');
}

async function call<T>(
    path: string, schema: z.ZodType<T>, params: Record<string, string> = {}, token?: string, method = 'GET',
): Promise<T> {
    const url = new URL(path, graph);
    const form = new URLSearchParams(params);
    if (method === 'GET') url.search = form.toString();
    const response = await fetch(url, {
        method,
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        body: method === 'POST' ? form : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(12_000),
    }).catch(() => { throw new Error('threads_network'); });
    if (!response.ok) throw new Error('threads_api');
    return schema.parse(await response.json());
}

export function authorizeUrl(state: string) {
    const url = new URL('https://threads.com/oauth/authorize');
    url.search = new URLSearchParams({
        client_id: process.env.CHERRY_THREADS_APP_ID!,
        redirect_uri: process.env.CHERRY_THREADS_REDIRECT_URI!,
        state, response_type: 'code',
        scope: 'threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies,threads_manage_insights',
    }).toString();
    return url;
}

export async function connectThreads(code: string) {
    const short = await call('/oauth/access_token', z.object({ access_token: z.string() }), {
        code, client_id: process.env.CHERRY_THREADS_APP_ID!,
        client_secret: process.env.CHERRY_THREADS_APP_SECRET!,
        redirect_uri: process.env.CHERRY_THREADS_REDIRECT_URI!, grant_type: 'authorization_code',
    }, undefined, 'POST');
    const profile = await call(`${version}/me`, user, { fields: 'id,username' }, short.access_token);
    if (profile.username !== threadsUsername) throw new Error('threads_wrong_account');
    const result = await call('/access_token', tokenResult, {
        grant_type: 'th_exchange_token', client_secret: process.env.CHERRY_THREADS_APP_SECRET!,
        access_token: short.access_token,
    });
    return { profile, ...result };
}

export function refreshThreads(token: string) {
    return call('/refresh_access_token', tokenResult, { grant_type: 'th_refresh_token', access_token: token });
}

export function createContainer(token: string, text: string, rootId?: string) {
    return call(`${version}/me/threads`, idResult, {
        media_type: 'TEXT', text, ...(rootId ? { reply_to_id: rootId } : {}),
    }, token, 'POST');
}

export function publishContainer(token: string, container: string) {
    return call(`${version}/me/threads_publish`, idResult, { creation_id: container }, token, 'POST');
}

export function getThreadsPost(token: string, id: string) {
    return call(`${version}/${encodeURIComponent(id)}`, post, {
        fields: 'id,text,timestamp,permalink,is_reply',
    }, token);
}

export async function recentThreadsPosts(token: string) {
    const result = await call(`${version}/me/threads`, z.object({ data: z.array(post) }), {
        fields: 'id,text,timestamp,permalink,is_reply', limit: '25',
    }, token);
    return result.data.filter(item => !item.is_reply);
}

export async function postInsights(token: string, id: string) {
    const path = `${version}/${encodeURIComponent(id)}`;
    const [stats, replies] = await Promise.all([
        call(`${path}/insights`, metrics, { metric: 'views' }, token),
        readConversation(path, token),
    ]);
    const views = stats.data.find(metric => metric.name === 'views')?.values?.[0]?.value;
    if (views === undefined) throw new Error('threads_insight_missing');
    return { views, reader_replies: replies.count, reader_examples: replies.examples };
}

async function readConversation(path: string, token: string) {
    const readers = new Map<string, string>();
    let after: string | undefined;
    // Limit one worker invocation. If Meta still has more pages, the count is unknown.
    for (let page = 0; page < 5; page++) {
        const response = await call(`${path}/conversation`, conversation, {
            fields: 'id,username,text', limit: '100', ...(after ? { after } : {}),
        }, token);
        for (const reply of response.data) {
            if (reply.username && reply.username !== threadsUsername) readers.set(reply.id, reply.text || '');
        }
        const examples = [...readers.values()].filter(Boolean).slice(0, 5).map(v => v.slice(0, 120));
        if (!response.paging?.next) return { count: readers.size, examples };
        after = response.paging.cursors?.after;
        if (!after || page === 4) return { count: null, examples };
    }
    return { count: null, examples: [] };
}

export async function containerStatus(token: string, id: string) {
    const result = await call(`${version}/${encodeURIComponent(id)}`, z.object({
        status: z.enum(['EXPIRED', 'ERROR', 'FINISHED', 'IN_PROGRESS', 'PUBLISHED']),
    }), { fields: 'status' }, token);
    return result.status;
}

export async function matchingOwnerReply(token: string, root: string, text: string) {
    const result = await call(`${version}/${encodeURIComponent(root)}/replies`, conversation, {
        fields: 'id,username,text', limit: '100',
    }, token);
    if (result.paging?.next) return null;
    const matches = result.data.filter(item => item.username === threadsUsername && item.text?.trim() === text.trim());
    return matches.length === 1 ? matches[0].id : null;
}
