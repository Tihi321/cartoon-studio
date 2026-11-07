import { mkdir, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpHttpServer } from '../src/engine/mcp/http'
import { buildTools } from '../src/engine/mcp/tools'
import { makeEnv } from './helpers'
import type { TestEnv } from './helpers'

/** The MCP server over a real HTTP listen on a free loopback port: session, the ten core tools, auth, a client-task round trip, the static routes. */

let env: TestEnv | undefined
let server: McpHttpServer | undefined
const clients: Client[] = []
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined)
  await server?.stop()
  server = undefined
  await env?.cleanup()
  env = undefined
})

const CLIENT_PROVIDER = [{ id: 'client', kind: 'client' as const, local: true, concurrency: 8, models: ['claude-code'], vision: true }]

async function start(o: { token?: string; player?: string } = {}): Promise<McpHttpServer> {
  env = await makeEnv({ providers: CLIENT_PROVIDER, roles: { showrunner: ['client/claude-code'] } })
  server = new McpHttpServer({
    host: { tools: buildTools(env.engine.cts, { control: env.engine.mcpControl(), clientQueue: env.engine.clientQueue }) },
    port: 0,
    token: o.token,
    static: { previewDir: o.player, seriesRoot: path.join(env.dir, 'series') }
  })
  const st = await server.start()
  expect(st.running).toBe(true)
  return server
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined }))
  clients.push(client)
  return client
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }

/** A raw request with chosen headers (the SDK client always sends a good Host). */
function raw(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers } }, (res) => {
      let text = ''
      res.on('data', (d: Buffer) => (text += d.toString('utf8')))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }))
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => (await c.callTool({ name, arguments: args })).structuredContent as Record<string, unknown>

describe('MCP over HTTP', () => {
  it('session: lists exactly the ten core cts_ tools, calls one (an unknown series is an error result), reads the guide', async () => {
    const s = await start()
    const client = await connect(s.url()!)
    expect(client.getServerVersion()).toMatchObject({ name: 'cartoon-studio' })
    const names = (await client.listTools()).tools.map((t) => t.name).sort()
    expect(names).toEqual(['cts_client_tasks', 'cts_get_task', 'cts_pause_all', 'cts_release_task', 'cts_resume_all', 'cts_status', 'cts_stop_now', 'cts_studios_status', 'cts_submit_task', 'cts_wait'])
    expect(await call(client, 'cts_status')).toMatchObject({ series: [], clientTasks: { waiting: 0, leased: 0 } })
    expect((await client.callTool({ name: 'cts_status', arguments: { series: 'nope' } })).isError).toBe(true)
    const guide = await client.readResource({ uri: 'cartoon-studio://guide' })
    expect((guide.contents[0] as { text: string }).text).toMatch(/Cartoon Studio/)
    await s.stop()
    expect(s.getStatus()).toMatchObject({ running: false, url: null, sessions: 0 })
  })

  it('auth: refuses a wrong Host or Origin, a missing or wrong token and another path', async () => {
    const s = await start({ token: 's3cret' })
    const url = s.url()!
    const good = { host: `127.0.0.1:${new URL(url).port}`, authorization: 'Bearer s3cret' }
    expect((await raw('POST', url, good, INIT)).status).toBe(200)
    expect((await raw('POST', url, { ...good, host: 'evil.example:80' }, INIT)).status).toBe(403)
    expect((await raw('POST', url, { ...good, origin: 'http://evil.example' }, INIT)).status).toBe(403)
    expect((await raw('POST', url, { host: good.host }, INIT)).status).toBe(401)
    expect((await raw('POST', url, { host: good.host, authorization: 'Bearer nope' }, INIT)).status).toBe(401)
    expect((await raw('POST', url.replace('/mcp', '/other'), good, INIT)).status).toBe(404)
    await expect(connect(url)).rejects.toThrow()
    expect((await (await connect(url, 's3cret')).listTools()).tools).toHaveLength(10)
  })

  it('client tasks: a queued model call is taken, filtered by client and series, answered and released over MCP', async () => {
    const s = await start()
    const c = await connect(s.url()!)
    const queue = env!.engine.clientQueue
    const marker = 'UNIQUE-MARKER-' + 'x'.repeat(200)
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }
    queue.add({ client: 'antigravity', messages: [{ role: 'user', content: 'hi' }] }, { job: 'p--pitches--all--r1', role: 'showrunner', task: 'pitches', book: 'p' })
    queue.add({ messages: [{ role: 'system', content: 'You are a tester.' }, { role: 'user', content: marker }], schema }, { job: 'p--script--all--r1', role: 'writer', task: 'script', book: 'p', unit: 'all' })
    expect(await call(c, 'cts_client_tasks')).toMatchObject({ waiting: 2, leased: 0 })
    expect(await call(c, 'cts_get_task', { series: 'other' })).toMatchObject({ none: true })
    // without a client only claude-code tasks are handed out; the antigravity one waits for its own client
    const got = await call(c, 'cts_get_task', { series: 'p', task: 'script' })
    expect(got).toMatchObject({ taskId: expect.stringMatching(/--script--all--r1#1$/), meta: { role: 'writer', series: 'p' }, turns: 'single', system: 'You are a tester.', user: marker, leaseMinutes: 30 })
    expect(JSON.stringify(got).split(marker)).toHaveLength(2) // the user text is carried once
    expect(await call(c, 'cts_get_task')).toEqual({ none: true, waiting: 1 })
    expect(await call(c, 'cts_get_task', { client: 'antigravity' })).toMatchObject({ meta: { client: 'antigravity' } })
    const bad = await call(c, 'cts_submit_task', { taskId: got.taskId, text: 'no' })
    expect(bad.accepted).toBe(false)
    expect(await call(c, 'cts_release_task', { taskId: got.taskId })).toEqual({ released: true })
    const again = await call(c, 'cts_get_task', { task: 'script' })
    expect(await call(c, 'cts_submit_task', { taskId: again.taskId, text: JSON.stringify({ ok: true }) })).toEqual({ accepted: true })
  })

  it('static routes: /preview/ serves the player folder, /files/<series>/ only files under series/, nothing escapes', async () => {
    const player = path.join((await import('node:os')).tmpdir(), `cts-player-${Date.now()}`)
    await mkdir(player, { recursive: true })
    await writeFile(path.join(player, 'index.html'), '<!doctype html><title>player</title>')
    const s = await start({ player })
    const base = new URL(s.url()!)
    const host = { host: `127.0.0.1:${base.port}` }
    const get = (p: string, h: Record<string, string> = {}) => raw('GET', `http://127.0.0.1:${base.port}${p}`, { ...host, ...h })
    await mkdir(path.join(env!.dir, 'series', 'pilot', 'clips'), { recursive: true })
    await writeFile(path.join(env!.dir, 'series', 'pilot', 'clips', 'intro.mp4'), '0123456789')
    await writeFile(path.join(env!.dir, 'config', 'secret.txt'), 'nope')

    const page = await get('/preview/')
    expect(page).toMatchObject({ status: 200 })
    expect(page.text).toContain('<title>player</title>')
    expect(page.headers['content-type']).toMatch(/text\/html/)
    const clip = await get('/files/pilot/clips/intro.mp4')
    expect(clip).toMatchObject({ status: 200, text: '0123456789' })
    expect(clip.headers['content-type']).toBe('video/mp4')
    expect(await get('/files/pilot/clips/intro.mp4', { range: 'bytes=2-4' })).toMatchObject({ status: 206, text: '234' })
    // read-only and confined
    expect((await raw('POST', `http://127.0.0.1:${base.port}/files/pilot/clips/intro.mp4`, host, {})).status).toBe(405)
    for (const p of ['/files/pilot/../../config/secret.txt', '/files/pilot/%2e%2e/%2e%2e/config/secret.txt', '/files/pilot/..%5C..%5Cconfig%5Csecret.txt', '/files/config/secret.txt', '/files/Pilot/clips/intro.mp4', '/files/pilot', '/preview/../config/secret.txt', '/preview/%2e%2e/config/secret.txt']) {
      expect((await get(p)).status, p).toBe(404)
    }
    expect((await get('/preview/', { host: 'evil.example:80' })).status).toBe(403)
  })

  it('reports a port that is already in use instead of throwing', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()))
    const port = (blocker.address() as net.AddressInfo).port
    try {
      env = await makeEnv()
      const seen: unknown[] = []
      server = new McpHttpServer({ host: { tools: buildTools(env.engine.cts) }, port, onStatus: (st) => seen.push(st) })
      expect(await server.start()).toMatchObject({ running: false, url: null, error: `Port ${port} is already in use.` })
      expect(seen).toHaveLength(1)
    } finally {
      await new Promise((r) => blocker.close(r))
    }
  })
})
