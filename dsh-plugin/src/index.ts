import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { qwenVisionTool } from './vision-tool.js'
import { qwenGenerateTool } from './generate-tool.js'
import { hasCredentialsProvider } from './credentials.js'

/**
 * dsh-multimodal-bridge — Qwen-VL vision + Qwen-Image generation as
 * DeepSeek Harness model-facing tools.
 *
 * Registration is effect-based: disposing the plugin fiber unregisters both
 * tools, and the schemas flow into system-prompt assembly automatically.
 */

export const name = 'multimodal-bridge'

export const inject = ['tools']

// Re-export the underlying client so tests / scripts can exercise the API
// calls without booting the harness (`scripts/smoke.mjs` uses this).
export { callVision, callGenerate, defaultSizeFor } from './client.js'

export interface Config {
  /**
   * Qwen (DashScope / 百炼) API key. Empty = fall back to
   * `QWEN_DASHSCOPE_API_KEY`, or the per-tool `VISION_API_KEY` /
   * `GENERATE_API_KEY` environment variables.
   */
  apiKey: string
  /**
   * Native DashScope endpoint, or an OpenAI-compatible gateway URL such as
   * `https://ws-xxxx.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`.
   * The client auto-detects the protocol from the URL.
   */
  apiBase: string
  /** Vision model for `qwen_vision`. */
  visionModel: string
  /** Preferred text-to-image model for `qwen_generate`. */
  generateModel: string
  /**
   * Models tried in order when the preferred model fails with a gateway-side
   * routing error (each workspace gateway exposes only a subset of models).
   * Each model uses its own official default size unless the caller chose one.
   */
  generateFallbackModels: string[]
  /**
   * After a successful generation, register the PNGs as durable attachments
   * and surface them in the tool-result card (UI-only display — image blocks
   * never enter the model request, which the text-only adapters would
   * reject). Best-effort: failures never fail the generation itself.
   */
  attachGeneratedImages: boolean
  /**
   * Directory where generated images are saved. Relative paths resolve
   * against the session workspace (the invoking directory).
   */
  outputDir: string
}

export const Config: Schema<Config> = Schema.object({
  apiKey: Schema.string().default(''),
  // Empty means "use the environment": QWEN_API_BASE, then the official
  // DashScope endpoint. Pinning a URL here overrides the environment, so
  // bundle patches leave it empty for gateway users.
  apiBase: Schema.string().default(''),
  visionModel: Schema.string().default('qwen-vl-max'),
  generateModel: Schema.string().default('qwen-image-2.0'),
  generateFallbackModels: Schema.array(Schema.string()).default([
    'wan2.7-image',
    'qwen-image-2.0',
    'wan2.7-image-pro',
    'wan2.1-t2i-turbo',
  ]),
  attachGeneratedImages: Schema.boolean().default(false),
  outputDir: Schema.string().default('generated'),
})

export function apply(ctx: Context, config: Config) {
  const options = {
    apiKey: config.apiKey || '',
    apiBase: config.apiBase || process.env.QWEN_API_BASE || 'https://dashscope.aliyuncs.com',
    visionModel: config.visionModel,
    generateModel: config.generateModel,
    generateFallbackModels: config.generateFallbackModels,
    attachGeneratedImages: config.attachGeneratedImages,
    outputDir: config.outputDir || 'generated',
  }

  ctx.tools.register(qwenVisionTool(ctx, options))
  ctx.tools.register(qwenGenerateTool(ctx, options))

  if (!config.apiKey
    && !process.env.QWEN_DASHSCOPE_API_KEY
    && !process.env.VISION_API_KEY
    && !process.env.GENERATE_API_KEY
    && !hasCredentialsProvider(ctx)) {
    console.warn(
      '[multimodal-bridge] no Qwen API key configured: qwen_vision / qwen_generate '
      + 'will fail until a key is set via `apiKey` config, QWEN_DASHSCOPE_API_KEY / '
      + 'VISION_API_KEY / GENERATE_API_KEY in the environment, or ~/.dsh/.credentials.yaml',
    )
  }
}
