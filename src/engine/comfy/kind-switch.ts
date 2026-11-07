import path from 'node:path'
import { fetchWithDeadline, firstReachableLane, loadComfyConfig } from './client'

/**
 * ComfyUI memory between voice and image jobs (HUB-29 decision 11). A stale Higgs/OmniVoice state broke the Qwen image runs in the bake-off, so
 * whenever the kind of work sent to ComfyUI changes (voice -> image or image -> voice) the models are unloaded first
 * (`POST /free {unload_models: true, free_memory: true}`). Every module that sends work to ComfyUI calls `comfyKindSwitch(kind, ...)` right before
 * its first request of a batch: the voice provider (CTS-06) with `'voice'`, the image providers and the rig/background steps with `'image'`.
 *
 * The last kind is remembered per lane in this process. A lane never seen before counts as "unknown" and is freed once, because ComfyUI may hold
 * a state from an earlier session. A ComfyUI that does not answer is not an error here: the job that follows reports that itself.
 */

export type ComfyJobKind = 'voice' | 'image' | 'music'

const lastKind = new Map<string, ComfyJobKind>()

/** `POST /free {unload_models: true, free_memory: true}`. ComfyUI answers with an empty body, so this does not parse one (`client.ts freeMemory` does and throws). */
async function postFree(lane: string): Promise<void> {
  const res = await fetchWithDeadline(`${lane}/free`, { method: 'POST', timeoutMs: 30_000, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) })
  if (!res.ok) throw new Error(`POST ${lane}/free answered ${res.status}`)
}

export interface KindSwitchOptions {
  /** The data folder (`config/comfy.md` names the lanes). Not needed with `lane`. */
  dataDir?: string
  /** The ComfyUI lane to use; default: the first reachable one of `config/comfy.md`. */
  lane?: string
  log?: (message: string) => void
  /** Tests: replaces `POST /free`. */
  free?: (lane: string) => Promise<unknown>
}

export interface KindSwitchResult {
  lane: string | null
  /** The kind before this call (null: unknown, first use of the lane in this process). */
  from: ComfyJobKind | null
  /** ComfyUI was asked to free its memory. */
  freed: boolean
  /** Why nothing was freed (the lane did not answer, or the kind did not change). */
  note?: string
}

export async function comfyKindSwitch(kind: ComfyJobKind, o: KindSwitchOptions = {}): Promise<KindSwitchResult> {
  let lane = o.lane ?? null
  if (!lane) {
    const config = await loadComfyConfig(path.join(o.dataDir ?? '', 'config', 'comfy.md')).catch(() => null)
    lane = config ? await firstReachableLane(config) : null
  }
  if (!lane) return { lane: null, from: null, freed: false, note: 'ComfyUI does not answer: nothing to free' }
  const from = lastKind.get(lane) ?? null
  if (from === kind) return { lane, from, freed: false, note: `still ${kind} work` }
  try {
    await (o.free ?? (postFree))(lane)
    lastKind.set(lane, kind)
    o.log?.(`comfyui: freed memory (${from ?? 'unknown'} -> ${kind})`)
    return { lane, from, freed: true }
  } catch (e) {
    // the next call tries again: the kind is not recorded
    return { lane, from, freed: false, note: `could not free ComfyUI memory: ${(e as Error).message}` }
  }
}

/** Frees ComfyUI memory now and forgets the last kind (the end of a probe or a batch: the next call frees again). */
export async function comfyFreeNow(o: KindSwitchOptions = {}): Promise<KindSwitchResult> {
  let lane = o.lane ?? null
  if (!lane) {
    const config = await loadComfyConfig(path.join(o.dataDir ?? '', 'config', 'comfy.md')).catch(() => null)
    lane = config ? await firstReachableLane(config) : null
  }
  if (!lane) return { lane: null, from: null, freed: false, note: 'ComfyUI does not answer: nothing to free' }
  const from = lastKind.get(lane) ?? null
  try {
    await (o.free ?? (postFree))(lane)
    lastKind.delete(lane)
    return { lane, from, freed: true }
  } catch (e) {
    return { lane, from, freed: false, note: `could not free ComfyUI memory: ${(e as Error).message}` }
  }
}

/** Forgets the remembered kinds (tests). */
export function resetComfyKinds(): void {
  lastKind.clear()
}
