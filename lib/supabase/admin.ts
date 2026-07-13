import { createClient } from '@supabase/supabase-js';

function requiredEnvironmentVariable(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} is not configured`);
    }
    return value;
}

function createSupabaseAdminClient() {
    return createClient(
        requiredEnvironmentVariable('NEXT_PUBLIC_SUPABASE_URL'),
        requiredEnvironmentVariable('SUPABASE_SERVICE_ROLE_KEY'),
        {
            auth: {
                autoRefreshToken: false,
                persistSession: false,
            },
        }
    );
}

type SupabaseAdminClient = ReturnType<typeof createSupabaseAdminClient>;

let client: SupabaseAdminClient | undefined;

function getSupabaseAdminClient(): SupabaseAdminClient {
    if (client) return client;

    client = createSupabaseAdminClient();
    return client;
}

// Keep the existing client-shaped export while deferring env validation until runtime use.
export const supabaseAdmin = new Proxy({} as SupabaseAdminClient, {
    get(_target, property) {
        const resolvedClient = getSupabaseAdminClient();
        const value = Reflect.get(resolvedClient, property, resolvedClient);
        return typeof value === 'function' ? value.bind(resolvedClient) : value;
    },
});
