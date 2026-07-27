'use client';

import { useEffect } from 'react';
import { captureExceptionSafely } from '@/lib/observability/sentry-capture';

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
    useEffect(() => {
        captureExceptionSafely(error);
    }, [error]);

    return (
        <html lang="ko">
            <body>
                <main>
                    <h1>문제가 발생했습니다.</h1>
                    <p>잠시 후 다시 시도해 주세요.</p>
                </main>
            </body>
        </html>
    );
}
