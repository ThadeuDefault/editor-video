import { execFile } from 'node:child_process'
import type { GpuInfo } from '../shared/api'
import { runFfmpeg } from './ffmpeg'
import { getSetting, setSetting } from './settings'

let info: Promise<GpuInfo> | null = null

function nvidiaName(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, timeout: 8000 }, (err, out) => {
      if (err) return resolve(undefined)
      resolve(out.trim().split(/\r?\n/)[0] || undefined)
    })
  })
}

/** Testa de verdade cada encoder com um vídeo minúsculo (o driver pode não suportar a versão do NVENC). */
async function detectEncoder(): Promise<string> {
  for (const enc of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    try {
      await runFfmpeg(['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=256x256:d=0.2', '-pix_fmt', 'yuv420p', '-c:v', enc, '-f', 'null', '-'])
      return enc
    } catch {
      /* próximo */
    }
  }
  return 'libx264'
}

export function gpuInfo(): Promise<GpuInfo> {
  if (!info) {
    info = (async () => {
      const gpuName = await nvidiaName()
      const ffmpegVersionKey = 'encoderCache'
      const cachedEnc = getSetting<{ enc: string; date: number }>(ffmpegVersionKey)
      let enc: string
      if (cachedEnc && Date.now() - cachedEnc.date < 7 * 86400_000) enc = cachedEnc.enc
      else {
        enc = await detectEncoder()
        setSetting(ffmpegVersionKey, { enc, date: Date.now() })
      }
      return { hasNvidia: !!gpuName, gpuName, ffmpegH264: enc }
    })()
  }
  return info
}

/** Argumentos de qualidade para cada encoder H.264. */
export function h264Args(enc: string, quality: 'proxy' | 'final', bitrateKbps?: number): string[] {
  const br = bitrateKbps ? [`-b:v`, `${bitrateKbps}k`, '-maxrate', `${Math.round(bitrateKbps * 1.5)}k`, '-bufsize', `${bitrateKbps * 2}k`] : []
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p4', ...(bitrateKbps ? ['-rc', 'vbr', ...br] : ['-rc', 'vbr', '-cq', quality === 'proxy' ? '20' : '19'])]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', ...(bitrateKbps ? br : ['-global_quality', '21'])]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', ...(bitrateKbps ? br : ['-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'])]
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', ...(bitrateKbps ? br : ['-crf', quality === 'proxy' ? '19' : '18'])]
  }
}
