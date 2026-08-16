import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { callChat, isFallbackableError } from './client.js'
import { resolveApiKey } from './credentials.js'
import type { QwenOptions } from './vision-tool.js'

/**
 * `qwen_chat` — LLM consultation: lets the driving model ask another LLM
 * (Qwen family or other 百炼 models) for a second opinion, a skeptical
 * review / rebuttal, verification, or help with complex reasoning. The
 * answer is returned as text; a fallback chain handles model-level denials.
 */
export function qwenChatTool(ctx: Context, options: QwenOptions) {
  return defineTool({
    name: 'qwen_chat',
    description:
      'Consult another LLM (Qwen family or other Bailian models) for a second opinion, a skeptical '
      + 'rebuttal/review, verification, or help with complex high-uncertainty reasoning. Returns the '
      + 'consultant model\'s text answer and which model answered. Use it when you want independent '
      + 'scrutiny of your own reasoning or a different model family\'s perspective.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to ask the consultant model (paste the claim/reasoning to scrutinize).',
      },
      system: {
        type: 'string',
        description: 'Optional system instruction, e.g. "You are a skeptical reviewer. Find flaws in the following reasoning."',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          text: { type: 'string' },
          model: { type: 'string' },
          error: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.success
          ? `[consultant: ${value.model}]\n${value.text}`
          : `Chat failed: ${value.error ?? 'unknown error'}`,
      }],
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      if (typeof args !== 'object' || args === null) return undefined
      const prompt = (args as { prompt?: unknown }).prompt
      if (typeof prompt !== 'string') return undefined
      return { card: 'generic', title: 'qwen_chat', rawInput: { prompt } }
    },
    async execute(args, exec) {
      const apiKey = await resolveApiKey(ctx, options.apiKey, 'QWEN_DASHSCOPE_API_KEY')
      if (!apiKey) {
        throw new Error('missing Qwen API key: set `apiKey` in the plugin config, QWEN_DASHSCOPE_API_KEY in the environment, or store it in ~/.dsh/.credentials.yaml')
      }

      const chain = [...new Set([options.chatModel, ...options.chatFallbackModels])]
      const failures: string[] = []
      for (const model of chain) {
        try {
          const text = await callChat({
            prompt: args.prompt,
            system: args.system,
            model,
            apiKey,
            apiBase: options.apiBase,
            signal: exec.signal,
          })
          return { success: true, text, model, error: '' }
        } catch (error) {
          if (exec.signal.aborted) throw error
          const message = error instanceof Error ? error.message : String(error)
          failures.push(`${model}: ${message}`)
          if (!isFallbackableError(error)) break
        }
      }
      return {
        success: false,
        text: '',
        model: '',
        error: failures.length > 0 ? failures.join(' | ') : 'no chat model configured',
      }
    },
  })
}
