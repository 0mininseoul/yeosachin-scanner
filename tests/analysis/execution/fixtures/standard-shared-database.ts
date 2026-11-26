import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { sharedStandardCapacity } from './standard-shared-capacities.mjs';
import {
    installStandardFixtureSchema, localDatabaseClient, type StandardConnection, type StandardDatabase,
} from './standard-database';

function connection(database: Pool | PoolClient): StandardConnection {
    return {
        async query<Row extends Record<string, unknown>>(sql: string, values?: unknown[]) {
            const { rows } = await database.query<Row>(sql, values);
            return { rows };
        },
        async exec(sql: string) {
            await database.query(sql);
        },
    };
}

// No connection string or archive input is accepted. Concurrent requests share
// one fresh cluster, its actual Dev fences, eight Vertex leases and provider budgets.
export async function createSharedStandardDatabase(
    preset: string | number = 8,
    schemaOptions?: Parameters<typeof installStandardFixtureSchema>[1],
) {
    const { slots, features, resolvers } = sharedStandardCapacity(preset);
    const env = { PATH: process.env.PATH, LC_ALL: 'C', NODE_ENV: 'test' as const };
    if (!/^postgres \(PostgreSQL\) 17\./.test(execFileSync('postgres', ['--version'], { env, encoding: 'utf8' }))) {
        throw new Error('Shared Standard fixture requires PostgreSQL 17 on PATH');
    }
    const directory = mkdtempSync('/tmp/ys-standard-');
    const cluster = join(directory, 'data');
    const pool = new Pool({
        host: cluster, port: 5432, database: 'postgres', user: 'postgres', ssl: false, max: 64,
        options: '-c search_path=public,extensions -c timezone=UTC',
    });
    let started = false;
    async function close() {
        await pool.end();
        if (started) {
            execFileSync('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop'], { env, stdio: 'ignore' });
        }
        rmSync(directory, { recursive: true, force: true });
    }
    try {
        execFileSync('initdb', ['-D', cluster, '-U', 'postgres', '--auth-local=trust', '--auth-host=reject',
            '--no-locale', '--encoding=UTF8'], { env, stdio: 'ignore' });
        execFileSync('pg_ctl', ['-D', cluster, '-l', '/dev/null', '-o',
            "-c listen_addresses='' -c unix_socket_directories=. -c unix_socket_permissions=0700 -c min_wal_size=32MB -c max_wal_size=96MB -p 5432",
            '-w', 'start'], { env, stdio: 'ignore' });
        started = true;
        const installer = await pool.connect();
        try {
            const { rows } = await installer.query<{ local: boolean }>(`SELECT
                current_setting('server_version_num')::int BETWEEN 170000 AND 179999
                AND current_setting('listen_addresses') = '' AND inet_server_addr() IS NULL AS local`);
            if (!rows[0]?.local) throw new Error('Shared Standard fixture requires local PostgreSQL 17');
            await installStandardFixtureSchema(connection(installer), schemaOptions);
            if (slots !== 8) {
                await installer.query(`SELECT set_config('standard_shared.vertex_slots', $1, false),
                    set_config('standard_shared.feature_slots', $2, false),
                    set_config('standard_shared.resolver_slots', $3, false)`, [String(slots), String(features), String(resolvers)]);
                const sql = readFileSync(new URL('./standard-shared-database-capacity.sql', import.meta.url), 'utf8');
                await installer.query(sql);
            }
        } finally {
            installer.release(true);
        }
    } catch (error) {
        await close();
        throw error;
    }
    const db: StandardDatabase = {
        ...connection(pool),
        async transaction<T>(operation: (tx: StandardConnection) => Promise<T>): Promise<T> {
            const client = await pool.connect();
            let discard = false;
            try {
                await client.query('BEGIN');
                const result = await operation(connection(client));
                await client.query('COMMIT');
                return result;
            } catch (error) {
                try {
                    await client.query('ROLLBACK');
                } catch {
                    discard = true;
                }
                throw error;
            } finally {
                client.release(discard);
            }
        },
        close,
    };
    return { ...db, client: (subject?: string | null) => localDatabaseClient(db, subject) };
}
