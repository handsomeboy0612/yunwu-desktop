/**
 * Generate native tray bitmaps from the repository-owned brand mark.
 *
 * Upstream derived these from a single-path SVG, because its mark is one glyph
 * in one flat colour. This fork's mark is raster art with a gradient, so the
 * tray family is flattened out of the same PNG the app icon comes from: the
 * silhouette is the mark's own alpha channel, filled with one colour so the
 * icon still reads on a light and a dark shelf alike. A gradient at 16px does
 * not; half of this mark is dark navy that disappears into a dark taskbar.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')

/**
 * The mark's own blue: the largest colour bucket in the art, not a guess. Change
 * the art and this wants remeasuring.
 */
export const MARK_BLUE = { r: 0x04, g: 0x93, b: 0xcc }
export const TEMPLATE_BLACK = { r: 0, g: 0, b: 0 }

/**
 * Share of the icon box the artwork fills. Upstream's glyph is wider than tall,
 * so its box padded itself; this mark is square and would otherwise touch every
 * edge, which reads as oversized next to the platform's own tray icons.
 */
export const INK_SHARE = 0.8

const variants = [
  ['tray-iconTemplate.png', TEMPLATE_BLACK, 16],
  ['tray-iconTemplate@2x.png', TEMPLATE_BLACK, 32],
  ['tray-icon-blue.png', MARK_BLUE, 16],
  ['tray-icon-blue@1.25x.png', MARK_BLUE, 20],
  ['tray-icon-blue@1.5x.png', MARK_BLUE, 24],
  ['tray-icon-blue@2x.png', MARK_BLUE, 32],
]

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

/**
 * Flatten the mark into one colour at one size.
 * @param ink - trimmed mark, edge to edge.
 * @param size - icon box in pixels.
 * @param color - fill for every visible pixel.
 * @returns the PNG bytes.
 */
export async function flatTrayIcon(ink, size, color) {
  const artwork = Math.round(size * INK_SHARE)
  const pad = size - artwork
  const before = Math.floor(pad / 2)
  const shaped = await sharp(ink)
    .resize({
      width: artwork,
      height: artwork,
      fit: 'contain',
      background: TRANSPARENT,
      kernel: sharp.kernel.lanczos3,
    })
    .extend({
      top: before,
      left: before,
      bottom: pad - before,
      right: pad - before,
      background: TRANSPARENT,
    })
    .ensureAlpha()
    .toBuffer()
  const alpha = await sharp(shaped).extractChannel('alpha').raw().toBuffer()

  return sharp({ create: { width: size, height: size, channels: 3, background: color } })
    .joinChannel(alpha, { raw: { width: size, height: size, channels: 1 } })
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/**
 * Write every tray bitmap the runtime loads.
 * @param source - path to the brand mark art.
 * @returns each written filename with its byte length.
 */
export async function generateTrayIcons(source = join(buildRoot, 'openlux-mark-source.png')) {
  const ink = await sharp(readFileSync(source))
    .trim({ background: TRANSPARENT, threshold: 0 })
    .png()
    .toBuffer()

  return Promise.all(variants.map(async ([filename, color, size]) => {
    const bytes = await flatTrayIcon(ink, size, color)
    await sharp(bytes).toFile(join(buildRoot, filename))
    return [filename, bytes.byteLength]
  }))
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === join(process.argv[1])) {
  const written = await generateTrayIcons()
  const summary = written.map(([name, bytes]) => `${name} ${String(bytes)}B`).join(', ')
  process.stdout.write(`generate-tray-icons: ${summary}\n`)
}
