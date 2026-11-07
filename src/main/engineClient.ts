import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import type { Command, EngineEvent, Transport } from '../shared/protocol'

/** Main-process end of the engine link: sends commands, receives events. */
export class UtilityProcessTransport implements Transport<Command, EngineEvent> {
  private readonly handlers = new Set<(e: EngineEvent) => void>()

  constructor(private readonly child: UtilityProcess) {
    child.on('message', (data: unknown) => {
      for (const h of this.handlers) h(data as EngineEvent)
    })
  }

  send(message: Command): void {
    this.child.postMessage(message)
  }

  onMessage(handler: (message: EngineEvent) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  close(): void {
    this.child.kill()
  }
}

/** Starts the engine (out/engine/index.js) as an Electron utilityProcess. */
export function startEngine(enginePath: string, args: string[], onExit?: (code: number | null) => void): UtilityProcessTransport {
  const child = utilityProcess.fork(enginePath, args, { serviceName: 'cartoon-studio-engine', stdio: 'pipe' })
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d))
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d))
  child.on('spawn', () => console.log(`[main] engine started (pid ${child.pid}): ${enginePath}`))
  child.on('exit', (code) => {
    console.log(`[main] engine exited with code ${code}`)
    onExit?.(code)
  })
  return new UtilityProcessTransport(child)
}
