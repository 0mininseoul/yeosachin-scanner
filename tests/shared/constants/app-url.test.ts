import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Script } from 'node:vm';
import ts from 'typescript';
import { getDefineEnv } from 'next/dist/build/define-env';
import { defaultConfig, type NextConfigComplete } from 'next/dist/server/config-shared';

const registry = vi.hoisted(() => ({
    version: 1,
    deployments: [{ vercelProjectId: 'prj_dev_ui_test', supabaseProjectRef: 'devuitestproject' }],
}));
vi.mock('@/config/dev-ui-deployment.json', () => ({ default: registry }));

import {
    appOriginForRequest,
    appRedirectUrlForRequest,
    appOriginForServer,
    CANONICAL_APP_ORIGIN,
} from '../../../lib/constants/app-url';

interface VerificationCompiler {
    hooks: { shouldEmit: { tap(name: string, callback: () => boolean): void } };
    run(callback: (error: Error | null, stats?: {
        hasErrors(): boolean;
        compilation: { getAsset(name: string): { source: { source(): string | Buffer } } | undefined };
    }) => void): void;
    close(callback: (error?: Error | null) => void): void;
}

async function compileServerDeployment(buildEnvironment: Record<string, string>): Promise<string> {
    const previousEnvironment = process.env;
    let definitions: Record<string, string>;
    try {
        // Next's public-env collector sees only synthetic values in this test.
        process.env = { ...buildEnvironment, NODE_ENV: 'production' };
        definitions = getDefineEnv({
            config: defaultConfig as unknown as NextConfigComplete,
            isTurbopack: false, isClient: false, isEdgeServer: false, isNodeServer: true,
            dev: false, distDir: '.next', projectPath: process.cwd(), fetchCacheKeyPrefix: undefined,
            hasRewrites: false, middlewareMatchers: undefined,
            rewrites: { beforeFiles: [], afterFiles: [], fallback: [] },
        });
    } finally {
        process.env = previousEnvironment;
    }
    const sourceModules = {
        marker: '../../../lib/constants/dev-ui.ts',
        deployment: '../../../lib/services/dev-ui/deployment.ts',
        origin: '../../../lib/constants/app-url.ts',
        admin: '../../../lib/supabase/admin.ts',
    };
    const moduleFactories = Object.entries(sourceModules).map(([name, relativePath]) => {
        const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        }).outputText;
        return `${JSON.stringify(name)}: function(module, exports, require) { ${compiled} }`;
    });
    // Compile real source modules without emitting files, loading a credential,
    // or constructing a real Supabase/provider client.
    const entry = `
        const factories = { ${moduleFactories.join(',')} };
        const modules = new Map();
        function load(name) {
            if (modules.has(name)) return modules.get(name).exports;
            const loaded = { exports: {} };
            modules.set(name, loaded);
            factories[name](loaded, loaded.exports, dependency);
            return loaded.exports;
        }
        function dependency(name) {
            if (name === 'server-only') return {};
            if (name === '../../config/dev-ui-deployment.json') return ${JSON.stringify(registry)};
            if (name === '@/lib/constants/dev-ui' || name === './dev-ui') return load('marker');
            if (name === '@supabase/supabase-js') return { createClient: __createSupabaseClient };
            throw new Error('Unexpected verification dependency');
        }
        module.exports = {
            guard: load('deployment'), origin: load('origin'),
            run(request) {
                load('deployment').assertDevUiDeployment(request);
                return load('admin').supabaseAdmin.rpc('synthetic_forbidden_processing');
            }
        };
    `;
    const require = createRequire(import.meta.url);
    const { webpack } = require('next/dist/compiled/webpack/webpack') as {
        webpack: {
            (options: Record<string, unknown>): VerificationCompiler;
            DefinePlugin: new (definitions: Record<string, string>) => unknown;
        };
    };
    const compiler = webpack({
        mode: 'production', target: 'node', cache: false, devtool: false,
        entry: `data:text/javascript,${encodeURIComponent(entry)}`,
        module: { rules: [{ mimetype: 'text/javascript', type: 'javascript/auto' }] },
        output: { path: '/dev-ui-verification-memory', filename: 'guard.cjs', library: { type: 'commonjs2' } },
        optimization: { minimize: false }, plugins: [new webpack.DefinePlugin(definitions)],
    });
    compiler.hooks.shouldEmit.tap('MemoryDeploymentVerification', () => false);
    return new Promise((resolve, reject) => {
        compiler.run((error, stats) => {
            const source = stats?.compilation.getAsset('guard.cjs')?.source.source();
            compiler.close(closeError => {
                if (error || closeError || !stats || stats.hasErrors() || !source) {
                    reject(error ?? closeError ?? new Error('Deployment verification compilation failed'));
                    return;
                }
                resolve(source.toString());
            });
        });
    });
}

describe('canonical app origin', () => {
    it('pins the production origin', () => {
        expect(CANONICAL_APP_ORIGIN).toBe('https://yeosachin.com');
        expect(appOriginForRequest('https://ai-yeosachinscanner.vercel.app/result/1'))
            .toBe(CANONICAL_APP_ORIGIN);
        expect(appOriginForRequest('https://attacker.example/result/1'))
            .toBe(CANONICAL_APP_ORIGIN);
    });

    it('preserves loopback origins for local requests', () => {
        expect(appOriginForRequest('http://localhost:3000/api/auth/signout'))
            .toBe('http://localhost:3000');
        expect(appOriginForRequest('http://127.0.0.1:3100/api/share/enable'))
            .toBe('http://127.0.0.1:3100');
    });

    it('resolves safe redirects against the canonical production origin', () => {
        expect(appRedirectUrlForRequest(
            'https://preview.example/auth/callback',
            '/result/request-1?tab=private#account'
        ).toString()).toBe(
            `${CANONICAL_APP_ORIGIN}/result/request-1?tab=private#account`
        );
    });

    it('preserves the request loopback origin for local redirects', () => {
        expect(appRedirectUrlForRequest(
            'http://127.0.0.1:3100/auth/callback',
            '/result/request-1'
        ).toString()).toBe('http://127.0.0.1:3100/result/request-1');
    });

    it('preserves an authenticated landing autostart query', () => {
        expect(appRedirectUrlForRequest(
            'http://127.0.0.1:3000/login?redirectTo=%2Fanalyze%3Fautostart%3D1',
            '/analyze?autostart=1'
        ).toString()).toBe('http://127.0.0.1:3000/analyze?autostart=1');
    });

    it.each([
        'https://attacker.example/path',
        '//attacker.example/path',
        '/\\attacker.example/path',
        '/%5cattacker.example/path',
        '/%255cattacker.example/path',
        '/%2f%2fattacker.example/path',
        '/%252f%252fattacker.example/path',
    ])('falls back for an unsafe redirect path: %s', rawPath => {
        expect(appRedirectUrlForRequest(
            'https://preview.example/auth/callback',
            rawPath
        ).toString()).toBe(`${CANONICAL_APP_ORIGIN}/analyze`);
    });

    it('uses local configuration only outside production', () => {
        expect(appOriginForServer({
            NODE_ENV: 'development',
            NEXT_PUBLIC_APP_URL: 'http://localhost:3000/path',
        })).toBe('http://localhost:3000');
        expect(appOriginForServer({
            NODE_ENV: 'production',
            NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        })).toBe(CANONICAL_APP_ORIGIN);
        expect(appOriginForServer({
            NODE_ENV: 'development',
            NEXT_PUBLIC_APP_URL: 'https://preview.example',
        })).toBe(CANONICAL_APP_ORIGIN);
    });
});

describe('registered Dev UI origins', () => {
    const devEnvironment = {
        NODE_ENV: 'production',
        DEPLOYMENT_ROLE: 'dev',
        NEXT_PUBLIC_DEPLOYMENT_ROLE: 'dev',
        VERCEL_PROJECT_ID: 'prj_dev_ui_test',
        NEXT_PUBLIC_SUPABASE_URL: 'https://devuitestproject.supabase.co',
        NEXT_PUBLIC_APP_URL: 'https://dev.yeosachin.com',
    };

    afterEach(() => {
        registry.deployments = [{ vercelProjectId: 'prj_dev_ui_test', supabaseProjectRef: 'devuitestproject' }];
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    it('rejects Dev before its immutable identity is registered', () => {
        registry.deployments = [];
        expect(() => appOriginForServer(devEnvironment)).toThrow('DEV_UI_DEPLOYMENT_REJECTED');
    });

    it('rejects a registered Dev project that lost both role markers instead of treating it as production', () => {
        expect(() => appOriginForServer({ ...devEnvironment, DEPLOYMENT_ROLE: undefined, NEXT_PUBLIC_DEPLOYMENT_ROLE: undefined }))
            .toThrow('DEV_UI_DEPLOYMENT_REJECTED');
    });

    it('keeps server links and request redirects on Dev in a production build', () => {
        expect(appOriginForServer(devEnvironment)).toBe('https://dev.yeosachin.com');
        expect(appOriginForRequest('https://dev.yeosachin.com/auth/callback', devEnvironment))
            .toBe('https://dev.yeosachin.com');
        expect(appRedirectUrlForRequest('https://dev.yeosachin.com/auth/callback', '/result/example', devEnvironment).href)
            .toBe('https://dev.yeosachin.com/result/example');
    });

    it.each([
        ['Dev build / production runtime', 'https://devuitestproject.supabase.co', 'https://productiontest.supabase.co'],
        ['production build / Dev runtime', 'https://productiontest.supabase.co', 'https://devuitestproject.supabase.co'],
    ])('rejects incompatible database targets after real Next server compilation: %s', async (_case, buildUrl, runtimeUrl) => {
        const bundle = await compileServerDeployment({ ...devEnvironment, NEXT_PUBLIC_SUPABASE_URL: buildUrl });
        const createClient = vi.fn(() => ({ rpc: vi.fn() }));
        const fetchSpy = vi.fn();
        const compiledModule = { exports: {} as {
            guard: { isDevUiDeployment(): boolean };
            origin: { appOriginForServer(): string; appOriginForRequest(url: string): string };
            run(request: { url: string; method: string }): unknown;
        } };
        new Script(bundle).runInNewContext({
            module: compiledModule, URL, fetch: fetchSpy, __createSupabaseClient: createClient,
            process: { env: { ...devEnvironment, NEXT_PUBLIC_SUPABASE_URL: runtimeUrl, SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role' } },
        });
        expect(() => compiledModule.exports.run({ url: 'https://dev.yeosachin.com/api/analysis/preflight', method: 'POST' }))
            .toThrow('DEV_UI_DEPLOYMENT_REJECTED');
        expect(compiledModule.exports.guard.isDevUiDeployment()).toBe(false);
        if (runtimeUrl !== devEnvironment.NEXT_PUBLIC_SUPABASE_URL) {
            expect(() => compiledModule.exports.origin.appOriginForServer()).toThrow('DEV_UI_DEPLOYMENT_REJECTED');
            expect(() => compiledModule.exports.origin.appOriginForRequest('https://dev.yeosachin.com/auth/callback'))
                .toThrow('DEV_UI_DEPLOYMENT_REJECTED');
        }
        expect(createClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps compiled browser presentation separate from a matching or rejected server identity', async () => {
        const bundle = await compileServerDeployment(devEnvironment);
        const createClient = vi.fn();
        const fetchSpy = vi.fn();
        type CompiledDeployment = {
            guard: { isDevUiDeployment(): boolean };
            origin: { appOriginForServer(): string; appOriginForRequest(url: string): string };
        };
        const serverModule = { exports: {} as CompiledDeployment };
        new Script(bundle).runInNewContext({
            module: serverModule, URL, fetch: fetchSpy, __createSupabaseClient: createClient,
            process: { env: { ...devEnvironment, NEXT_PUBLIC_DEPLOYMENT_ROLE: undefined } },
        });
        expect(serverModule.exports.guard.isDevUiDeployment()).toBe(true);
        expect(serverModule.exports.origin.appOriginForServer()).toBe('https://dev.yeosachin.com');

        const browserModule = { exports: {} as CompiledDeployment };
        new Script(bundle).runInNewContext({
            module: browserModule, URL, fetch: fetchSpy, __createSupabaseClient: createClient,
            window: { location: { origin: 'https://dev.yeosachin.com' } },
            process: { env: { DEPLOYMENT_ROLE: 'production', NEXT_PUBLIC_SUPABASE_URL: 'https://productiontest.supabase.co' } },
        });
        expect(browserModule.exports.origin.appOriginForRequest('https://dev.yeosachin.com/login'))
            .toBe('https://dev.yeosachin.com');
        expect(browserModule.exports.guard.isDevUiDeployment()).toBe(false);
        expect(createClient).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('supports the browser OAuth origin without granting server authority to its public marker', () => {
        vi.stubGlobal('window', {});
        vi.stubEnv('NEXT_PUBLIC_DEPLOYMENT_ROLE', 'dev');
        expect(appOriginForRequest('https://dev.yeosachin.com/login'))
            .toBe('https://dev.yeosachin.com');
        expect(() => appOriginForServer({ NEXT_PUBLIC_DEPLOYMENT_ROLE: 'dev' }))
            .toThrow('DEV_UI_DEPLOYMENT_REJECTED');
    });

    it.each([
        { VERCEL_PROJECT_ID: 'prj_production_test' },
        { NEXT_PUBLIC_SUPABASE_URL: 'https://productiontest.supabase.co' },
        { NEXT_PUBLIC_SUPABASE_URL: 'https://user:pass@devuitestproject.supabase.co' },
        { NEXT_PUBLIC_SUPABASE_URL: 'https://devuitestproject.supabase.co/rest/v1' },
        { NEXT_PUBLIC_SUPABASE_URL: 'https://devuitestproject.supabase.co?mode=dev' },
        { NEXT_PUBLIC_SUPABASE_URL: 'https://devuitestproject.supabase.co#dev' },
        { NEXT_PUBLIC_SUPABASE_URL: 'http://devuitestproject.supabase.co' },
        { DEPLOYMENT_ROLE: undefined },
        { DEPLOYMENT_ROLE: 'production' },
    ])('rejects a mismatched private deployment identity: %j', override => {
        expect(() => appOriginForServer({ ...devEnvironment, ...override }))
            .toThrow('DEV_UI_DEPLOYMENT_REJECTED');
    });

    it.each(['https://attacker.example/login', 'https://yeosachin.com/login', 'http://dev.yeosachin.com/login'])
    ('rejects an unapproved request origin on the Dev server: %s', requestUrl => {
        expect(() => appOriginForRequest(requestUrl, devEnvironment))
            .toThrow('DEV_UI_DEPLOYMENT_REJECTED');
    });

    it.each(['/%252f%252fattacker.example', '/%255cattacker.example', '/%252525252f%252525252fattacker.example'])
    ('keeps nested unsafe redirects within the fixed Dev origin: %s', redirectTo => {
        expect(appRedirectUrlForRequest('https://dev.yeosachin.com/auth/callback', redirectTo, devEnvironment).href)
            .toBe('https://dev.yeosachin.com/analyze');
    });
});
