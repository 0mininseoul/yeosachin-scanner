import { build } from 'esbuild';
import nextEnv from '@next/env';

const development = process.argv.includes('--dev');
nextEnv.loadEnvConfig(process.cwd(), development);
const publicNames = [
  'NEXT_PUBLIC_AMPLITUDE_API_KEY',
  'NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_ENABLED',
  'NEXT_PUBLIC_AMPLITUDE_SESSION_REPLAY_SAMPLE_RATE',
  'NEXT_PUBLIC_DEPLOYMENT_ROLE',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_APP_URL',
];
const define = Object.fromEntries(publicNames.map(name => [
  `process.env.${name}`, JSON.stringify(process.env[name] ?? ''),
]));
define['process.env.NODE_ENV'] = JSON.stringify(development ? 'development' : 'production');
define['process.env'] = '{}';
await build({
  entryPoints: ['lib/services/cherry-analytics.ts'],
  outfile: 'public/namchin/analytics.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  minify: !development,
  define,
});
