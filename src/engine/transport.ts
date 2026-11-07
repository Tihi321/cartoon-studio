import { isCommand } from '../shared/protocol'
import type { Command, EngineEvent, EngineTransport } from '../shared/protocol'

/** The subset of Electron's `process.parentPort` (a MessagePortMain) that we use. */
interface ParentPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (e: { data: unknown }) => void): void
  removeListener(event: 'message', listener: (e: { data: unknown }) => void): void
}

export function getParentPort(): ParentPort | undefined {
  return (process as unknown as { parentPort?: ParentPort }).parentPort
}

/** Engine end of the Electron utilityProcess link. */
export class ParentPortTransport implements EngineTransport {
  constructor(private readonly port: ParentPort) {}

  send(message: EngineEvent): void {
    this.port.postMessage(message)
  }

  onMessage(handler: (message: Command) => void): () => void {
    const listener = (e: { data: unknown }) => {
      if (isCommand(e.data)) handler(e.data)
    }
    this.port.on('message', listener)
    return () => this.port.removeListener('message', listener)
  }

  close(): void {
    // The port closes with the process.
  }
}

/** Headless engine: events go to stdout as one JSON line each, commands are not accepted. */
export class StdoutTransport implements EngineTransport {
  constructor(private readonly quiet = false) {}

  send(message: EngineEvent): void {
    if (this.quiet && message.type === 'engine.heartbeat') return
    process.stdout.write(`[engine] ${JSON.stringify(message)}\n`)
  }

  onMessage(): () => void {
    return () => undefined
  }

  close(): void {}
}
