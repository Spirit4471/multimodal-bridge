import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callVision, isFallbackableError } from './client.js'
import { resolveApiKey } from './credentials.js'

export interface QwenOptions {
  apiKey: string
  apiBase: string
  visionModel: string
  visionFallbackModels: string[]
  generateModel: string
  generateFallbackModels: string[]
  videoModel: string
  videoFallbackModels: string[]
  videoI2vModel: string
  videoI2vFallbackModels: string[]
  chatModel: string
  chatFallbackModels: string[]
  ttsModel: string
  ttsFallbackModels: string[]
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
      + 'the way to "see" images. Returns the model\'s text answer.\n'
      + 'Treat the answer as a SENSOR READING, not a chat partner:\n'
      + '- Ask for structured output (tables, CSV, JSON, lists) whenever precision matters.\n'
      + '- Use a two-pass strategy for detail: first an overall description, then a focused query '
      + 'on the specific region/attribute that matters.\n'
      + '- For critical facts, cross-check with a second query (different wording) before trusting.\n'
      + '- Report hedged or uncertain answers explicitly rather than smoothing them over.',
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
      if (!apiKey) {
        throw new Error('missing Qwen API key: set `apiKey` in the plugin config, QWEN_DASHSCOPE_API_KEY / VISION_API_KEY in the environment, or store it in ~/.dsh/.credentials.yaml')
      }

      // Vision fallback chain, same contract as the generation tools.
      const chain = [...new Set([options.visionModel, ...options.visionFallbackModels])]
      const failures: string[] = []
      for (const model of chain) {
        try {
          return await callVision({
            imagePath,
            prompt: args.prompt,
            model,
            apiKey,
            apiBase: options.apiBase,
            signal: exec.signal,
          })
        } catch (error) {
          if (exec.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${model}: ${message}`)
          if (!isFallbackableError(error)) break
        }
      }
      throw new Error(failures.length > 0 ? failures.join(' | ') : 'no vision model configured')
    },
  })
}
