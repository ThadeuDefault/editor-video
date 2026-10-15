import { useEffect, useState } from 'react'
import type { AssetInfo } from '../state/types'

const cache = new Map<string, Float32Array>()
const pending = new Map<string, Promise<Float32Array | null>>()

export function loadWave(a: AssetInfo): Promise<Float32Array | null> {
  if (!a.wavePath) return Promise.resolve(null)
  const c = cache.get(a.id)
  if (c) return Promise.resolve(c)
  let p = pending.get(a.id)
  if (!p) {
    p = window.api
      .readBinary(a.wavePath)
      .then((buf) => {
        const copy = new Uint8Array(buf.byteLength)
        copy.set(buf)
        const arr = new Float32Array(copy.buffer)
        cache.set(a.id, arr)
        return arr
      })
      .catch(() => null)
    pending.set(a.id, p)
  }
  return p
}

export function useWave(a: AssetInfo | undefined): Float32Array | null {
  const [w, setW] = useState<Float32Array | null>(a ? cache.get(a.id) ?? null : null)
  useEffect(() => {
    if (!a) return
    let alive = true
    loadWave(a).then((x) => alive && setW(x))
    return () => {
      alive = false
    }
  }, [a?.id, a?.wavePath])
  return w
}
