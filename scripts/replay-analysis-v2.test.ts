import { describe, expect, it } from 'vitest';
import { parseReplayCliArgs } from './replay-analysis-v2';

describe('analysis V2 replay CLI', () => {
    it('only allows explicit local dry-run validation arguments', () => {
        expect(parseReplayCliArgs(['--bundle=/private/bundle.enc', '--key=/private/key.key', '--dry-run=']))
            .toEqual({ bundlePath: '/private/bundle.enc', keyPath: '/private/key.key', dryRun: true });
        expect(() => parseReplayCliArgs(['--paid-ai', '--bundle=a.enc', '--key=a.key'])).toThrow('ANALYSIS_V2_REPLAY_CLI_USAGE');
    });
});
