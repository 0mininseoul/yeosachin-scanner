import { expect, it } from 'vitest';
import { describePrivate90Failure } from './private90-worker-failure.mjs';
import { newPrivate90Observations, safePrivate90Observations } from './private90-observations.mjs';

it('reports only allowlisted source frames, including with multiline errors and unknown keys', () => {
    const error = new TypeError('example-private-field\n    at f (/lib/services/ai/gemini.ts:999:1)');
    error.stack = error.name + ': ' + error.message + '\n' + [
        '    at run (/some/unknown.ts:123:1)',
        '    at prepare (/app/lib/services/analysis/v2-ai-scoring-executors.ts:1201:10)',
        '    at async /app/lib/services/analysis/v2-worker.ts:735:1',
    ].join('\n');
    const observed = { ...newPrivate90Observations(), ...describePrivate90Failure(error) };
    expect(safePrivate90Observations(observed)).toMatchObject({ errorClass:'TypeError', sourceReason:'other',
        sourceModule:'v2-ai-scoring-executors', sourceLine:1201, callerModule:'v2-worker', callerLine:735 });
    expect(JSON.stringify(observed)).not.toContain('example-private-field');
    expect(safePrivate90Observations({ ...observed, sourceModule:'example-private-field' })).toBeNull();
    expect(describePrivate90Failure({name:'ZodError',issues:[{code:'invalid_type',path:['example-private-field',3,'gender']}]}))
        .toMatchObject({ errorClass:'ZodError', issueCode:'invalid_type', issueField:'gender' });
});
