import { z } from 'zod'
import type { ZodType } from 'zod'
import type { ChatMessage } from '../models/types'
import type { ChatResult, JobContext } from '../queue/scheduler'

/** Removes reasoning blocks some models put in their answer. */
export function stripThinking(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const close = t.toLowerCase().lastIndexOf('</think>')
  if (close !== -1) t = t.slice(close + 8)
  return t.replace(/^\s+/, '')
}

/** Prose from a model: no reasoning blocks, no code fences around the whole text, trimmed. */
export function cleanProse(text: string): string {
  let t = stripThinking(text).trim()
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t)
  if (fence) t = fence[1]!.trim()
  return unwrapJsonProse(t)
}

/**
 * Some models answer a plain-text request with a JSON object such as {"chapter": 1, "content": "..."}.
 * When the whole reply is one such object with a long text field, the prose is that field.
 */
export function unwrapJsonProse(t: string): string {
  if (!t.startsWith('{') || !t.endsWith('}')) return t
  try {
    const o: unknown = JSON.parse(t)
    if (o && typeof o === 'object' && !Array.isArray(o)) {
      for (const key of ['content', 'text', 'body', 'chapter_text', 'prose']) {
        const v = (o as Record<string, unknown>)[key]
        if (typeof v === 'string' && v.trim().length >= 200) return v.trim()
      }
    }
  } catch {
    /* not JSON: it is prose that happens to start with a brace */
  }
  return t
}

/** Pulls the first JSON object out of a reply, tolerating fences and chatter around it. */
export function extractJson(text: string): unknown {
  let t = stripThinking(text).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) t = fence[1]!.trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply')
  return JSON.parse(t.slice(start, end + 1))
}

export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

export interface JsonResult<T> {
  value: T
  chat: ChatResult
  cost: number
}

/**
 * Asks for JSON. Passes the schema to providers that support it. If the reply doesn't parse or validate,
 * asks once more with the error (a repair retry). If the provider rejects the schema, tries again without it.
 */
export async function chatJson<T>(
  ctx: JobContext,
  messages: ChatMessage[],
  schema: ZodType<T>,
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<JsonResult<T>> {
  let cost = 0
  const jsonSchema = jsonSchemaOf(schema)
  const ask = async (msgs: ChatMessage[], withSchema: boolean): Promise<ChatResult> => {
    const r = await ctx.chat({ messages: msgs, schema: withSchema ? jsonSchema : undefined, ...opts })
    cost += r.costUsd
    return r
  }
  let reply: ChatResult
  try {
    reply = await ask(messages, true)
  } catch (err) {
    if (ctx.signal.aborted || (err as Error).name === 'AbortError' || (err as Error).name === 'BudgetError' || /token limit/i.test((err as Error).message)) throw err
    reply = await ask(messages, false)
  }
  const tryParse = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      const parsed = schema.safeParse(extractJson(text))
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
  let parsed = tryParse(reply.text)
  if (parsed.ok) return { value: parsed.value, chat: reply, cost }
  const repair: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: reply.text.slice(0, 6000) },
    {
      role: 'user',
      content: `Your reply could not be used: ${parsed.error}.\nReply again with only one valid JSON object that matches the requested format. No explanations, no code fences.`
    }
  ]
  const second = await ask(repair, false)
  parsed = tryParse(second.text)
  if (parsed.ok) return { value: parsed.value, chat: second, cost }
  throw new Error(`the model did not return valid JSON twice: ${parsed.error}`)
}
