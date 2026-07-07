import { ProxyAgent } from 'undici';

export type TransportMode = 'direct' | 'scrape-api' | 'http-proxy';

export interface TransportConfig {
    mode: TransportMode;
    scrapeApiUrl?: string;
    scrapeApiKey?: string;
    proxyUrl?: string;
}

export function getTransportConfig(
    env: Record<string, string | undefined> = process.env
): TransportConfig {
    const raw = (env.IG_TRANSPORT || 'direct').trim();
    const mode: TransportMode = raw === 'scrape-api' || raw === 'http-proxy' ? raw : 'direct';
    return {
        mode,
        scrapeApiUrl: env.IG_SCRAPE_API_URL,
        scrapeApiKey: env.IG_SCRAPE_API_KEY,
        proxyUrl: env.IG_PROXY_URL,
    };
}

/**
 * transport 모드에 맞춰 실제 요청 URL과 (필요 시) undici dispatcher를 만든다.
 * dispatcher는 fetch 옵션의 `dispatcher`로 넘긴다 (Node/undici 확장).
 */
export function buildRequest(
    targetUrl: string,
    cfg: TransportConfig
): { url: string; dispatcher?: ProxyAgent } {
    if (cfg.mode === 'scrape-api') {
        if (!cfg.scrapeApiUrl || !cfg.scrapeApiKey) {
            throw new Error('SCRAPING_CONFIG_ERROR: IG_SCRAPE_API_URL/KEY가 설정되지 않았습니다.');
        }
        const sep = cfg.scrapeApiUrl.includes('?') ? '&' : '?';
        const url = `${cfg.scrapeApiUrl}${sep}api_key=${encodeURIComponent(cfg.scrapeApiKey)}&url=${encodeURIComponent(targetUrl)}`;
        return { url };
    }
    if (cfg.mode === 'http-proxy') {
        if (!cfg.proxyUrl) {
            throw new Error('SCRAPING_CONFIG_ERROR: IG_PROXY_URL이 설정되지 않았습니다.');
        }
        return { url: targetUrl, dispatcher: new ProxyAgent(cfg.proxyUrl) };
    }
    return { url: targetUrl };
}
