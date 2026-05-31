import { EmailTemplate } from '@/components/email-template';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST() {
    const emailContent = <EmailTemplate firstName="User" />;

    try {
        const { data, error } = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'Acme <onboarding@resend.dev>',
            to: ['delivered@resend.dev'], // For testing, or replace with dynamic logic
            subject: 'Hello world',
            react: emailContent,
        });

        if (error) {
            return Response.json({ error }, { status: 500 });
        }

        return Response.json(data);
    } catch (error) {
        return Response.json(
            { error: error instanceof Error ? error.message : 'Internal Error' },
            { status: 500 }
        );
    }
}
