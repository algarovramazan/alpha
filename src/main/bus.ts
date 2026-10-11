import type { AlphaEvent } from '../shared/types'

type Emitter = (event: AlphaEvent) => void

let emitFn: Emitter | null = null

export function setEmitter(fn: Emitter): Emitter | null {
  const previous = emitFn
  emitFn = fn
  return previous
}

export function emit(event: AlphaEvent): void {
  emitFn?.(event)
}