'use client';

import { createContext, useActionState, useContext, useId, useState, type ReactNode } from 'react';
import { signInForPgReview } from '@/app/login/pg-review/actions';
import { PrimaryButton } from './case-ui';

const EmailLoginContext = createContext(false);
const inputClass = 'mt-1.5 min-h-11 w-full border border-line bg-ink px-3 text-sm text-fg';

export function EmailLoginAvailability({ enabled, children }: { enabled: boolean; children: ReactNode }) {
    return <EmailLoginContext.Provider value={enabled}>{children}</EmailLoginContext.Provider>;
}

export function EmailLogin() {
    const enabled = useContext(EmailLoginContext);
    const [expanded, setExpanded] = useState(false);
    const formId = useId();
    const [error, signIn, pending] = useActionState(
        (_previous: string | null, form: FormData) => signInForPgReview(form),
        null,
    );

    if (!enabled) return null;

    return (
        <div className="mt-2.5">
            <button
                type="button"
                aria-expanded={expanded}
                aria-controls={formId}
                disabled={pending}
                onClick={() => setExpanded(!expanded)}
                className="min-h-12 w-full border border-line bg-ink px-4 py-3.5 text-sm font-bold text-fg transition-colors hover:border-fg-dim"
            >
                이메일로 로그인
            </button>
            <form id={formId} action={signIn} hidden={!expanded} data-amp-mask className="mt-4 space-y-3">
                <label className="block text-sm text-fg">
                    이메일
                    <input name="email" type="email" autoComplete="username" maxLength={254}
                        required className={inputClass} />
                </label>
                <label className="block text-sm text-fg">
                    비밀번호
                    <input name="password" type="password" autoComplete="current-password" maxLength={256}
                        required className={inputClass} />
                </label>
                {error && <p role="alert" className="text-sm text-blood">{error}</p>}
                <PrimaryButton type="submit" disabled={pending}>
                    {pending ? '로그인 중…' : '로그인'}
                </PrimaryButton>
            </form>
        </div>
    );
}
