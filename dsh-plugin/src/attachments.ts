import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Durable-attachment registration for generated images (UI-only display).
 *
 * The attachment seam (`ctx.attachments`, `@deepseek-ai/dsh-attachment`)
 * validates and durably commits image bytes and returns a serializable
 * `ImageAttachmentRef`. The references ride the tool's canonical output so
 * `presentationMeta`/`presentResult` can build an image-bearing result CARD —
 * a pure UI path that never enters the model request (the production
 * DeepSeek adapter rejects image content with UNSUPPORTED_CONTENT, so
 * injecting images into the conversation is not an option).
 *
 * The seam is consumed opportunistically (`ctx.get('attachments')`) with a
 * structural type, so the plugin still loads in compositions without a
 * provider.
 */

export interface ImageAttachmentRefLike {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name?: string
}

export interface AttachmentStoreLike {
  saveImage(input: {
    data: Uint8Array
    mediaType: 'image/png'
    name?: string
  }): Promise<unknown>
}

export function getAttachmentStore(ctx: Context): AttachmentStoreLike | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('attachments') as
    | AttachmentStoreLike
    | undefined
}

/** Commit every generated PNG as a durable attachment and return its refs. */
export async function saveGeneratedImageRefs(
  ctx: Context,
  imagePaths: string[],
): Promise<ImageAttachmentRefLike[]> {
  const store = getAttachmentStore(ctx)
  if (!store) {
    throw new Error('no ctx.attachments provider mounted (dsh-attachment-local ships with dsh-base)')
  }
  const refs: ImageAttachmentRefLike[] = []
  for (const file of imagePaths) {
    const data = await readFile(file)
    const ref = await store.saveImage({
      data,
      mediaType: 'image/png',
      name: basename(file),
    })
    refs.push(ref as ImageAttachmentRefLike)
  }
  return refs
}
