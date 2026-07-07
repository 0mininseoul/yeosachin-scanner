/**
 * [2단계 스캐폴드] 팔로워/팔로잉 자체 수집용 인스타 계정 세션 관리.
 * 계정 풀 + 세션 쿠키 로테이션이 여기에 구현될 예정. 현재는 미구현.
 */
export interface IgSession {
    sessionId: string;
    csrfToken: string;
    userId: string;
}

export function getSessionPool(): IgSession[] {
    return [];
}
