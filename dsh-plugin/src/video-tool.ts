import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callVideo, isFallbackableError } from './client.js'
import { resolveApiKey } from './credentials.js'
import type { QwenOptions } from './vision-tool.js'

// Common landscape/portrait video resolutions (model-dependent support).
const SIZES = ['1280*720', '720*1280'] as const

/**
 * `qwen_video` — text-to-video (or image-to-video when `image_path` is given)
 * through the native DashScope async video-synthesis API. Generation takes
 * minutes; the tool polls the task until it finishes and returns the saved
 * MP4 path.
 */
export function qwenVideoTool(ctx: Context, options: QwenOptions) {
  return defineTool({
    name: 'qwen_video',
    description:
      'Generate a short video with a Qwen video model (wanx/wan series): text-to-video, or '
      + 'image-to-video by passing image_path (the image becomes the first frame and is animated '
      + 'according to the prompt). Saves the result as an MP4 file and returns its absolute path. '
      + 'Takes a few minutes. Chinese and English prompts both work well.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Video description, or the motion instruction when image_path is given (e.g. "let the dog run across the grass").',
      },
      image_path: {
        type: 'string',
        description: 'Optional local image to animate (image-to-video). Becomes the first frame.',
      },
      size: {
        type: 'string',
        enum: [...SIZES],
        description: 'Video resolution; omit for the model default.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          video: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.success
          ? `Generated video: ${value.video}`
          : `Video generation failed: ${value.error ?? 'unknown error'}`,
      }],
    },
    timeoutMs: 720_000,
    presentCall(args) {
      if (typeof args !== 'object' || args === null) return undefined
      const prompt = (args as { prompt?: unknown }).prompt
      if (typeof prompt !== 'string') return undefined
      return { card: 'generic', title: 'qwen_video', rawInput: { prompt } }
    },
    async execute(args, exec) {
      const apiKey = await resolveApiKey(ctx, options.apiKey, 'GENERATE_API_KEY')
      if (!apiKey) {
        throw new Error('missing Qwen API key: set `apiKey` in the plugin config, QWEN_DASHSCOPE_API_KEY / GENERATE_API_KEY in the environment, or store it in ~/.dsh/.credentials.yaml')
      }
      const size = args.size ?? '1280*720'

      // Model fallback chain, same contract as qwen_generate: model-level
      // denials (AccessDenied / not exist / quota) move to the next model.
      // I2V requests use the i2v chain (data-URI first frames verified with
      // wanx2.1-i2v-turbo on 2026-08-16).
      const chain = args.image_path
        ? [...new Set([options.videoI2vModel, ...options.videoI2vFallbackModels])]
        : [...new Set([options.videoModel, ...options.videoFallbackModels])]
      const failures: string[] = []
      for (const model of chain) {
        try {
          const video = await callVideo({
            prompt: args.prompt,
            size,
            model,
            apiKey,
            outputDir: options.outputDir,
            imagePath: args.image_path,
            signal: exec.signal,
          })
          return { success: true, video, error: '' }
        } catch (error) {
          if (exec.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${model}: ${message}`)
          if (!isFallbackableError(error)) break
        }
      }
      return {
        success: false,
        video: '',
        error: failures.length > 0 ? failures.join(' | ') : 'no video model configured',
      }
    },
  })
}
