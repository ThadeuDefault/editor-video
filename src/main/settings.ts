import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths'

let data: Record<string, unknown> | null = null
const file = () => join(dataDir(), 'configuracoes.json')

function load(): Record<string, unknown> {
  if (data) return data
  try {
    data = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}
  } catch {
    data = {}
  }
  return data!
}

export function getSetting<T>(key: string): T | undefined {
  return load()[key] as T | undefined
}

export function setSetting(key: string, value: unknown): void {
  const d = load()
  d[key] = value
  writeFileSync(file(), JSON.stringify(d, null, 2), 'utf8')
}
