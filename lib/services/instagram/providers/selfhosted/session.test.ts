import { describe, it, expect } from 'vitest';
import { parseSessions, pickSession } from './session';

describe('parseSessions', () => {
    it('IG_SESSIONS JSON 배열을 파싱한다', () => {
        const env = {
            IG_SESSIONS: JSON.stringify([
                { sessionId: 's1', csrfToken: 'c1', userId: 'u1' },
                { sessionId: 's2', csrfToken: 'c2', userId: 'u2' },
            ]),
        };
        expect(parseSessions(env)).toHaveLength(2);
    });

    it('단일 세션 env를 파싱한다', () => {
        const env = { IG_SESSION_ID: 's', IG_CSRF_TOKEN: 'c', IG_DS_USER_ID: 'u' };
        expect(parseSessions(env)).toEqual([{ sessionId: 's', csrfToken: 'c', userId: 'u' }]);
    });

    it('JSON 배열 + 단일 세션을 병합한다', () => {
        const env = {
            IG_SESSIONS: JSON.stringify([{ sessionId: 's1', csrfToken: 'c1', userId: 'u1' }]),
            IG_SESSION_ID: 's2',
            IG_CSRF_TOKEN: 'c2',
            IG_DS_USER_ID: 'u2',
        };
        expect(parseSessions(env)).toHaveLength(2);
    });

    it('필드 누락 항목과 잘못된 JSON은 건너뛴다', () => {
        expect(parseSessions({ IG_SESSIONS: '{bad json' })).toEqual([]);
        expect(parseSessions({ IG_SESSIONS: JSON.stringify([{ sessionId: 's' }]) })).toEqual([]);
    });

    it('아무 env도 없으면 빈 배열', () => {
        expect(parseSessions({})).toEqual([]);
    });
});

describe('pickSession', () => {
    it('라운드로빈으로 순환한다', () => {
        const sessions = [
            { sessionId: 'a', csrfToken: 'c', userId: 'u' },
            { sessionId: 'b', csrfToken: 'c', userId: 'u' },
        ];
        const picks = [pickSession(sessions), pickSession(sessions), pickSession(sessions)];
        expect(picks.map((p) => p!.sessionId)).toContain('a');
        expect(picks.map((p) => p!.sessionId)).toContain('b');
    });

    it('빈 배열이면 null', () => {
        expect(pickSession([])).toBeNull();
    });
});
