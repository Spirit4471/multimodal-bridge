import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callVision } from './client.js'
import { resolveApiKey } from './credentials.js'

export interface QwenOptions {
  apiKey: string
  apiBase: string
  visionModel: string
  generateModel: string
  generateFallbackModels: string[]
  attachGeneratedImages: boolean
  outputDir: string
}

/**
 * `qwen_vision` — image understanding for text-only models.
 *
 * Sends a local image plus a prompt to a Qwen-VL model and returns the
 * model's text answer. Read-only: parallel-safe.
 */
export function qwenVisionTool(ctx: Context, options: QwenOptions) {
  return defineTool({
    name: 'qwen_vision',
    description:
      'Ask a Qwen-VL vision-language model about a local image. Use it to understand image content, '
      + 'OCR text, analyze layout, or verify visual output. For models without native vision this is '
      + 'the way to "see" images. Returns the model\'s text answer.',
    parameters: {
      image_path: {
        type: 'string',
        required: true,
        description: 'Absolute path to a local image (PNG/JPEG/WebP/BMP/GIF).',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'The question or analysis request about the image.',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      if (typeof args !== 'object' || args === null) return undefined
      const path = (args as { image_path?: unknown }).image_path
      if (typeof path !== 'string') return undefined
      return { card: 'generic', title: `qwen_vision: ${basename(path)}`, locations: [{ path }] }
    },
    async execute(args, exec) {
      const imagePath = args.image_path
      if (!existsSync(imagePath)) {
        throw new Error(`image not found: ${imagePath}`)
      }
      const apiKey = await resolveApiKey(ctx, options.apiKey, 'VISION_API_KEY')
      return callVision({
        imagePath,
        prompt: args.prompt,
        model: options.visionModel,
        apiKey,
        apiBase: options.apiBase,
        signal: exec.signal,
      })
    },
  })
}
