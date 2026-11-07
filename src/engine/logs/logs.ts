import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Buffered appends to log files. Output is flushed about every 250 ms (and on flush()),
 * so streamed tokens don't cause one write each.
 */
export class LogWriter {
  private buffers = new Map<string, string>()
  private timer: NodeJS.Timeout | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly dataDir: string,
    private readonly flushMs = 250
  ) {}

  agentLog(agent: string): string {
    return path.join(this.dataDir, 'logs', 'agents', `${agent}.md`)
  }
  bookLog(book: string): string {
    return path.join(this.dataDir, 'series', book, 'log.md')
  }

  append(file: string, text: string): void {
    this.buffers.set(file, (this.buffers.get(file) ?? '') + text)
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.flush()
      }, this.flushMs)
      this.timer.unref?.()
    }
  }

  /** Appends to the agent's log and, when there is a book, the book's log. */
  both(agent: string, book: string | null | undefined, text: string): void {
    this.append(this.agentLog(agent), text)
    if (book) this.append(this.bookLog(book), text)
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const batch = [...this.buffers.entries()]
    this.buffers.clear()
    this.chain = this.chain.then(async () => {
      for (const [file, text] of batch) {
        try {
          await fs.mkdir(path.dirname(file), { recursive: true })
          await fs.appendFile(file, text, 'utf8')
        } catch {
          /* a log failure must not stop the work */
        }
      }
    })
    return this.chain
  }
}
