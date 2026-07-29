/**
 * One-off, deterministic source-file privacy hardening for the committed demo
 * rasters. It never downloads an image or uses the ImageGen calibration file.
 */
import { readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const avatarDirectory = path.join(process.cwd(), 'public', 'demo-avatars');
const sourceFile = /^demo-v3-(?:target|female|private)-\d{3}\.webp$/u;

async function blurCommittedDemoAvatars(): Promise<number> {
    const files = (await readdir(avatarDirectory)).filter(file => sourceFile.test(file)).sort();
    await Promise.all(files.map(async file => {
        const source = path.join(avatarDirectory, file);
        const temporary = `${source}.privacy-blur`;
        try {
            await sharp(source)
                .blur(0.8)
                .webp({ quality: 82, effort: 6, smartSubsample: true })
                .toFile(temporary);
            await rename(temporary, source);
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
    }));
    return files.length;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    blurCommittedDemoAvatars().then(
        count => process.stdout.write(`baked additional privacy blur into ${count} demo avatar assets\n`),
        error => { process.stderr.write(`could not bake demo avatar blur: ${String(error)}\n`); process.exitCode = 1; },
    );
}

export { blurCommittedDemoAvatars };
