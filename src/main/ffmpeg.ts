import { spawn, type ChildProcess } from 'node:child_process'
import { ffmpegPath, ffprobePath } from './paths'

export interface RunOptions {
  /** duração total esperada (s) para calcular o progresso */
  duration?: number
  onProgress?: (p: number) => void
  cwd?: string
}

/** Executa o ffmpeg; resolve quando termina com sucesso, rejeita com o fim do stderr. */
export function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = ['-hide_banner', '-nostdin', '-y', ...(opts.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []), ...args]
    const proc = spawn(ffmpegPath(), full, { cwd: opts.cwd, windowsHide: true })
    let err = ''
    proc.stderr.on('data', (d) => {
      err += d.toString()
      if (err.length > 20000) err = err.slice(-10000)
    })
    if (opts.onProgress) {
      let buf = ''
      proc.stdout.on('data', (d) => {
        buf += d.toString()
        const lines = buf.split(/\r?\n/)
        buf = lines.pop() || ''
        for (const l of lines) {
          const m = /^out_time_(?:us|ms)=(\d+)/.exec(l)
          if (m && opts.duration) opts.onProgress!(Math.min(1, parseInt(m[1], 10) / 1e6 / opts.duration))
        }
      })
    }
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`ffmpeg falhou (código ${code}):\n${err.slice(-2000)}`))
    })
  })
}

/** Executa o ffmpeg capturando o stdout binário. */
export function ffmpegToBuffer(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], { windowsHide: true })
    const chunks: Buffer[] = []
    let err = ''
    proc.stdout.on('data', (d) => chunks.push(d))
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.slice(-2000)))))
  })
}

export function spawnFfmpeg(args: string[]): ChildProcess {
  return spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
}

export interface ProbeStream {
  index: number
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  r_frame_rate?: string
  avg_frame_rate?: string
  color_transfer?: string
  color_primaries?: string
  duration?: string
  nb_frames?: string
  disposition?: { attached_pic?: number }
  side_data_list?: { rotation?: number }[]
  tags?: { rotate?: string }
}

export interface ProbeResult {
  streams: ProbeStream[]
  format: { duration?: string; format_name?: string }
}

export function ffprobe(path: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffprobePath(), ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { windowsHide: true })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => (out += d.toString()))
    proc.stderr.on('data', (d) => (err += d.toString()))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Não foi possível ler o arquivo: ${err}`))
      try {
        resolve(JSON.parse(out))
      } catch (e) {
        reject(e)
      }
    })
  })
}

export function parseRate(r?: string): number {
  if (!r) return 0
  const [a, b] = r.split('/').map(Number)
  if (!b) return a || 0
  return a / b
}
