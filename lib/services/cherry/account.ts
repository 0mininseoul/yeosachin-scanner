import { forgetCherryBillingKey } from './billing';
import { deleteCherryImages } from './images';
import { CherryDatabaseError, cherryRpc } from './rpc';

/** PostgREST's answer before the Cherry schema exists; there is nothing to remove then. */
const FUNCTION_NOT_FOUND = 'PGRST202';

/** Removes a leaving member's Cherry data. Images go first so no key outlives its record. */
export async function purgeCherryAccount(userId: string): Promise<void> {
    let keys: string[];
    try {
        keys = await cherryRpc<string[]>('cherry_account_image_keys', { p_user: userId });
    } catch (error) {
        if (error instanceof CherryDatabaseError && error.databaseCode === FUNCTION_NOT_FOUND) return;
        throw error;
    }
    await deleteCherryImages(keys);
    await forgetCherryBillingKey(userId);
    await cherryRpc('cherry_purge_account', { p_user: userId });
}
