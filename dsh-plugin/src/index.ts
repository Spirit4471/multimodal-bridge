import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { qwenVisionTool } from './vision-tool.js'
import { qwenGenerateTool } from './generate-tool.js'
import { qwenVideoTool } from './video-tool.js'
import { qwenChatTool } from './chat-tool.js'
import { qwenTtsTool } from './tts-tool.js'
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
export { callVision, callGenerate, callVideo, callChat, callTts, defaultSizeFor } from './client.js'

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
  /** Vision models tried in order on model-level denials. */
  visionFallbackModels: string[]
  /** Preferred text-to-image model for `qwen_generate`. */
  generateModel: string
  /**
   * Models tried in order when the preferred model fails with a gateway-side
   * routing error (each workspace gateway exposes only a subset of models).
   * Each model uses its own official default size unless the caller chose one.
   */
  generateFallbackModels: string[]
  /** Preferred text-to-video model for `qwen_video`. */
  videoModel: string
  /** Video models tried in order on model-level denials (not enabled, quota). */
  videoFallbackModels: string[]
  /** Preferred image-to-video model (used when qwen_video gets an image_path). */
  videoI2vModel: string
  /** I2V models tried in order on model-level denials. */
  videoI2vFallbackModels: string[]
  /** Preferred LLM for `qwen_chat` consultations (second opinion / rebuttal). */
  chatModel: string
  /** Chat models tried in order on model-level denials. */
  chatFallbackModels: string[]
  /** Preferred TTS model for `qwen_tts`. */
  ttsModel: string
  /** TTS models tried in order on model-level denials. */
  ttsFallbackModels: string[]
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
  visionFallbackModels: Schema.array(Schema.string()).default([
    'qwen-vl-plus',
    'qwen3-vl-plus',
    'qwen3-vl-flash',
  ]),
  generateModel: Schema.string().default('qwen-image-2.0'),
  generateFallbackModels: Schema.array(Schema.string()).default([
    'wan2.7-image',
    'qwen-image-2.0',
    'wan2.7-image-pro',
    'wan2.1-t2i-turbo',
  ]),
  videoModel: Schema.string().default('wanx2.1-t2v-turbo'),
  videoFallbackModels: Schema.array(Schema.string()).default([
    'wanx2.1-t2v-plus',
    'wan2.6-t2v',
    'wan2.7-t2v',
  ]),
  videoI2vModel: Schema.string().default('wanx2.1-i2v-turbo'),
  videoI2vFallbackModels: Schema.array(Schema.string()).default([
    'wanx2.1-i2v-plus',
    'wan2.6-i2v',
    'wan2.7-i2v',
  ]),
  chatModel: Schema.string().default('qwen3.7-max'),
  chatFallbackModels: Schema.array(Schema.string()).default([
    'qwen-max',
    'glm-5.2',
    'MiniMax-M2.5',
  ]),
  ttsModel: Schema.string().default('qwen-tts'),
  ttsFallbackModels: Schema.array(Schema.string()).default([]),
  attachGeneratedImages: Schema.boolean().default(false),
  outputDir: Schema.string().default('generated'),
})

export function apply(ctx: Context, config: Config) {
  const options = {
    apiKey: config.apiKey || '',
    apiBase: config.apiBase || process.env.QWEN_API_BASE || 'https://dashscope.aliyuncs.com',
    visionModel: config.visionModel,
    visionFallbackModels: config.visionFallbackModels,
    generateModel: config.generateModel,
    generateFallbackModels: config.generateFallbackModels,
    videoModel: config.videoModel,
    videoFallbackModels: config.videoFallbackModels,
    videoI2vModel: config.videoI2vModel,
    videoI2vFallbackModels: config.videoI2vFallbackModels,
    chatModel: config.chatModel,
    chatFallbackModels: config.chatFallbackModels,
    ttsModel: config.ttsModel,
    ttsFallbackModels: config.ttsFallbackModels,
    attachGeneratedImages: config.attachGeneratedImages,
    outputDir: config.outputDir || 'generated',
  }

  ctx.tools.register(qwenVisionTool(ctx, options))
  ctx.tools.register(qwenGenerateTool(ctx, options))
  ctx.tools.register(qwenVideoTool(ctx, options))
  ctx.tools.register(qwenChatTool(ctx, options))
  ctx.tools.register(qwenTtsTool(ctx, options))

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
