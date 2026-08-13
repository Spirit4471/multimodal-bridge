// Harness-free smoke test for the dsh-multimodal-bridge Qwen client.
//
// Build first:  npm run build          (produces lib/)
//
// Vision:       node scripts/smoke.mjs <imagePath> ["question"]
// Generate:     node scripts/smoke.mjs gen "<prompt>" [size] [n]
//
// Env: QWEN_DASHSCOPE_API_KEY (or VISION_API_KEY / GENERATE_API_KEY),
//      QWEN_API_BASE (default https://dashscope.aliyuncs.com),
//      VISION_MODEL / GENERATE_MODEL overrides.

import { callVision, callGenerate, defaultSizeFor } from '../lib/index.js'

const apiKey = process.env.QWEN_DASHSCOPE_API_KEY || ''
const apiBase = process.env.QWEN_API_BASE || 'https://dashscope.aliyuncs.com'
const mode = process.argv[2] ?? ''

if (mode === 'gen') {
  const prompt = process.argv[3]
  if (!prompt) {
    console.error('usage: node scripts/smoke.mjs gen "<prompt>" [size] [n]')
    process.exit(2)
  }
  const size = process.argv[4]
    ?? defaultSizeFor(process.env.GENERATE_MODEL || 'qwen-image-2.0')
  const n = Number.parseInt(process.argv[5] ?? '1', 10) || 1
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
  })
  console.log(paths.join('\n'))
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
