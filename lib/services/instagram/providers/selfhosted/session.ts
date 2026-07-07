/**
 * 팔로워/팔로잉 자체 수집(2단계)용 인스타 계정 세션 관리.
 * 세션은 env로 주입한다. 계정은 주기적으로 밴될 수 있어 여러 개를 넣고 로테이션한다.
 *
 * env 형식(둘 다 지원, 병합됨):
 *  - IG_SESSIONS: JSON 배열 `[{"sessionId":"..","csrfToken":"..","userId":".."}]`
 *  - 단일 세션: IG_SESSION_ID + IG_CSRF_TOKEN + IG_DS_USER_ID
 * (userId = 스크래퍼 계정 자신의 ds_user_id)
 */
export interface IgSession {
    sessionId: string;
    csrfToken: string;
    userId: string;
}

function isValid(s: unknown): s is IgSession {
    if (!s || typeof s !== 'object') return false;
    const r = s as Record<string, unknown>;
    return (
        typeof r.sessionId === 'string' && r.sessionId.length > 0 &&
        typeof r.csrfToken === 'string' && r.csrfToken.length > 0 &&
        typeof r.userId === 'string' && r.userId.length > 0
    );
}

export function parseSessions(
    env: Record<string, string | undefined> = process.env
): IgSession[] {
    const sessions: IgSession[] = [];

    if (env.IG_SESSIONS) {
        try {
            const arr = JSON.parse(env.IG_SESSIONS);
            if (Array.isArray(arr)) {
                for (const s of arr) {
                    if (isValid(s)) {
                        sessions.push({ sessionId: s.sessionId, csrfToken: s.csrfToken, userId: s.userId });
                    }
                }
            }
        } catch {
            // 잘못된 JSON은 무시
        }
    }

    if (env.IG_SESSION_ID && env.IG_CSRF_TOKEN && env.IG_DS_USER_ID) {
        sessions.push({
            sessionId: env.IG_SESSION_ID,
            csrfToken: env.IG_CSRF_TOKEN,
            userId: env.IG_DS_USER_ID,
        });
    }

    return sessions;
}

let rotationIndex = 0;

/** 라운드로빈으로 세션 하나를 고른다. 비어있으면 null. */
export function pickSession(sessions: IgSession[]): IgSession | null {
    if (sessions.length === 0) return null;
    const session = sessions[rotationIndex % sessions.length];
    rotationIndex = (rotationIndex + 1) % sessions.length;
    return session;
}

/** @deprecated parseSessions를 사용하라. 하위 호환용. */
export function getSessionPool(env: Record<string, string | undefined> = process.env): IgSession[] {
    return parseSessions(env);
}
