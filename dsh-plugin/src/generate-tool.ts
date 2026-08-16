import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolResultView } from '@deepseek-ai/dsh-tools'
import { callGenerate, defaultSizeFor, isFallbackableError } from './client.js'
import { resolveApiKey } from './credentials.js'
import { saveGeneratedImageRefs, type ImageAttachmentRefLike } from './attachments.js'
import type { QwenOptions } from './vision-tool.js'

// Sizes accepted across the supported model families: the wanx trio plus the
// qwen-image square sizes (qwen-image models default to 1328*1328; the 百炼
// gateway rejects 1024*1024 for qwen-image-2.0 with a cryptic "url error").
const SIZES = ['1024*1024', '720*1280', '1280*720', '1328*1328', '1536*1536'] as const

function isRefLike(x: unknown): x is ImageAttachmentRefLike {
  if (typeof x !== 'object' || x === null) return false
  const record = x as Record<string, unknown>
  return typeof record.attachmentId === 'string' && typeof record.mediaType === 'string'
}

/**
 * `qwen_generate` — text-to-image through Qwen-Image.
 *
 * Downloads the generated images into `options.outputDir` and returns their
 * absolute paths as the canonical value. API-level failures return
 * `{ success: false, error }`; configuration errors (missing key, invalid
 * count) throw.
 */
export function qwenGenerateTool(ctx: Context, options: QwenOptions) {
  return defineTool({
    name: 'qwen_generate',
    description:
      'Generate an image with a Qwen-Image model (text-to-image), or edit/transform a local image '
      + '(image-to-image) by passing image_path plus a text instruction. Saves the result as PNG '
      + 'files and returns their absolute paths. Chinese and English prompts both work well.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Image description, or the edit instruction when image_path is given (e.g. "turn it into a cartoon style").',
      },
      image_path: {
        type: 'string',
        description: 'Optional local image to edit (image-to-image). Supported on OpenAI-compatible gateways only.',
      },
      size: {
        type: 'string',
        enum: [...SIZES],
        description: 'Image size; omit for the model default (1328*1328 for qwen-image models, 1024*1024 otherwise).',
      },
      n: {
        type: 'integer',
        description: 'Number of images to generate, 1-4 (default 1).',
      },
      negative_prompt: {
        type: 'string',
        description: 'Content to avoid in the generated image (optional).',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          images: { type: 'array', items: { type: 'string' } },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                attachmentId: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                name: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      presentationMeta: (_args, value) => ({ attachments: value.attachments ?? [] }),
      render: (_args, value) => {
        const images = value.images ?? []
        const count = images.length
        return [{
          type: 'text',
          text: value.success
            ? `Generated ${count} image${count === 1 ? '' : 's'}:\n${images.join('\n')}`
            : `Image generation failed: ${value.error ?? 'unknown error'}`,
        }]
      },
    },
    timeoutMs: 180_000,
    presentCall(args) {
      if (typeof args !== 'object' || args === null) return undefined
      const prompt = (args as { prompt?: unknown }).prompt
      if (typeof prompt !== 'string') return undefined
      return { card: 'generic', title: 'qwen_generate', rawInput: { prompt } }
    },
    presentResult(_args, result) {
      // UI-only image card: image blocks never enter the model request (the
      // text-only DeepSeek adapter rejects them), so they live ONLY in this
      // card intent. Pure projection from the persisted presentation meta.
      if (result.isError || result.meta === undefined) return undefined
      const attachments = (result.meta as { attachments?: unknown }).attachments
      if (!Array.isArray(attachments) || attachments.length === 0) return undefined
      const refs = attachments.filter(isRefLike)
      if (refs.length === 0) return undefined
      const content = [
        { type: 'text', text: `Generated ${refs.length} image${refs.length === 1 ? '' : 's'}:` },
        ...refs.map(ref => ({ type: 'image', attachment: ref })),
      ]
      return {
        card: 'generic',
        title: 'Generated images',
        content,
      } as unknown as ToolResultView
    },
    async execute(args, exec) {
      const n = args.n ?? 1
      if (!Number.isInteger(n) || n < 1 || n > 4) {
        throw new Error('n must be an integer between 1 and 4')
      }
      const apiKey = await resolveApiKey(ctx, options.apiKey, 'GENERATE_API_KEY')
      if (!apiKey) {
        throw new Error('missing Qwen API key: set `apiKey` in the plugin config, QWEN_DASHSCOPE_API_KEY / GENERATE_API_KEY in the environment, or store it in ~/.dsh/.credentials.yaml')
      }

      // Model fallback chain: the 百炼 gateway exposes a per-workspace model
      // route table that rarely matches the workspace's free quota. Gateway-side
      // rejections (url error, empty responses, model-not-enabled) retry the
      // next candidate; authentication failures stop immediately. Each model
      // uses its own official default size unless the caller picked one.
      const explicitSize = args.size
      const chain = [...new Set([options.generateModel, ...options.generateFallbackModels])]
      const failures: string[] = []
      for (const model of chain) {
        const size = explicitSize ?? defaultSizeFor(model)
        try {
          const images = await callGenerate({
            prompt: args.prompt,
            size,
            n,
            negativePrompt: args.negative_prompt ?? '',
            model,
            apiKey,
            apiBase: options.apiBase,
            outputDir: options.outputDir,
            imagePath: args.image_path,
            signal: exec.signal,
          })
          let attachments: ImageAttachmentRefLike[] = []
          if (options.attachGeneratedImages && images.length > 0) {
            // Best-effort UI-only display path; never fails the generation.
            try {
              attachments = await saveGeneratedImageRefs(ctx, images)
            } catch (error) {
              console.warn('[multimodal-bridge] attachment registration skipped:', error)
            }
          }
          return { success: true, images, attachments, error: '' }
        } catch (error) {
          if (exec.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${model}: ${message}`)
          if (!isFallbackableError(error)) break
        }
      }
      return {
        success: false,
        images: [],
        attachments: [],
        error: failures.length > 0 ? failures.join(' | ') : 'no generation model configured',
      }
    },
  })
}
