import type { ZodType } from 'zod';

function extractJsonObject(text: string): unknown {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
    const candidate = fenced || trimmed;

    try {
        return JSON.parse(candidate) as unknown;
    } catch {
        const start = candidate.indexOf('{');
        const end = candidate.lastIndexOf('}');
        if (start < 0 || end <= start) {
            throw new Error('Gemini response did not contain a JSON object');
        }
        try {
            return JSON.parse(candidate.slice(start, end + 1)) as unknown;
        } catch {
            throw new Error('Gemini response contained invalid JSON');
        }
    }
}

export function parseGeminiJsonResponse<T>(text: string, schema: ZodType<T>): T {
    const parsedJson = extractJsonObject(text);
    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) {
        throw new Error('Gemini response did not match the required analysis schema');
    }
    return parsed.data;
}
