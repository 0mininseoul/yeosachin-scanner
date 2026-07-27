import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { createResultImageR2Reader, loadResultImageR2Config } from '../lib/services/media/r2-result-image-store';

type ObjectRow = { request_id: string; kind: 'target' | 'female' | 'private'; sort_ordinal: number; status: string; object_key: string | null; byte_size: number | null; sha256: string | null };
const output = path.join(process.cwd(), 'public', 'demo-avatars');

function loadSelectedObjects(): ObjectRow[] {
  const query = `with grouped as (select r.id, count(*) as total_objects, count(*) filter (where o.kind='target') as total_target, count(*) filter (where o.kind='female') as total_female, count(*) filter (where o.kind='private') as total_private, count(*) filter (where o.status='ready') as ready_total, count(*) filter (where o.status='ready' and o.kind='target') as ready_target, count(*) filter (where o.status='ready' and o.kind='female') as ready_female, count(*) filter (where o.status='ready' and o.kind='private') as ready_private from public.analysis_requests r join public.analysis_v2_result_image_manifests m on m.request_id=r.id and m.sealed_at is not null join public.analysis_v2_result_image_objects o on o.request_id=r.id where r.status='completed' and (r.plan_type='standard' or r.selected_plan_id_snapshot='standard') group by r.id), selected as (select id from grouped where total_objects=230 and total_target=1 and total_female=84 and total_private=145 and ready_total=230 and ready_target=1 and ready_female=84 and ready_private=145) select o.request_id,o.kind,o.sort_ordinal,o.status,o.object_key,o.byte_size,o.sha256 from public.analysis_v2_result_image_objects o join selected s on s.id=o.request_id where o.status='ready' order by o.sort_ordinal;`;
  const raw = execFileSync('supabase', ['db', 'query', '--linked', query, '--output', 'json'], { encoding: 'utf8', env: process.env });
  const parsed = JSON.parse(raw) as { rows?: unknown[] };
  if (!Array.isArray(parsed.rows) || parsed.rows.length !== 230) throw new Error('Demo v3 source registry is not unique.');
  return parsed.rows as ObjectRow[];
}

async function main() {
  const rows = loadSelectedObjects();
  if (rows.some(o => !o.object_key || !o.byte_size || !o.sha256)) throw new Error('Demo v3 source registry is incomplete.');
  const reader = createResultImageR2Reader(loadResultImageR2Config());
  await mkdir(output, { recursive: true });
  await Promise.all(rows.map(async row => {
    const bytes = await reader.get({ objectKey: row.object_key!, expectedByteSize: row.byte_size!, expectedSha256: row.sha256! });
    const blurred = await sharp(bytes).resize(160, 160, { fit: 'cover' }).blur(14).webp({ quality: 76 }).toBuffer();
    await writeFile(path.join(output, `demo-v3-${row.kind}-${String(row.sort_ordinal).padStart(3, '0')}.webp`), blurred);
  }));
  process.stdout.write(`demo-v3-assets=${rows.length}\n`);
}

void main();
