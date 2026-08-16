import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { imageToDataUri, imageToEditDataUri } from './image.js'

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
  /** Optional local input image for image-to-image (editing) requests. */
  imagePath?: string
  signal?: AbortSignal
}

export interface VideoCall {
  prompt: string
  size: string
  model: string
  apiKey: string
  outputDir: string
  /** Optional local first-frame image for image-to-video generation. */
  imagePath?: string
  signal?: AbortSignal
}

export interface ChatCall {
  prompt: string
  system?: string
  model: string
  apiKey: string
  apiBase: string
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
    throw new Error(`Qwen API error ${resp.status} (${url}): ${snippet}`)
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
 * model-level 403 AccessDenied, the cryptic "url error", empty responses)
 * qualify; key authentication failures (401) do not — no other model can fix
 * the key.
 */
export function isFallbackableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  if (/Qwen API error (401)/.test(message)) return false
  return /Qwen API error (400|403|404)|AccessDenied|no images|url error|model not|not enabled|not exist|not found/i.test(message)
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

  const pushUrl = (value: unknown) => {
    if (typeof value === 'string'
      && (value.startsWith('http://') || value.startsWith('https://') || value.startsWith('data:'))) {
      items.push({ kind: 'url', value })
    }
  }

  // DashScope style: output.choices[].message.content = [{ image: url }, ...]
  // Some gateways reply with OpenAI-style parts: { image_url: { url } } or a
  // plain { url }, so accept all of them.
  const output = (data as {
    output?: { choices?: Array<{ message?: { content?: unknown } }>; results?: Array<{ url?: unknown }> }
  }).output
  for (const choice of output?.choices ?? []) {
    const content = choice?.message?.content
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue
        const record = part as Record<string, unknown>
        pushUrl(record.image)
        pushUrl(record.url)
        const imageUrl = record.image_url
        if (typeof imageUrl === 'object' && imageUrl !== null) {
          pushUrl((imageUrl as Record<string, unknown>).url)
        } else {
          pushUrl(imageUrl)
        }
      }
    }
  }
  for (const entry of output?.results ?? []) {
    pushUrl(entry?.url)
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
 *
 * Image-to-image (`imagePath` set) uses two channels: the gateway's chat path
 * first (some workspaces route it), then the native DashScope
 * multimodal-generation endpoint — proven to accept workspace keys and to
 * perform text-guided image editing (probed 2026-08-16).
 */
export async function callGenerate(call: GenerateCall): Promise<string[]> {
  if (!call.apiKey) {
    throw new Error('missing Qwen API key: set `apiKey` in the plugin config or QWEN_DASHSCOPE_API_KEY / GENERATE_API_KEY in the environment')
  }
  const n = Math.min(Math.max(1, Math.trunc(call.n) || 1), 4)
  const base = trimBase(call.apiBase)
  const compat = isOpenAiCompat(call.apiBase)
  let items: SavedImage[] = []
  let lastResponse: unknown

  if (call.imagePath) {
    const editUri = await imageToEditDataUri(call.imagePath)
    const nativeBase = compat ? 'https://dashscope.aliyuncs.com' : base
    if (compat) {
      try {
        lastResponse = await postChatGenerate(call, editUri, base, n)
        items = collectImages(lastResponse)
      } catch (error) {
        if (!isFallbackableError(error)) throw error
        lastResponse = await postNativeMultimodal(call, editUri, nativeBase)
        items = collectImages(lastResponse)
      }
    } else {
      lastResponse = await postNativeMultimodal(call, editUri, nativeBase)
      items = collectImages(lastResponse)
    }
  } else if (compat) {
    // 百炼 OpenAI-compatible gateway: image models hang off chat/completions.
    lastResponse = await postChatGenerate(call, undefined, base, n)
    items = collectImages(lastResponse)
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
    lastResponse = result
    const results = (result as { output?: { results?: Array<{ url?: unknown }> } }).output?.results ?? []
    items = results.flatMap(entry => (typeof entry?.url === 'string'
      ? [{ kind: 'url' as const, value: entry.url }]
      : []))
  }

  if (items.length === 0) {
    const preview = JSON.stringify(lastResponse).slice(0, 800)
    throw new Error(`Qwen image API returned no images. Response preview: ${preview}`)
  }
  return saveImages(items, call.outputDir, call.signal)
}

/** Gateway chat/completions generation (text-only, or image+text when given). */
async function postChatGenerate(
  call: GenerateCall,
  imageUri: string | undefined,
  base: string,
  n: number,
): Promise<unknown> {
  const content: unknown[] = []
  if (imageUri) {
    content.push({ type: 'image_url', image_url: { url: imageUri } })
  }
  content.push({ type: 'text', text: call.prompt })
  const body: Record<string, unknown> = {
    model: call.model,
    messages: [{ role: 'user', content }],
    parameters: { size: call.size, n },
    stream: false,
  }
  if (call.negativePrompt) {
    ;(body.parameters as Record<string, unknown>).negative_prompt = call.negativePrompt
  }
  return requestJson(`${base}/chat/completions`, body, {
    headers: authHeaders(call.apiKey),
    signal: call.signal,
  })
}

/**
 * Native DashScope multimodal-generation: the image-editing channel that
 * accepts workspace keys and returns the result synchronously.
 */
async function postNativeMultimodal(
  call: GenerateCall,
  imageUri: string,
  base: string,
): Promise<unknown> {
  const content: Array<Record<string, unknown>> = [
    { image: imageUri },
    { text: call.prompt },
  ]
  // NOTE: no `parameters` block — probed 2026-08-16: the native multimodal
  // endpoint rejects qwen-image edit requests that carry `parameters` with a
  // cryptic "content parameter's length invalid". Output size is
  // model-determined (1024x1024 for qwen-image-2.0 edits).
  const body: Record<string, unknown> = {
    model: call.model,
    input: { messages: [{ role: 'user', content }] },
  }
  return requestJson(
    `${base}/api/v1/services/aigc/multimodal-generation/generation`,
    body,
    {
      headers: authHeaders(call.apiKey),
      signal: call.signal,
    },
  )
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

/**
 * Text-to-video through the native DashScope async video-synthesis API
 * (probed 2026-08-16: workspace keys are accepted, models wanx2.1-t2v-turbo /
 * wan2.6-t2v / wan2.7-t2v verified). Submits an async task, polls until it
 * finishes (up to ~10 minutes), downloads the result and saves it as an MP4.
 * Returns the absolute path of the saved video.
 */
export async function callVideo(call: VideoCall): Promise<string> {
  if (!call.apiKey) {
    throw new Error('missing Qwen API key: set `apiKey` in the plugin config or QWEN_DASHSCOPE_API_KEY / GENERATE_API_KEY in the environment')
  }
  const base = 'https://dashscope.aliyuncs.com'
  // I2V: a local first frame is accepted as a data-URI `img_url`
  // (probed 2026-08-16: wanx2.1-i2v-turbo accepts data URIs, but the backend
  // intermittently fails with a TypeError/NoneType in its interpolation step
  // — retried below).
  const input: Record<string, unknown> = { prompt: call.prompt }
  if (call.imagePath) {
    input.img_url = await imageToEditDataUri(call.imagePath)
  }

  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await submitVideoTaskAndDownload(call, base, input)
    } catch (error) {
      lastError = error
      if (call.signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      // Known flaky backend failure (wanx interpolation cache miss): retry
      // the whole submission. Anything else propagates immediately.
      if (!/NoneType|TypeError|cache_file|expected str, bytes/i.test(message)) throw error
      await sleep(2000, call.signal)
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError))
}

/** One submit → poll → download cycle for a video task. */
async function submitVideoTaskAndDownload(
  call: VideoCall,
  base: string,
  input: Record<string, unknown>,
): Promise<string> {
  const submitted = await requestJson(
    `${base}/api/v1/services/aigc/video-generation/video-synthesis`,
    {
      model: call.model,
      input,
      parameters: { size: call.size },
    },
    {
      headers: { ...authHeaders(call.apiKey), 'X-DashScope-Async': 'enable' },
      signal: call.signal,
    },
  )
  const taskId = (submitted as { output?: { task_id?: unknown } }).output?.task_id
  if (typeof taskId !== 'string') {
    throw new Error(`Qwen video task submission failed: ${JSON.stringify(submitted).slice(0, 300)}`)
  }

  let result: unknown
  for (let elapsed = 0; elapsed < 600; elapsed += 5) {
    await sleep(5000, call.signal)
    result = await requestJson(`${base}/api/v1/tasks/${taskId}`, undefined, {
      method: 'GET',
      headers: authHeaders(call.apiKey),
      signal: call.signal,
    })
    const status = (result as { output?: { task_status?: unknown } }).output?.task_status
    if (status === 'SUCCEEDED') break
    if (status === 'FAILED') {
      const message = (result as { output?: { message?: unknown } }).output?.message
      throw new Error(String(message ?? 'unknown video task failure'))
    }
  }
  const status = (result as { output?: { task_status?: unknown } }).output?.task_status
  if (status !== 'SUCCEEDED') {
    throw new Error(`video task ${taskId} did not finish within 600s`)
  }
  const videoUrl = (result as { output?: { video_url?: unknown } }).output?.video_url
  if (typeof videoUrl !== 'string') {
    throw new Error(`video task ${taskId} succeeded but returned no video_url: ${JSON.stringify(result).slice(0, 300)}`)
  }

  const dir = resolve(call.outputDir)
  await mkdir(dir, { recursive: true })
  const resp = await fetch(videoUrl, { signal: call.signal })
  if (!resp.ok) {
    throw new Error(`failed to download video: HTTP ${resp.status}`)
  }
  const file = resolve(dir, `qwen_${String(Date.now())}_video.mp4`)
  await writeFile(file, Buffer.from(await resp.arrayBuffer()))
  return file
}

/**
 * Text-only LLM consultation (second opinion / rebuttal / verification).
 * Uses the gateway chat path when apiBase is a compatible gateway, or the
 * native multimodal-generation endpoint (which serves text-only Qwen LLMs)
 * otherwise. Returns the model's text answer.
 */
export async function callChat(call: ChatCall): Promise<string> {
  if (!call.apiKey) {
    throw new Error('missing Qwen API key: set `apiKey` in the plugin config or QWEN_DASHSCOPE_API_KEY in the environment')
  }
  const base = trimBase(call.apiBase)
  const compat = isOpenAiCompat(call.apiBase)
  const messages = [
    ...(call.system ? [{ role: 'system', content: call.system }] : []),
    { role: 'user', content: call.prompt },
  ]
  if (compat) {
    const data = await requestJson(`${base}/chat/completions`, {
      model: call.model,
      messages,
      stream: false,
    }, {
      headers: authHeaders(call.apiKey),
      signal: call.signal,
    })
    const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content
    if (typeof content === 'string') return content
    throw new Error(`unexpected chat response: ${JSON.stringify(data).slice(0, 300)}`)
  }
  const data = await requestJson(
    `${base}/api/v1/services/aigc/multimodal-generation/generation`,
    {
      model: call.model,
      input: {
        messages: messages.map(message => ({
          role: message.role,
          content: [{ text: message.content }],
        })),
      },
    },
    {
      headers: authHeaders(call.apiKey),
      signal: call.signal,
    },
  )
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
  throw new Error(`unexpected chat response: ${JSON.stringify(data).slice(0, 300)}`)
}

export interface TtsCall {
  text: string
  voice?: string
  model: string
  apiKey: string
  outputDir: string
  signal?: AbortSignal
}

/**
 * Text-to-speech through the native DashScope multimodal-generation endpoint
 * (probed 2026-08-16: model `qwen-tts` with `input.text` returns
 * `output.audio.url`, a WAV on OSS). Downloads the audio and saves it as a
 * local .wav file; returns the absolute path.
 */
export async function callTts(call: TtsCall): Promise<string> {
  if (!call.apiKey) {
    throw new Error('missing Qwen API key: set `apiKey` in the plugin config or QWEN_DASHSCOPE_API_KEY in the environment')
  }
  const base = 'https://dashscope.aliyuncs.com'
  const body: Record<string, unknown> = {
    model: call.model,
    input: { text: call.text },
  }
  if (call.voice) {
    body.parameters = { voice: call.voice }
  }
  const data = await requestJson(
    `${base}/api/v1/services/aigc/multimodal-generation/generation`,
    body,
    {
      headers: authHeaders(call.apiKey),
      signal: call.signal,
    },
  )
  const audioUrl = (data as { output?: { audio?: { url?: unknown } } }).output?.audio?.url
  if (typeof audioUrl !== 'string') {
    throw new Error(`TTS returned no audio url: ${JSON.stringify(data).slice(0, 300)}`)
  }
  const dir = resolve(call.outputDir)
  await mkdir(dir, { recursive: true })
  const resp = await fetch(audioUrl, { signal: call.signal })
  if (!resp.ok) {
    throw new Error(`failed to download audio: HTTP ${resp.status}`)
  }
  const file = resolve(dir, `qwen_${String(Date.now())}_tts.wav`)
  await writeFile(file, Buffer.from(await resp.arrayBuffer()))
  return file
}
