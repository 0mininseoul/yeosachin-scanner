export const THEMES = ['ex', 'partner', 'crush', 'situationship'] as const;
export type Theme = (typeof THEMES)[number];
export const themeNames: Record<Theme, string> = {
    ex: '전남친', partner: '남친', crush: '짝남', situationship: '썸남',
};

export type Correction = {
    id: string; theme: Theme; before_text: string; after_text: string; reason: string; active: boolean;
};
export type DraftBatch = {
    id: string; run_date: string; theme: Theme; requested_count: number;
    state: 'queued' | 'generating' | 'ready' | 'failed'; started_at: string | null;
    correction_ids: string[]; error_code: string | null;
};
