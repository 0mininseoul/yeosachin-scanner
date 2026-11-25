// The private Vitest resolver binds both eager and late service-role imports to this in-process client.
type Admin = { rpc: (...args: unknown[]) => unknown; from: (...args: unknown[]) => unknown };
let local: Admin | undefined;
export function bindPrivate90Admin(client: Admin) { local = client; }
function client() {
    if (!local) throw new Error('PRIVATE90_LOCAL_DATABASE_UNBOUND');
    return local;
}
export const supabaseAdmin: Admin = {
    rpc: (...args) => client().rpc(...args),
    from: (...args) => client().from(...args),
};
