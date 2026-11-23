import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { defaultProbe } from '../src/engine/studios/autostart'
import type { RegistryEntry } from '../src/engine/studios/autostart'

// Gufo 8081, recorded 2026-11-23 (creative-hub HUB-44 K8); the 503 body is llama-server's "Loading model" answer, assumed for Gufo.
const GUFO_HEALTH = '{"status":"ok"}'
const GUFO_NOT_FOUND = '{"error":{"message":"no route for this path","type":"invalid_request_error","code":"not_found"}}'
const GUFO_MODELS = '{"object":"list","data":[{"id":"Qwen3.8-27B","object":"model","created":1795421041,"owned_by":"gufo","context_length":32768,"architecture":{"input_modalities":["text","image"]}}]}'
const GUFO_LOADING = '{"error":{"code":503,"message":"Loading model","type":"unavailable_error"}}'

describe('ComfyUI and the local model servers', () => {
  it('asks Gufo on its /health: another program on 8081 does not hold ComfyUI back (HUB-44 P-26)', async () => {
    let mode: 'other' | 'ok' | 'loading' | 'image' | 'llama' = 'other'
    const server = http.createServer((req, res) => {
      const send = (status: number, body: string, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type })
        res.end(body)
      }
      if (mode === 'other') return send(200, 'hello', 'text/plain')
      if (req.url === '/health') return mode === 'ok' ? send(200, GUFO_HEALTH) : mode === 'loading' ? send(503, GUFO_LOADING) : send(404, GUFO_NOT_FOUND)
      if (req.url === '/v1/models') return send(200, mode === 'image' ? GUFO_MODELS : GUFO_MODELS.replace('"gufo"', '"llamacpp"'))
      send(404, GUFO_NOT_FOUND)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const gufo = { id: 'gufo', port: (server.address() as AddressInfo).port } as RegistryEntry
    try {
      expect(await defaultProbe(gufo), 'another program answering 200 text').toBe(false)
      mode = 'ok'
      expect(await defaultProbe(gufo), 'the recorded /health').toBe(true)
      mode = 'loading'
      expect(await defaultProbe(gufo), 'a model loading (503 JSON)').toBe(true)
      mode = 'image'
      expect(await defaultProbe(gufo), 'no /health, /v1/models owned by gufo').toBe(true)
      mode = 'llama'
      expect(await defaultProbe(gufo), 'no /health, /v1/models of another server').toBe(false)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(await defaultProbe(gufo), 'nothing on the port').toBe(false)
  })
})
