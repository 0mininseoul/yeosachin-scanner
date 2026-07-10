export type TransportMode = 'direct';

export interface TransportConfig {
    mode: TransportMode;
}

export function getTransportConfig(
    env: Record<string, string | undefined> = process.env
): TransportConfig {
    const configuredMode = env.IG_TRANSPORT?.trim() || 'direct';
    if (configuredMode !== 'direct') {
        throw new Error('SCRAPING_CONFIG_ERROR: IG_TRANSPORT only supports direct.');
    }
    return { mode: 'direct' };
}

export function buildRequest(targetUrl: string, cfg: TransportConfig): { url: string } {
    if (cfg.mode !== 'direct') {
        throw new Error('SCRAPING_CONFIG_ERROR: unsupported selfhosted transport.');
    }
    return { url: targetUrl };
}
