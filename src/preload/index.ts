import { contextBridge, ipcRenderer } from 'electron'
import type { Command, EngineEvent, CartoonStudioApi } from '../shared/protocol'
import type { HostApi } from '../renderer/hostApi'

const api: CartoonStudioApi & HostApi = {
  on(handler) {
    const listener = (_e: unknown, event: EngineEvent) => handler(event)
    ipcRenderer.on('engine:event', listener)
    return () => {
      ipcRenderer.removeListener('engine:event', listener)
    }
  },
  send(command: Command) {
    ipcRenderer.send('engine:command', command)
  },
  call: (tool, args) => ipcRenderer.invoke('engine:call', tool, args ?? {}),
  readFile: (rel) => ipcRenderer.invoke('host:readFile', rel),
  tailFile: (rel, fromByte) => ipcRenderer.invoke('host:tailFile', rel, fromByte),
  openFolder: (rel) => ipcRenderer.invoke('host:openFolder', rel),
  openFile: (rel) => ipcRenderer.invoke('host:openFile', rel),
  showInFolder: (rel) => ipcRenderer.invoke('host:showInFolder', rel),
  pickFolder: (title) => ipcRenderer.invoke('host:pickFolder', title),
  pickFile: (title, kind) => ipcRenderer.invoke('host:pickFile', title, kind),
  getStartWithWindows: () => ipcRenderer.invoke('host:getLogin'),
  setStartWithWindows: (on) => ipcRenderer.invoke('host:setLogin', on)
}

contextBridge.exposeInMainWorld('cartoonstudio', api)
