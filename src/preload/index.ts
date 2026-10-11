import { contextBridge, ipcRenderer } from 'electron'
import { ALPHA_CHANNELS, type AlphaChannel } from '../shared/types'

const INVOKERS = ALPHA_CHANNELS

contextBridge.exposeInMainWorld('alpha', {
  invoke: (channel: AlphaChannel, ...args: unknown[]): Promise<unknown> => {
    if (!INVOKERS.includes(channel)) return Promise.reject(new Error(`unknown channel: ${channel}`))
    return ipcRenderer.invoke(`alpha:${channel}`, ...args)
  },
  on: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_electronEvent: unknown, payload: unknown): void => callback(payload)
    ipcRenderer.on('alpha:event', handler)
    return () => ipcRenderer.removeListener('alpha:event', handler)
  }
})