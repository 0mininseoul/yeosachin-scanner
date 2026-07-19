import type { AnalyticsShareChannel } from './analytics';

interface ShareData {
    text?: string;
    title?: string;
    url: string;
}

interface ShareCapabilities {
    share?: (data: ShareData) => Promise<void>;
    writeText?: (text: string) => Promise<void>;
}

export async function shareResult(
    capabilities: ShareCapabilities,
    data: ShareData,
): Promise<AnalyticsShareChannel | null> {
    if (capabilities.share) {
        try {
            await capabilities.share(data);
            return 'web_share';
        } catch {
            // A confirmed clipboard fallback may still complete the share.
        }
    }

    if (capabilities.writeText) {
        try {
            await capabilities.writeText(data.url);
            return 'clipboard';
        } catch {
            return null;
        }
    }

    return null;
}
