import { afterEach, describe, expect, it, vi } from 'vitest'
import { freeMemory } from '../src/engine/comfy/client'

describe('freeMemory', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('treats ComfyUI\'s empty 200 reply as success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    await expect(freeMemory('http://a:8188')).resolves.toBeUndefined()
  })

  it('reports the status of a failed reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(freeMemory('http://a:8188')).rejects.toThrow('HTTP 500')
  })
})
