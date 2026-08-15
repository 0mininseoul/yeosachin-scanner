import type { ZodIssue, ZodType } from 'zod';

const MAX_RESPONSE_VALIDATION_ISSUES = 12;
const SAFE_SCHEMA_PATH_SEGMENTS = new Set([
    'value',
    'gender',
    'confidence',
    'reasoning',
    'assessment',
    'inferredGender',
    'genderConfidence',
    'genderReasoning',
    'ownerConsistency',
    'routingDecision',
    'routingReason',
    'appearanceGrade',
    'exposureScore',
    'businessClassification',
    'businessConfidence',
    'accountContext',
    'marriageEvidence',
    'partnerEvidence',
    'partnerExclusionContext',
    'evidenceSelectionIds',
    'appearance',
    'exposure',
    'business',
    'marriagePartner',
    'oneLineOverview',
    'lines',
    'results',
    'id',
    'femaleScore',
    'isName',
]);

export type GeminiResponseValidationCategory =
    | 'missing_json_object'
    | 'invalid_json'
    | 'schema_validation'
    | 'candidate_contract';

export interface GeminiResponseValidationDiagnostics {
    category: GeminiResponseValidationCategory;
    issues: readonly {
        path: string;
        code: string;
    }[];
    truncated: boolean;
}

export class GeminiResponseValidationError extends Error {
    readonly repairContext?: Readonly<{
        candidate: unknown;
        issues: readonly ZodIssue[];
    }>;

    constructor(
        message: string,
        public readonly diagnostics: GeminiResponseValidationDiagnostics,
        repairContext?: Readonly<{ candidate: unknown; issues: readonly ZodIssue[] }>,
    ) {
        super(message);
        this.name = 'GeminiResponseValidationError';
        if (repairContext) {
            Object.defineProperty(this, 'repairContext', {
                value: repairContext,
                enumerable: false,
            });
        }
    }
}

function schemaIssuePath(issue: ZodIssue): string {
    if (issue.path.length === 0) return '$';
    return issue.path.map(segment => {
        if (typeof segment === 'number') return '#';
        if (
            typeof segment === 'string'
            && SAFE_SCHEMA_PATH_SEGMENTS.has(segment)
        ) {
            return segment;
        }
        return '?';
    }).join('.');
}

function schemaDiagnostics(issues: readonly ZodIssue[]): GeminiResponseValidationDiagnostics {
    const bounded = issues.slice(0, MAX_RESPONSE_VALIDATION_ISSUES);
    return {
        category: 'schema_validation',
        issues: bounded.map(issue => ({
            path: schemaIssuePath(issue),
            code: issue.code,
        })),
        truncated: issues.length > bounded.length,
    };
}

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
            throw new GeminiResponseValidationError(
                'Gemini response did not contain a JSON object',
                {
                    category: 'missing_json_object',
                    issues: [],
                    truncated: false,
                }
            );
        }
        try {
            return JSON.parse(candidate.slice(start, end + 1)) as unknown;
        } catch {
            throw new GeminiResponseValidationError(
                'Gemini response contained invalid JSON',
                {
                    category: 'invalid_json',
                    issues: [],
                    truncated: false,
                }
            );
        }
    }
}

export function parseGeminiJsonResponse<T>(text: string, schema: ZodType<T>): T {
    const parsedJson = extractJsonObject(text);
    const parsed = schema.safeParse(parsedJson);
    if (!parsed.success) {
        throw new GeminiResponseValidationError(
            'Gemini response did not match the required analysis schema',
            schemaDiagnostics(parsed.error.issues),
            { candidate: parsedJson, issues: parsed.error.issues },
        );
    }
    return parsed.data;
}
