/**
 * Derive this fork's brand bitmaps from one piece of source art.
 *
 * Not part of `yarn build`: like upstream's `build/app-icon.png`, the outputs are
 * committed art, and the pinned digest in tests/package.spec.ts is what guards
 * them. Run this only when the source art or the framing below changes, then
 * update that digest.
 *
 * Two rules constrain the framing, both inherited rather than chosen:
 *
 * - `generate-mac-app-icon.mjs` demands a 1024x1024 RGBA16 source with an ICC
 *   profile, and stretches it to 824x824 inside a 1024 canvas. Its test then
 *   trims the result and expects exactly 824x824 at -100/-100, so the source's
 *   ink has to reach all four edges. Upstream satisfies that with a squircle
 *   plate behind its glyph; this fork has no plate art, so the mark itself is
 *   the full bleed. Filling the square costs 0.8% of aspect (the ink box is
 *   720x726), which is under a pixel at every size these icons are drawn at.
 * - The Web brand row draws the same mark through a 24px CSS box, so it comes
 *   from the same trimmed ink. Deriving both here is what keeps the taskbar and
 *   the sidebar from slowly disagreeing about what the mark looks like.
 */

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Native icon canvas: what the macOS generator and electron-builder expect. */
export const APP_ICON_SIZE = 1024
/** Web brand row art: twice the 24px CSS box it is drawn into, for hidpi. */
export const WEB_MARK_SIZE = 96

const buildRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), 'build')
const sourcePath = join(buildRoot, 'openlux-mark-source.png')

/** The source art cropped to its ink, as a PNG buffer plus its box. */
async function inkOnly(source) {
  const { data, info } = await sharp(source)
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
    .png()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * Write the native application icon and the Web brand mark.
 * @param source - absolute path to the square source art.
 * @returns Resolves once both files are on disk.
 */
export async function generateBrandIcons(source = sourcePath) {
  const ink = await inkOnly(readFileSync(source))

  const appIcon = await sharp(ink.data)
    .resize({
      width: APP_ICON_SIZE,
      height: APP_ICON_SIZE,
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .toColourspace('rgb16')
    .withIccProfile('srgb')
    .png({ compressionLevel: 9, progressive: false, adaptiveFiltering: false, palette: false })
    .toBuffer()

  const webMark = await sharp(ink.data)
    .resize({
      width: WEB_MARK_SIZE,
      height: WEB_MARK_SIZE,
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.lanczos3,
    })
    .png({ compressionLevel: 9 })
    .toBuffer()

  await writeFile(join(buildRoot, 'app-icon.png'), appIcon)
  await writeFile(join(buildRoot, 'openlux-mark.png'), webMark)
  return { ink: `${String(ink.width)}x${String(ink.height)}`, appIcon: appIcon.byteLength, webMark: webMark.byteLength }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const written = await generateBrandIcons()
  process.stdout.write(`generate-brand-icons: ink ${written.ink}, app-icon ${String(written.appIcon)} bytes, web mark ${String(written.webMark)} bytes\n`)
}
