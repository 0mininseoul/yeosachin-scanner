import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
    evaluateVertexAiCostGate,
    type VertexAiCostGateFixture,
} from '@/lib/services/ai/vertex-ai-cost-gate';

const defaultFixturePath = resolve(
    process.cwd(),
    'reports/vertex-ai-cost-optimization-fixture.json',
);

function fixturePath(argv: readonly string[]): string {
    const argument = argv.find(value => value.startsWith('--fixture='));
    return argument ? resolve(process.cwd(), argument.slice('--fixture='.length)) : defaultFixturePath;
}

function main(): void {
    const path = fixturePath(process.argv.slice(2));
    let fixture: VertexAiCostGateFixture;
    try {
        fixture = JSON.parse(readFileSync(path, 'utf8')) as VertexAiCostGateFixture;
    } catch (error) {
        console.error(`Unable to read cost gate fixture: ${path}`);
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        return;
    }

    const result = evaluateVertexAiCostGate(fixture);
    console.log(JSON.stringify({ fixture: path, ...result }, null, 2));
    if (!result.passed) process.exitCode = 1;
}

main();
