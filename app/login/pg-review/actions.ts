'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { CHERRY_REVIEW_CHECKOUT_PATH } from '@/lib/constants/cherry-public-url';
import {
    createPgReviewSession, matchesPgReviewPassword, pgReviewCredential,
    PG_REVIEW_COOKIE, PG_REVIEW_EMAIL, PG_REVIEW_PATH, PG_REVIEW_SESSION_SECONDS,
} from './account';

const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
} as const;

async function signIn(form: FormData, path: string): Promise<string> {
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
        path,
        maxAge: PG_REVIEW_SESSION_SECONDS,
    });
    redirect(path);
}

export async function signInForPgReview(form: FormData) {
    return signIn(form, PG_REVIEW_PATH);
}

export async function signInForCherryReview(form: FormData) {
    return signIn(form, CHERRY_REVIEW_CHECKOUT_PATH);
}

async function signOut(path: string, destination: string) {
    const cookieStore = await cookies();
    cookieStore.set(PG_REVIEW_COOKIE, '', { ...cookieOptions, path, maxAge: 0 });
    redirect(destination);
}

export async function signOutFromPgReview() {
    await signOut(PG_REVIEW_PATH, '/login');
}

export async function signOutFromCherryReview() {
    await signOut(CHERRY_REVIEW_CHECKOUT_PATH, CHERRY_REVIEW_CHECKOUT_PATH);
}
