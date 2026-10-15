import { protocol } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { extname } from 'node:path'
import { Readable } from 'node:stream'

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'media',
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true }
    }
  ])
}

/** Serve arquivos locais com suporte a Range (necessário para busca em <video>). */
export function handleMediaProtocol(): void {
  protocol.handle('media', async (req) => {
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname.replace(/^\//, ''))
    let size: number
    try {
      size = statSync(path).size
    } catch {
      return new Response('not found', { status: 404 })
    }
    const type = MIME[extname(path).toLowerCase()] || 'application/octet-stream'
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
    const range = req.headers.get('range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1
      if (m && !m[1] && m[2]) {
        start = size - parseInt(m[2], 10)
        end = size - 1
      }
      end = Math.min(end, size - 1)
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
      }
      const stream = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
      })
    }
    const stream = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream
    return new Response(stream, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
  })
}
