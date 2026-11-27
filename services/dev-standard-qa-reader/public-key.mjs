export const web = 'https://dev.yeosachin.com';
export const supabaseProject = 'bgamojfpkxnnumfvkron';
export const supabase = 'https://' + supabaseProject + '.supabase.co';

export function publicKey(value) {
    if (typeof value !== 'string') return false;
    if (/^sb_publishable_[A-Za-z0-9_-]{16,160}$/.test(value)) return true;
    if (!/^eyJ[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{12,1024}\.[A-Za-z0-9_-]{16,160}$/.test(value)) return false;
    try {
        const meta = JSON.parse(Buffer.from(value.split('.')[1], 'base64url'));
        return meta.role === 'anon' && meta.ref === supabaseProject && meta.sub == null;
    } catch { return false; }
}

async function readText(url, maxBytes, headers) {
    const response = await fetch(url, { method: 'GET', redirect: 'error', credentials: 'omit', headers,
        signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) {
        await response.body?.cancel();
        return '';
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body.cancel();
        throw new Error('PUBLIC_ASSET_SIZE');
    }
    const data = [];
    let length = 0;
    for await (const chunk of response.body) {
        length += chunk.length;
        if (length > maxBytes) throw new Error('PUBLIC_ASSET_SIZE');
        data.push(chunk);
    }
    return Buffer.concat(data).toString('utf8');
}

function candidates(text) {
    return (text.match(/(?<![A-Za-z0-9_-])(?:sb_publishable_[A-Za-z0-9_-]{16,160}|eyJ[A-Za-z0-9_-]{8,128}\.[A-Za-z0-9_-]{12,1024}\.[A-Za-z0-9_-]{16,160})(?![A-Za-z0-9_-])/g) ?? []).filter(publicKey);
}

async function validatesAtDev(key) {
    const body = await readText(supabase + '/auth/v1/settings', 256_000, { apikey: key });
    if (!body) return false;
    try {
        const settings = JSON.parse(body);
        return !!settings.external && typeof settings.external === 'object';
    } catch { return false; }
}

export async function resolveDevPublicKey(configured) {
    if (configured != null) {
        if (publicKey(configured) && await validatesAtDev(configured)) return configured;
        throw new Error('INVALID_DEV_PUBLIC_KEY');
    }
    const html = await readText(web + '/login', 1_000_000);
    const assets = new Set();
    for (const tag of html.match(/<(?:script|link)\b[^>]*>/gi) ?? []) {
        const src = tag.match(/\s(?:src|href)=["'](\/_next\/static\/[A-Za-z0-9_./~-]+\.js(?:\?[A-Za-z0-9=&_.~-]+)?)["']/i)?.[1];
        if (src && !src.split('/').includes('..')) assets.add(web + src);
    }
    if (assets.size > 64) throw new Error('PUBLIC_ASSET_COUNT');
    const seen = new Set();
    async function verified(keys) {
        for (const key of keys) {
            if (seen.has(key)) continue;
            seen.add(key);
            if (await validatesAtDev(key)) return key;
        }
    }
    const inline = await verified(candidates(html));
    if (inline) return inline;
    const queue = [...assets];
    // Bound concurrent downloads and discard each chunk as soon as its candidates are extracted.
    while (queue.length) {
        const batch = queue.splice(0, 4);
        const found = await Promise.all(batch.map(async url => candidates(await readText(url, 8_000_000))));
        const key = await verified(found.flat());
        if (key) return key;
    }
    throw new Error('DEV_PUBLIC_KEY_UNAVAILABLE');
}
