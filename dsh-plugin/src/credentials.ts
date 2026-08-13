import type { Context } from '@deepseek-ai/cordis'

/**
 * Credential resolution for the Qwen tools.
 *
 * Precedence (highest wins):
 *   1. `config.apiKey` — explicit cordis config. Works everywhere, but it is
 *      plaintext configuration; prefer the layers below for secrets.
 *   2. The mounted `ctx.credentials` provider (the DSH credential seam,
 *      `@deepseek-ai/dsh-credentials`), resolving the per-tool reference and
 *      then the shared `QWEN_DASHSCOPE_API_KEY`. The provider's own layers are
 *      launching environment > `~/.dsh/.credentials.yaml` > `.env`, and values
 *      are re-resolved per operation so a rotation reaches the next call.
 *   3. `process.env` — direct fallback for compositions without a provider.
 *
 * The provider is consumed opportunistically through `ctx.get('credentials')`
 * (the same pattern the tool registry uses for the approval seam), so the
 * plugin still loads in compositions that mount no credential provider. The
 * access is structural rather than a typed import so this package needs no
 * dependency on `@deepseek-ai/dsh-credentials`; the shape mirrors
 * `CredentialProvider.resolve(ref: string)` from its Service Definition.
 */

interface ResolvedCredential {
  value?: unknown
  source?: unknown
}

interface CredentialsLike {
  resolve(ref: string): Promise<ResolvedCredential | undefined>
}

/** Opportunistic, structurally typed read of the credential seam. */
export function getCredentialsProvider(ctx: Context): CredentialsLike | undefined {
  return (ctx as unknown as { get(name: string): unknown }).get('credentials') as
    | CredentialsLike
    | undefined
}

export function hasCredentialsProvider(ctx: Context): boolean {
  return getCredentialsProvider(ctx) !== undefined
}

async function resolveViaProvider(
  provider: CredentialsLike,
  ref: string,
): Promise<string> {
  const hit = await provider.resolve(ref)
  if (hit && typeof hit.value === 'string' && hit.value) return hit.value
  return ''
}

/**
 * Resolve the effective Qwen API key for one tool call.
 * @param ctx - the plugin context (read per call, never cached across calls).
 * @param configValue - the `apiKey` config field (explicit config wins).
 * @param preferredRef - per-tool reference (`VISION_API_KEY` / `GENERATE_API_KEY`).
 */
export async function resolveApiKey(
  ctx: Context,
  configValue: string,
  preferredRef: string,
): Promise<string> {
  if (configValue) return configValue
  const provider = getCredentialsProvider(ctx)
  if (provider) {
    return (await resolveViaProvider(provider, preferredRef))
      || (await resolveViaProvider(provider, 'QWEN_DASHSCOPE_API_KEY'))
  }
  return process.env[preferredRef] || process.env.QWEN_DASHSCOPE_API_KEY || ''
}
