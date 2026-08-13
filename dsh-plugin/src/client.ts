import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { imageToDataUri } from './image.js'

/**
 * Qwen API client for the dsh-multimodal-bridge plugin.
 *
 * A TypeScript port of `adapters/qwen_dashscope.py` (vision + generate) with
 * the same dual-protocol behavior:
 *
 * 1. Native DashScope API (default https://dashscope.aliyuncs.com)
 *      vision:   POST /api/v1/services/aigc/multimodal-generation/generation
 *      generate: POST /api/v1/services/aigc/text2image/image-synthesis
 *                (async: X-DashScope-Async: enable, then poll /api/v1/tasks)
 * 2. 百炼 OpenAI-compatible gateway (base contains "compatible-mode" or ends
 *    with "maas.aliyuncs.com")
 *      vision & generate: POST <base>/chat/completions
 */

export interface VisionCall {
  imagePath: string
  prompt: string
  model: string
  apiKey: string
  apiBase: string
  signal?: AbortSignal
}

export interface GenerateCall {
  prompt: string
  size: string
  n: number
  negativePrompt: string
  model: string
  apiKey: string
  apiBase: string
  outputDir: string
  signal?: AbortSignal
}

interface SavedImage {
  kind: 'url' | 'b64'
  value: string
}

function trimBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, '')
}

function isOpenAiCompat(apiBase: string): boolean {
  const base = trimBase(apiBase).toLowerCase()
  return base.includes('compatible-mode') || base.includes('maas.aliyuncs.com')
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

/** Abortable sleep for the native async-task polling loop. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

interface HttpOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  signal?: AbortSignal
}

/** POST/GET JSON; non-2xx becomes a descriptive Error. */
async function requestJson(
  url: string,
  body: unknown | undefined,
  options: HttpOptions = {},
): Promise<unknown> {
  const { method = 'POST', headers = {}, signal } = options
  const resp = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  })
  const text = await resp.text()
  if (!resp.ok) {
    const snippet = (text || resp.statusText).slice(0, 300)
    throw new Error(`Qwen API error ${resp.status}: ${snippet}`)
  }
  if (!text) return {}
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`Qwen API returned non-JSON response: ${text.slice(0, 300)}`)
  }
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

/**
 * Official default output size for a generation model. Size handling differs
 * per model family: qwen-image models default to 1328*1328 (and the 百炼
 * gateway rejects 1024*1024 for qwen-image-2.0 with a cryptic "url error"),
 * while the wanx family defaults to 1024*1024.
 */
export function defaultSizeFor(model: string): string {
  return model.includes('qwen-image') ? '1328*1328' : '1024*1024'
}

/**
 * Whether a generation failure is worth retrying with the next model in the
 * fallback chain: gateway-side model routing / parameter rejections (400/404,
 * the cryptic "url error", empty responses) qualify; authentication and
 * permission failures (401/403) do not — no other model can fix the key.
 */
export function isFallbackableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/Qwen API error (401|403)/.test(message)) return false
  return /Qwen API error (400|404)|no images|url error|model not|not enabled|not exist|not found/i.test(message)
}

/**
 * Ask a Qwen-VL model about one local image; returns the model's text answer.
 */
export async function callVision(call: VisionCall): Promise<string> {
  if (!call.apiKey) {
    throw new Error('missing Qwen API key: set `apiKey` in the plugin config or QWEN_DASHSCOPE_API_KEY / VISION_API_KEY in the environment')
  }
  const dataUri = await imageToDataUri(call.imagePath)
  const compat = isOpenAiCompat(call.apiBase)
  const base = trimBase(call.apiBase)

  const body = compat
    ? {
        model: call.model,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUri } },
            { type: 'text', text: call.prompt },
          ],
        }],
        max_tokens: 4096,
      }
    : {
        model: call.model,
        // DashScope native protocol wraps the conversation in `input.messages`
        // (see https://help.aliyun.com/en/model-studio/multimodal-http-protocol)
        input: {
          messages: [{
            role: 'user',
            content: [
              { image: dataUri },
              { text: call.prompt },
            ],
          }],
        },
      }

  const endpoint = compat
    ? `${base}/chat/completions`
    : `${base}/api/v1/services/aigc/multimodal-generation/generation`

  const data = await requestJson(endpoint, body, {
    headers: authHeaders(call.apiKey),
    signal: call.signal,
  })

  if (compat) {
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    throw new Error(`unexpected Qwen vision response: ${JSON.stringify(data).slice(0, 300)}`)
  }

  const content = (data as {
    output?: { choices?: Array<{ message?: { content?: unknown } }> }
  }).output?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = content
      .filter((part): part is { text?: unknown } => typeof part === 'object' && part !== null)
      .map(part => part.text)
      .filter((text): text is string => typeof text === 'string')
    if (texts.length > 0) return texts.join('\n')
  }
  throw new Error(`unexpected Qwen vision response: ${JSON.stringify(data).slice(0, 300)}`)
}

/** Extract image URLs / b64 payloads from every response shape the gateways use. */
function collectImages(data: unknown): SavedImage[] {
  const items: SavedImage[] = []

  // DashScope-native style: output.choices[].message.content = [{ image: url }, ...]
  const output = (data as { output?: { choices?: Array<{ message?: { content?: unknown } }> } }).output
  for (const choice of output?.choices ?? []) {
    const content = choice?.message?.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part !== null
          && typeof (part as { image?: unknown }).image === 'string') {
          items.push({ kind: 'url', value: (part as { image: string }).image })
        }
      }
    }
  }

  // OpenAI images style: data[].url / data[].b64_json
  for (const entry of (data as { data?: Array<{ url?: unknown; b64_json?: unknown }> }).data ?? []) {
    if (typeof entry?.url === 'string') items.push({ kind: 'url', value: entry.url })
    else if (typeof entry?.b64_json === 'string') items.push({ kind: 'b64', value: entry.b64_json })
  }

  // OpenAI chat style: URLs embedded in choices[].message.content text
  for (const choice of (data as { choices?: Array<{ message?: { content?: unknown } }> }).choices ?? []) {
    const content = choice?.message?.content
    if (typeof content === 'string') {
      for (const match of content.matchAll(/https?:\/\/\S+/g)) {
        items.push({ kind: 'url', value: match[0].replace(/[)\]"'.,;]+$/, '') })
      }
    }
  }

  return items
}

/**
 * Generate images with a Qwen-Image model; downloads the results to
 * `outputDir` and returns the absolute paths of the saved PNG files.
 */
export async function callGenerate(call: GenerateCall): Promise<string[]> {
  if (!call.apiKey) {
    throw new Error('missing Qwen API key: set `apiKey` in the plugin config or QWEN_DASHSCOPE_API_KEY / GENERATE_API_KEY in the environment')
  }
  const n = Math.min(Math.max(1, Math.trunc(call.n) || 1), 4)
  const base = trimBase(call.apiBase)
  const compat = isOpenAiCompat(call.apiBase)
  let items: SavedImage[]

  if (compat) {
    // 百炼 OpenAI-compatible gateway: image models hang off chat/completions.
    const body: Record<string, unknown> = {
      model: call.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: call.prompt }] }],
      parameters: { size: call.size, n },
      stream: false,
    }
    if (call.negativePrompt) {
      ;(body.parameters as Record<string, unknown>).negative_prompt = call.negativePrompt
    }
    const data = await requestJson(`${base}/chat/completions`, body, {
      headers: authHeaders(call.apiKey),
      signal: call.signal,
    })
    items = collectImages(data)
  } else {
    // Native DashScope: submit an async task, then poll for the results.
    const body: Record<string, unknown> = {
      model: call.model,
      input: { prompt: call.prompt },
      parameters: { size: call.size, n },
    }
    if (call.negativePrompt) {
      ;(body.parameters as Record<string, unknown>).negative_prompt = call.negativePrompt
    }
    const submitted = await requestJson(
      `${base}/api/v1/services/aigc/text2image/image-synthesis`,
      body,
      {
        headers: { ...authHeaders(call.apiKey), 'X-DashScope-Async': 'enable' },
        signal: call.signal,
      },
    )
    const taskId = (submitted as { output?: { task_id?: unknown } }).output?.task_id
    if (typeof taskId !== 'string') {
      throw new Error(`Qwen image task submission failed: ${JSON.stringify(submitted).slice(0, 300)}`)
    }

    let result: unknown
    let succeeded = false
    for (let elapsed = 0; elapsed < 120; elapsed += 2) {
      await sleep(2000, call.signal)
      result = await requestJson(`${base}/api/v1/tasks/${taskId}`, undefined, {
        method: 'GET',
        headers: authHeaders(call.apiKey),
        signal: call.signal,
      })
      const status = (result as { output?: { task_status?: unknown } }).output?.task_status
      if (status === 'SUCCEEDED') {
        succeeded = true
        break
      }
      if (status === 'FAILED') {
        const message = (result as { output?: { message?: unknown } }).output?.message
        throw new Error(String(message ?? 'unknown image task failure'))
      }
    }
    if (!succeeded) {
      throw new Error(`image task ${taskId} did not finish within 120s`)
    }
    const results = (result as { output?: { results?: Array<{ url?: unknown }> } }).output?.results ?? []
    items = results.flatMap(entry => (typeof entry?.url === 'string'
      ? [{ kind: 'url' as const, value: entry.url }]
      : []))
  }

  if (items.length === 0) {
    throw new Error('Qwen image API returned no images')
  }
  return saveImages(items, call.outputDir, call.signal)
}

async function saveImages(
  items: SavedImage[],
  outputDir: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const dir = resolve(outputDir)
  await mkdir(dir, { recursive: true })
  const stem = String(Date.now())
  const paths: string[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    if (!item) continue
    const content = item.kind === 'b64'
      ? Buffer.from(item.value, 'base64')
      : Buffer.from(await (await fetch(item.value, { signal })).arrayBuffer())
    const file = resolve(dir, `qwen_${stem}_${i}.png`)
    await writeFile(file, content)
    paths.push(file)
  }
  return paths
}
