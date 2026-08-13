import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

/**
 * Image → base64 data-URI helpers for the Qwen vision API.
 *
 * The DashScope / 百炼 VL endpoints cap the request body (~10 MB) and the
 * pixel dimensions (1568 px on the longest edge in practice). Oversized
 * images are transparently downscaled to JPEG when the optional `sharp`
 * dependency is installed; without it, oversized images fail with an
 * actionable error instead of a confusing API rejection.
 */

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
}

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGE_EDGE = 1568

export interface ImageSize {
  width: number
  height: number
}

/** Best-effort width/height from a few common container headers. */
export function sniffImageSize(data: Buffer, ext: string): ImageSize | undefined {
  // PNG: signature + IHDR; width/height are big-endian at offsets 16/20.
  if (ext === '.png' && data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  }
  // GIF: logical screen descriptor, little-endian at offsets 6/8.
  if (ext === '.gif' && data.length >= 10 && data.subarray(0, 6).toString('latin1') === 'GIF89a') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  }
  if (ext === '.gif' && data.length >= 10 && data.subarray(0, 6).toString('latin1') === 'GIF87a') {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) }
  }
  // BMP: BITMAPFILEHEADER; width/height are little-endian at offsets 18/22.
  if (ext === '.bmp' && data.length >= 26 && data.readUInt16LE(0) === 0x4d42) {
    return { width: data.readInt32LE(18), height: Math.abs(data.readInt32LE(22)) }
  }
  // JPEG: walk segments for a SOF marker (C0..CF, except C4/C8/CC).
  if (ext === '.jpg' || ext === '.jpeg') {
    let offset = 2
    while (offset + 9 < data.length) {
      const byte = data[offset]
      if (byte === undefined || byte !== 0xff) {
        offset += 1
        continue
      }
      const marker = data[offset + 1]
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xcf
        && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) }
      }
      const length = data.readUInt16BE(offset + 2)
      if (length < 2) break
      offset += 2 + length
    }
  }
  return undefined
}

/** Downscale/JPEG-encode through sharp; throws a setup hint when absent. */
async function downscaleWithSharp(data: Buffer, maxEdge: number): Promise<Buffer> {
  let sharp: typeof import('sharp')
  try {
    sharp = (await import('sharp')).default
  } catch {
    throw new Error(
      `image exceeds the vision API limits (${MAX_IMAGE_BYTES} bytes / ${MAX_IMAGE_EDGE} px edge) `
      + 'and the optional "sharp" dependency is not installed, so it cannot be downscaled automatically. '
      + 'Install it into the profile with: dsh plugin --profile <name> add sharp '
      + '(then approve its build script via `pnpm approve-builds` in the profile directory)',
    )
  }
  const image = sharp(data).rotate() // normalize EXIF orientation
  const metadata = await image.metadata()
  const width = metadata.width
  const height = metadata.height
  const edge = width !== undefined && height !== undefined ? Math.max(width, height) : 0
  if (edge > maxEdge) {
    image.resize({
      width: maxEdge,
      height: maxEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
  }
  // JPEG flattens transparency; composite onto white to avoid black artifacts.
  return image.flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer()
}

/**
 * Encode a local image as a `data:<mime>;base64,` URI, downscaling when the
 * file or its pixel dimensions exceed the API limits.
 */
export async function imageToDataUri(imagePath: string): Promise<string> {
  const ext = extname(imagePath).toLowerCase()
  const mime = MIME[ext] ?? 'image/jpeg'
  const original = await readFile(imagePath)
  const size = sniffImageSize(original, ext)
  const oversized = original.length > MAX_IMAGE_BYTES
    || (size !== undefined && Math.max(size.width, size.height) > MAX_IMAGE_EDGE)
  const data = oversized ? await downscaleWithSharp(original, MAX_IMAGE_EDGE) : original
  const outMime = oversized ? 'image/jpeg' : mime
  return `data:${outMime};base64,${data.toString('base64')}`
}
