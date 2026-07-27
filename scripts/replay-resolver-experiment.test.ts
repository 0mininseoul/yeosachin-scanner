import { describe, expect, it } from 'vitest';
import { parseResolverExperimentCliArgs } from './replay-resolver-experiment';

const common = [
    '--resolver-experiment=strong-uncertain-v1',
    '--confirm-resolver-experiment',
    '--bundle=/tmp/analysis-v2-replay-child.enc',
    '--key=/tmp/analysis-v2-replay-child.key',
];

describe('resolver experiment CLI admission', () => {
    it('requires separate experiment confirmation for derivation', () => {
        expect(parseResolverExperimentCliArgs([
            '--derive', ...common,
            '--parent-bundle=/tmp/analysis-v2-replay-parent.enc',
            '--parent-key=/tmp/analysis-v2-replay-parent.key',
        ])).toMatchObject({ command: 'derive' });
        expect(() => parseResolverExperimentCliArgs([
            '--derive', ...common.filter(flag => flag !== '--confirm-resolver-experiment'),
            '--parent-bundle=x', '--parent-key=y',
        ])).toThrow('ANALYSIS_V2_RESOLVER_EXPERIMENT_CONFIRMATION_REQUIRED');
    });

    it('requires both paid-AI opt-ins for execution', () => {
        expect(parseResolverExperimentCliArgs([
            '--run', ...common, '--paid-ai', '--confirm-paid-ai',
        ])).toMatchObject({ command: 'run' });
        expect(() => parseResolverExperimentCliArgs([
            '--run', ...common, '--paid-ai',
        ])).toThrow('ANALYSIS_V2_RESOLVER_EXPERIMENT_PAID_CONFIRMATION_REQUIRED');
    });

    it('rejects the wrong experiment id', () => {
        expect(() => parseResolverExperimentCliArgs([
            '--run',
            ...common.filter(flag => !flag.startsWith('--resolver-experiment=')),
            '--resolver-experiment=other',
            '--paid-ai',
            '--confirm-paid-ai',
        ])).toThrow('ANALYSIS_V2_RESOLVER_EXPERIMENT_CONFIRMATION_REQUIRED');
    });
});
