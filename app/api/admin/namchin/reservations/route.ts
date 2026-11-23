import { z } from 'zod';
import { privateJson, requireConsoleOperator } from '@/lib/services/admin/operator-route';
import { supabaseAdmin } from '@/lib/supabase/admin';

const pageSize = 100;
const requestSchema = z.object({
    query: z.string().trim().max(254).default(''),
    page: z.number().int().min(1).max(100_000).default(1),
}).strict();

export async function POST(request: Request) {
    if (request.headers.get('origin') !== new URL(request.url).origin) return privateJson({ error: 'origin' }, 403);
    const operator = await requireConsoleOperator();
    if (!operator.ok) return operator.response;

    const parsed = requestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return privateJson({ error: 'invalid_request' }, 400);
    const { query, page } = parsed.data;
    const start = (page - 1) * pageSize;

    try {
        const listPage = (columns: string) => {
            let list = supabaseAdmin.from('namchin_launch_reservations').select(columns, { count: 'exact' });
            const digits = /^[+\d\s()-]+$/.test(query) ? query.replace(/\D/g, '') : '';
            if (digits) {
                const phone = digits.startsWith('010') ? `82${digits.slice(1)}` : digits;
                list = list.or(`phone.like.%${phone}%,email.ilike.%${digits}%`);
            } else if (query) {
                const literal = query.replace(/[\\%_]/g, '\\$&');
                list = list.ilike('email', `%${literal}%`);
            }
            return list.order('consented_at', { ascending: false }).order('email').range(start, start + pageSize - 1);
        };
        // Whole-table totals per Meta A/B arm, independent of the search filter.
        const arm = () => supabaseAdmin.from('namchin_launch_reservations').select('email', { count: 'exact', head: true });
        const [withVariant, bf, crush, none] = await Promise.all([
            listPage('email, phone, consented_at, variant'),
            arm().eq('variant', 'bf'),
            arm().eq('variant', 'crush'),
            arm().is('variant', null),
        ]);
        // Until the variant migration is applied, keep the roster working without the A/B columns.
        const { data, error, count } = withVariant.error?.code === '42703'
            ? await listPage('email, phone, consented_at')
            : withVariant;
        if (!error && data && count !== null) {
            const rows = data as unknown as { email: string; phone: string; consented_at: string; variant?: 'bf' | 'crush' | null }[];
            return privateJson({
                rows: rows.map(({ email, phone, consented_at, variant }) => ({ email, phone, consentedAt: consented_at, variant: variant ?? null })),
                count,
                hasNext: start + pageSize < count,
                variantCounts: bf.error || crush.error || none.error
                    ? null
                    : { bf: bf.count ?? 0, crush: crush.count ?? 0, none: none.count ?? 0 },
            });
        }
    } catch {
        // Contact details aren't included in error responses or server logs.
    }
    return privateJson({ error: 'unavailable' }, 503);
}
