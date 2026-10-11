import type { AlphaChannel } from '@shared/types'

export interface AlphaApi {
  invoke(channel: AlphaChannel, ...args: unknown[]): Promise<unknown>
  on(callback: (event: unknown) => void): () => void
}

declare global {
  interface Window {
    alpha: AlphaApi
  }
}

export function invoke<T>(channel: AlphaChannel, ...args: unknown[]): Promise<T> {
  return window.alpha.invoke(channel, ...args) as Promise<T>
}