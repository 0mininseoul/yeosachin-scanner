import { NextResponse } from 'next/server';

export function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const reviewQuery = new URLSearchParams();
    if (searchParams.get('product') === 'cherry') reviewQuery.set('product', 'cherry');
    const authorized = searchParams.get('result') === 'authorized';
    reviewQuery.set('result', authorized ? 'authorized' : 'failed');

    // The review only opens the sandbox window. Discard all provider tokens.
    return new NextResponse(null, {
        status: 303,
        headers: {
            Location: `/login/pg-review?${reviewQuery}`,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
        },
    });
}
