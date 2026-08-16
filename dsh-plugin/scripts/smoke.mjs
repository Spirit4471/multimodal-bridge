// Harness-free smoke test for the dsh-multimodal-bridge Qwen client.
//
// Build first:  npm run build          (produces lib/)
//
// Vision:       node scripts/smoke.mjs <imagePath> ["question"]
// Generate:     node scripts/smoke.mjs gen "<prompt>" [size] [n]
// Edit (i2i):   node scripts/smoke.mjs gen "<edit instruction>" [size] [n] <inputImagePath>
// Video (t2v):  node scripts/smoke.mjs vid "<prompt>" [size]
//
// Env: QWEN_DASHSCOPE_API_KEY (or VISION_API_KEY / GENERATE_API_KEY),
//      QWEN_API_BASE (default https://dashscope.aliyuncs.com),
//      VISION_MODEL / GENERATE_MODEL / VIDEO_MODEL overrides.

import { callVision, callGenerate, callVideo, callChat, callTts, defaultSizeFor } from '../lib/index.js'

const apiKey = process.env.QWEN_DASHSCOPE_API_KEY || ''
const apiBase = process.env.QWEN_API_BASE || 'https://dashscope.aliyuncs.com'
const mode = process.argv[2] ?? ''

if (mode === 'gen') {
  const prompt = process.argv[3]
  if (!prompt) {
    console.error('usage: node scripts/smoke.mjs gen "<prompt>" [size] [n] [inputImagePath]')
    process.exit(2)
  }
  const size = process.argv[4]
    ?? defaultSizeFor(process.env.GENERATE_MODEL || 'qwen-image-2.0')
  const n = Number.parseInt(process.argv[5] ?? '1', 10) || 1
  const imagePath = process.argv[6]
  const key = process.env.GENERATE_API_KEY || apiKey
  if (!key) {
    console.error('set QWEN_DASHSCOPE_API_KEY or GENERATE_API_KEY')
    process.exit(2)
  }
  const paths = await callGenerate({
    prompt,
    size,
    n,
    negativePrompt: '',
    model: process.env.GENERATE_MODEL || 'qwen-image-2.0',
    apiKey: key,
    apiBase,
    outputDir: process.env.OUTPUT_DIR || 'generated',
    imagePath,
  })
  console.log(paths.join('\n'))
} else if (mode === 'vid') {
  const prompt = process.argv[3]
  if (!prompt) {
    console.error('usage: node scripts/smoke.mjs vid "<prompt>" [size]')
    process.exit(2)
  }
  const size = process.argv[4] ?? '1280*720'
  const imagePath = process.argv[5]
  const key = process.env.GENERATE_API_KEY || apiKey
  if (!key) {
    console.error('set QWEN_DASHSCOPE_API_KEY or GENERATE_API_KEY')
    process.exit(2)
  }
  const video = await callVideo({
    prompt,
    size,
    model: process.env.VIDEO_MODEL || (imagePath ? 'wanx2.1-i2v-turbo' : 'wanx2.1-t2v-turbo'),
    apiKey: key,
    outputDir: process.env.OUTPUT_DIR || 'generated',
    imagePath,
  })
  console.log(video)
} else if (mode === 'chat') {
  const prompt = process.argv[3]
  if (!prompt) {
    console.error('usage: node scripts/smoke.mjs chat "<prompt>" ["system"]')
    process.exit(2)
  }
  const key = apiKey
  if (!key) {
    console.error('set QWEN_DASHSCOPE_API_KEY')
    process.exit(2)
  }
  const answer = await callChat({
    prompt,
    system: process.argv[4],
    model: process.env.CHAT_MODEL || 'qwen3.7-max',
    apiKey: key,
    apiBase,
  })
  console.log(answer)
} else if (mode === 'tts') {
  const text = process.argv[3]
  if (!text) {
    console.error('usage: node scripts/smoke.mjs tts "<text>" [voice]')
    process.exit(2)
  }
  const key = apiKey
  if (!key) {
    console.error('set QWEN_DASHSCOPE_API_KEY')
    process.exit(2)
  }
  const audio = await callTts({
    text,
    voice: process.argv[4],
    model: process.env.TTS_MODEL || 'qwen-tts',
    apiKey: key,
    outputDir: process.env.OUTPUT_DIR || 'generated',
  })
  console.log(audio)
} else {
  const imagePath = process.argv[2]
  if (!imagePath) {
    console.error('usage: node scripts/smoke.mjs <imagePath> ["question"]')
    process.exit(2)
  }
  const question = process.argv[3] ?? 'Describe this image in detail.'
  const key = process.env.VISION_API_KEY || apiKey
  if (!key) {
    console.error('set QWEN_DASHSCOPE_API_KEY or VISION_API_KEY')
    process.exit(2)
  }
  const answer = await callVision({
    imagePath,
    prompt: question,
    model: process.env.VISION_MODEL || 'qwen-vl-max',
    apiKey: key,
    apiBase,
  })
  console.log(answer)
}
