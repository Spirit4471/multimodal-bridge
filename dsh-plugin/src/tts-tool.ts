import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callTts, isFallbackableError } from './client.js'
import { resolveApiKey } from './credentials.js'
import type { QwenOptions } from './vision-tool.js'

/**
 * `qwen_tts` — text-to-speech: gives text-only models a voice. Synthesizes
 * the given text through the native DashScope TTS path (model `qwen-tts`,
 * verified 2026-08-16) and saves the result as a local WAV file.
 */
export function qwenTtsTool(ctx: Context, options: QwenOptions) {
  return defineTool({
    name: 'qwen_tts',
    description:
      'Synthesize speech from text with a Qwen TTS model and save it as a local WAV file. '
      + 'Returns the absolute path of the audio file. Use it to give the user spoken output or to '
      + 'generate narration. Chinese and English text both work.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The text to speak (Chinese and English both work).',
      },
      voice: {
        type: 'string',
        description: 'Optional voice name (model-dependent). Omit for the default voice.',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          audio: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.success
          ? `Generated audio: ${value.audio}`
          : `Speech synthesis failed: ${value.error ?? 'unknown error'}`,
      }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      if (typeof args !== 'object' || args === null) return undefined
      const text = (args as { text?: unknown }).text
      if (typeof text !== 'string') return undefined
      return { card: 'generic', title: 'qwen_tts', rawInput: { text } }
    },
    async execute(args, exec) {
      const apiKey = await resolveApiKey(ctx, options.apiKey, 'QWEN_DASHSCOPE_API_KEY')
      if (!apiKey) {
        throw new Error('missing Qwen API key: set `apiKey` in the plugin config, QWEN_DASHSCOPE_API_KEY in the environment, or store it in ~/.dsh/.credentials.yaml')
      }

      const chain = [...new Set([options.ttsModel, ...options.ttsFallbackModels])]
      const failures: string[] = []
      for (const model of chain) {
        try {
          const audio = await callTts({
            text: args.text,
            voice: args.voice,
            model,
            apiKey,
            outputDir: options.outputDir,
            signal: exec.signal,
          })
          return { success: true, audio, error: '' }
        } catch (error) {
          if (exec.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${model}: ${message}`)
          if (!isFallbackableError(error)) break
        }
      }
      return {
        success: false,
        audio: '',
        error: failures.length > 0 ? failures.join(' | ') : 'no TTS model configured',
      }
    },
  })
}
