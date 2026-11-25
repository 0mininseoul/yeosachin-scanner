'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
    createPgReviewSession, matchesPgReviewPassword, pgReviewCredential,
    PG_REVIEW_COOKIE, PG_REVIEW_EMAIL, PG_REVIEW_PATH, PG_REVIEW_SESSION_SECONDS,
} from './account';

const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: PG_REVIEW_PATH,
} as const;

export async function signInForPgReview(form: FormData): Promise<string> {
    const credential = pgReviewCredential();
    if (!credential) return '현재 이메일 로그인을 사용할 수 없습니다.';

    const email = form.get('email');
    const password = form.get('password');
    if (typeof email !== 'string' || email.trim().toLowerCase() !== PG_REVIEW_EMAIL
        || typeof password !== 'string' || password.length === 0 || password.length > 256
        || !matchesPgReviewPassword(password, credential.passwordHash)) {
        return '이메일과 비밀번호를 확인해 주세요.';
    }

    const cookieStore = await cookies();
    cookieStore.set(PG_REVIEW_COOKIE, createPgReviewSession(credential.sessionKey), {
        ...cookieOptions,
        maxAge: PG_REVIEW_SESSION_SECONDS,
    });
    redirect(PG_REVIEW_PATH);
}

export async function signOutFromPgReview() {
    const cookieStore = await cookies();
    cookieStore.set(PG_REVIEW_COOKIE, '', { ...cookieOptions, maxAge: 0 });
    redirect('/login');
}
