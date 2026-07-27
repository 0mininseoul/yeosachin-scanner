import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const forbidden = [
    '/supabase/', 'supabase/admin', 'private-name', 'feature-analysis',
    'v2-ai-result-store', '/apify', '/r2-', 'result-image',
];

function resolveImport(from: string, specifier: string): string | null {
    const base = specifier.startsWith('@/')
        ? join(root, specifier.slice(2))
        : specifier.startsWith('.') ? resolve(dirname(from), specifier) : '';
    if (!base) return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

function staticGraph(entry: string): string[] {
    const seen = new Set<string>();
    const visit = (file: string) => {
        if (seen.has(file)) return;
        seen.add(file);
        const source = readFileSync(file, 'utf8');
        const imports = source.matchAll(
            /^import(?!\s+type\b)[\s\S]*?\sfrom\s+['"]([^'"]+)['"];?$/gm,
        );
        for (const match of imports) {
            const child = resolveImport(file, match[1]!);
            if (child) visit(child);
        }
    };
    visit(entry);
    return [...seen].map(file => file.slice(root.length));
}

describe('resolver experiment static execution boundary', () => {
    it('has no static production data/provider/result-store edge', () => {
        const graph = staticGraph(join(root, 'scripts/replay-resolver-experiment.ts'));
        expect(graph.filter(file => forbidden.some(pattern => file.includes(pattern))))
            .toEqual([]);
        expect(graph).not.toContain(
            '/lib/services/analysis/replay/replay-staged-ai-adapter.ts',
        );
    });

    it('has no exported experiment capability issuer', () => {
        const sources = staticGraph(join(root, 'scripts/replay-resolver-experiment.ts'))
            .map(file => readFileSync(join(root, file), 'utf8')).join('\n');
        expect(sources).not.toMatch(/export\s+(?:function|const)\s+issueResolverExperimentCapability/);
        const productionApi = readFileSync(
            join(root, 'lib/services/ai/v2-staged-analysis.ts'),
            'utf8',
        );
        expect(productionApi).not.toContain('experimentPolicy');
        expect(productionApi).not.toContain('resolverExperimentCapability');
        const generation = readFileSync(
            join(root, 'lib/services/ai/gender-resolution-generation.ts'),
            'utf8',
        );
        expect(generation).toContain("model: 'gemini-3-flash-preview'");
        expect(generation).toContain("thinkingLevel: 'HIGH'");
        expect(generation).toContain("mediaResolution: 'HIGH'");
        expect(generation).toContain('maxOutputTokens: 512');
    });

    it('is not imported by app or non-replay production modules', () => {
        const offenders: string[] = [];
        const walk = (directory: string) => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const path = join(directory, entry.name);
                if (entry.isDirectory()) walk(path);
                else if (
                    /\.(?:ts|tsx)$/.test(entry.name)
                    && !entry.name.endsWith('.test.ts')
                    && readFileSync(path, 'utf8').includes('resolver-experiment-ai-adapter')
                    && !path.includes('/services/analysis/replay/')
                ) offenders.push(path.slice(root.length));
            }
        };
        walk(join(root, 'app'));
        walk(join(root, 'lib'));
        expect(offenders).toEqual([]);
    });
});
