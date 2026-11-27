import { NextResponse } from 'next/server';
import { CHERRY_REVIEW_CHECKOUT_PATH } from '@/lib/constants/cherry-public-url';

export function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const result = searchParams.get('result') === 'authorized' ? 'authorized' : 'failed';

    return new NextResponse(null, {
        status: 303,
        headers: {
            Location: `${CHERRY_REVIEW_CHECKOUT_PATH}?result=${result}`,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
        },
    });
}
