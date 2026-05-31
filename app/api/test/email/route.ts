import { NextResponse } from 'next/server';
import { sendEmail } from '@/lib/services/email';

export async function GET() {
    try {
        const result = await sendEmail({
            to: 'ym5373@gachon.ac.kr',
            subject: 'Baram Detector Test Email',
            html: '<h1>It Works!</h1><p>Resend integration is successfully configured.</p>',
        });

        if (result) {
            return NextResponse.json({ success: true, data: result });
        } else {
            return NextResponse.json({ success: false, error: 'Failed to send email' }, { status: 500 });
        }
    } catch (error) {
        console.error('Test email failed:', error);
        return NextResponse.json({ success: false, error: 'Internal Error' }, { status: 500 });
    }
}
