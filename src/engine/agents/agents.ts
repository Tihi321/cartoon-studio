import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseMdWith } from '../../shared/md'
import { agentSchema } from '../../shared/schemas'
import type { AgentFrontmatter } from '../../shared/schemas'
import { readMd, writeMd } from '../store/atomic'

export interface AgentDef {
  /** File name without `.md`, for example `writer-mara-quill`. */
  id: string
  file: string
  data: AgentFrontmatter
  /** The persona: the body of the agent file. */
  body: string
}

export const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

/** Agents are files in agents/. This class keeps them in memory and writes changes back to the files. */
export class AgentStore {
  private agents = new Map<string, AgentDef>()

  constructor(private readonly dataDir: string) {}

  get dir(): string {
    return path.join(this.dataDir, 'agents')
  }
  fileFor(id: string): string {
    return path.join(this.dir, `${id}.md`)
  }

  list(): AgentDef[] {
    return [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id))
  }
  get(id: string): AgentDef | undefined {
    return this.agents.get(id)
  }

  /** Loads every agent file. Invalid files are reported and skipped. */
  async loadAll(onError?: (file: string, err: Error) => void): Promise<void> {
    let names: string[] = []
    try {
      names = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.md'))
    } catch {
      /* no agents folder yet */
    }
    const next = new Map<string, AgentDef>()
    for (const n of names) {
      const id = n.slice(0, -3)
      try {
        next.set(id, await this.parse(id))
      } catch (err) {
        onError?.(path.join(this.dir, n), err as Error)
        const old = this.agents.get(id)
        if (old) next.set(id, old)
      }
    }
    this.agents = next
  }

  /** Reloads one file after a change on disk. Returns the new definition, or undefined when the file is gone. */
  async reloadFile(id: string): Promise<AgentDef | undefined> {
    try {
      const def = await this.parse(id)
      this.agents.set(id, def)
      return def
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.agents.delete(id)
        return undefined
      }
      throw err
    }
  }

  private async parse(id: string): Promise<AgentDef> {
    const file = this.fileFor(id)
    const text = await fs.readFile(file, 'utf8')
    const doc = parseMdWith(text, agentSchema, file)
    return { id, file, data: doc.data, body: doc.body }
  }

  /** Hire: writes a new agent file. */
  async hire(input: { role: string; name?: string; model?: string | null; focus?: string[]; pin?: string | null; persona?: string }): Promise<AgentDef> {
    const name = input.name?.trim() || `${input.role} ${this.list().filter((a) => a.data.role === input.role).length + 1}`
    const base = `${input.role}-${slug(name)}`
    let id = base
    for (let i = 2; this.agents.has(id) || (await exists(this.fileFor(id))); i++) id = `${base}-${i}`
    const data: AgentFrontmatter = {
      kind: 'agent',
      role: input.role,
      name,
      model: input.model ?? null,
      focus: input.focus ?? [],
      pin: input.pin ?? null,
      max_parallel: 1,
      paused: false
    }
    const body = input.persona ?? `\nYou are ${name}, working as ${input.role}. Hired from the UI: edit this text to change how you work.\n`
    await writeMd(this.fileFor(id), data, body)
    const def: AgentDef = { id, file: this.fileFor(id), data, body }
    this.agents.set(id, def)
    return def
  }

  /** Changes frontmatter fields of an agent file, keeping the body and unknown fields. */
  async patch(id: string, patch: Partial<AgentFrontmatter>): Promise<AgentDef | undefined> {
    const file = this.fileFor(id)
    let doc
    try {
      doc = await readMd(file)
    } catch {
      return undefined
    }
    await writeMd(file, { ...doc.data, ...patch }, doc.body)
    return this.reloadFile(id)
  }

  /** Fire: removes the agent file. */
  async remove(id: string): Promise<void> {
    await fs.rm(this.fileFor(id), { force: true })
    this.agents.delete(id)
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
