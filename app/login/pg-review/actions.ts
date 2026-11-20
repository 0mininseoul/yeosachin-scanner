'use server';

import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import {
    createPgReviewSession, matchesPgReviewPassword, pgReviewCredential,
    PG_REVIEW_COOKIE, PG_REVIEW_EMAIL, PG_REVIEW_PATH, PG_REVIEW_SESSION_SECONDS,
} from './account';

const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: PG_REVIEW_PATH,
} as const;

export async function signInForPgReview(form: FormData) {
    const credential = pgReviewCredential();
    if (!credential) notFound();

    const email = form.get('email');
    const password = form.get('password');
    if (typeof email !== 'string' || email.trim().toLowerCase() !== PG_REVIEW_EMAIL
        || typeof password !== 'string' || password.length === 0 || password.length > 256
        || !matchesPgReviewPassword(password, credential.passwordHash)) {
        redirect(`${PG_REVIEW_PATH}?error=1`);
    }

    const cookieStore = await cookies();
    cookieStore.set(PG_REVIEW_COOKIE, createPgReviewSession(credential.sessionKey), {
        ...cookieOptions,
        maxAge: PG_REVIEW_SESSION_SECONDS,
    });
    redirect(PG_REVIEW_PATH);
}

export async function signOutFromPgReview() {
    if (!pgReviewCredential()) notFound();

    const cookieStore = await cookies();
    cookieStore.set(PG_REVIEW_COOKIE, '', { ...cookieOptions, maxAge: 0 });
    redirect(PG_REVIEW_PATH);
}
