import { describe, expect, it } from 'vitest';
import { parseReplayCliArgs } from './replay-analysis-v2';

describe('analysis V2 replay CLI', () => {
    it('parses an exact capture selector and artifact paths', () => {
        expect(parseReplayCliArgs([
            '--capture', '--target=target', '--request-id=10000000-0000-4000-8000-000000000001',
            '--bundle=/private/bundle.enc', '--key=/private/key.key',
        ])).toEqual({
            command: 'capture', target: 'target',
            requestId: '10000000-0000-4000-8000-000000000001',
            bundlePath: '/private/bundle.enc', keyPath: '/private/key.key',
        });
    });

    it('defaults run to dry-run and requires both paid-AI confirmations', () => {
        expect(parseReplayCliArgs(['--run', '--bundle=/private/bundle.enc', '--key=/private/key.key']))
            .toEqual({ command: 'run', mode: 'dry-run', bundlePath: '/private/bundle.enc', keyPath: '/private/key.key' });
        expect(() => parseReplayCliArgs(['--run', '--paid-ai', '--bundle=a.enc', '--key=a.key']))
            .toThrow('ANALYSIS_V2_REPLAY_PAID_AI_DOUBLE_CONFIRM_REQUIRED');
        expect(parseReplayCliArgs(['--run', '--paid-ai', '--confirm-paid-ai', '--bundle=a.enc', '--key=a.key']))
            .toEqual({ command: 'run', mode: 'paid-ai', bundlePath: 'a.enc', keyPath: 'a.key' });
    });

    it('exposes exact artifact cleanup without directory arguments', () => {
        expect(parseReplayCliArgs(['--cleanup', '--bundle=a.enc', '--key=a.key']))
            .toEqual({ command: 'cleanup', bundlePath: 'a.enc', keyPath: 'a.key' });
        expect(() => parseReplayCliArgs(['--cleanup', '--bundle=a.enc', '--key=a.key', '--directory=/tmp']))
            .toThrow('ANALYSIS_V2_REPLAY_CLI_USAGE');
    });
});
