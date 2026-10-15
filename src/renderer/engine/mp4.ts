/**
 * Parser MP4 mínimo para os proxies gerados pelo próprio app (H.264, sem B-frames, moov no início).
 * Extrai a tabela de amostras da trilha de vídeo e o avcC para o VideoDecoder.
 */

export interface Sample {
  offset: number
  size: number
  /** microssegundos */
  cts: number
  dts: number
  key: boolean
}

export interface VideoTrackInfo {
  codec: string
  width: number
  height: number
  description: Uint8Array
  samples: Sample[]
  timescale: number
}

type Reader = (offset: number, length: number) => Promise<Uint8Array>

interface Box {
  type: string
  start: number
  /** início do conteúdo */
  data: number
  end: number
}

function boxes(buf: DataView, from: number, to: number): Box[] {
  const out: Box[] = []
  let p = from
  while (p + 8 <= to) {
    let size = buf.getUint32(p)
    const type = String.fromCharCode(buf.getUint8(p + 4), buf.getUint8(p + 5), buf.getUint8(p + 6), buf.getUint8(p + 7))
    let header = 8
    if (size === 1) {
      size = Number(buf.getBigUint64(p + 8))
      header = 16
    } else if (size === 0) size = to - p
    if (size < header) break
    out.push({ type, start: p, data: p + header, end: Math.min(to, p + size) })
    p += size
  }
  return out
}

const child = (dv: DataView, b: Box, type: string) => boxes(dv, b.data, b.end).find((x) => x.type === type)

function path(dv: DataView, b: Box, ...types: string[]): Box | undefined {
  let cur: Box | undefined = b
  for (const t of types) {
    if (!cur) return undefined
    cur = child(dv, cur, t)
  }
  return cur
}

/** Localiza e lê o box moov sem carregar o arquivo inteiro. */
async function readMoov(read: Reader, fileSize: number): Promise<{ dv: DataView; moov: Box }> {
  let p = 0
  while (p < fileSize) {
    const head = await read(p, 16)
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength)
    let size = dv.getUint32(0)
    const type = String.fromCharCode(head[4], head[5], head[6], head[7])
    if (size === 1) size = Number(dv.getBigUint64(8))
    else if (size === 0) size = fileSize - p
    if (type === 'moov') {
      const data = await read(p, size)
      const mdv = new DataView(data.buffer, data.byteOffset, data.byteLength)
      return { dv: mdv, moov: boxes(mdv, 0, data.byteLength)[0] }
    }
    if (size < 8) break
    p += size
  }
  throw new Error('moov não encontrado')
}

export async function parseMp4(read: Reader, fileSize: number): Promise<VideoTrackInfo> {
  const { dv, moov } = await readMoov(read, fileSize)
  for (const trak of boxes(dv, moov.data, moov.end).filter((b) => b.type === 'trak')) {
    const mdia = child(dv, trak, 'mdia')!
    const hdlr = child(dv, mdia, 'hdlr')!
    const handler = String.fromCharCode(dv.getUint8(hdlr.data + 8), dv.getUint8(hdlr.data + 9), dv.getUint8(hdlr.data + 10), dv.getUint8(hdlr.data + 11))
    if (handler !== 'vide') continue
    const mdhd = child(dv, mdia, 'mdhd')!
    const v = dv.getUint8(mdhd.data)
    const timescale = v === 1 ? dv.getUint32(mdhd.data + 20) : dv.getUint32(mdhd.data + 12)
    const stbl = path(dv, mdia, 'minf', 'stbl')!
    const stsd = child(dv, stbl, 'stsd')!
    // stsd: version/flags(4) + count(4) + entry
    const entry = boxes(dv, stsd.data + 8, stsd.end)[0]
    const width = dv.getUint16(entry.data + 24)
    const height = dv.getUint16(entry.data + 26)
    // entradas visuais têm 78 bytes fixos antes dos sub-boxes
    const avcC = boxes(dv, entry.data + 78, entry.end).find((b) => b.type === 'avcC')
    if (!avcC) throw new Error('avcC ausente (proxy não é H.264?)')
    const description = new Uint8Array(dv.buffer.slice(dv.byteOffset + avcC.data, dv.byteOffset + avcC.end))
    const codec = 'avc1.' + [description[1], description[2], description[3]].map((x) => x.toString(16).padStart(2, '0')).join('')

    // tamanhos
    const stsz = child(dv, stbl, 'stsz')!
    const fixed = dv.getUint32(stsz.data + 4)
    const count = dv.getUint32(stsz.data + 8)
    const sizes = new Array<number>(count)
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.data + 12 + i * 4)
    // offsets dos chunks
    const stco = child(dv, stbl, 'stco')
    const co64 = child(dv, stbl, 'co64')
    const chunkOffsets: number[] = []
    if (stco) {
      const n = dv.getUint32(stco.data + 4)
      for (let i = 0; i < n; i++) chunkOffsets.push(dv.getUint32(stco.data + 8 + i * 4))
    } else if (co64) {
      const n = dv.getUint32(co64.data + 4)
      for (let i = 0; i < n; i++) chunkOffsets.push(Number(dv.getBigUint64(co64.data + 8 + i * 8)))
    }
    // amostras por chunk
    const stsc = child(dv, stbl, 'stsc')!
    const stscN = dv.getUint32(stsc.data + 4)
    const stscE: { first: number; per: number }[] = []
    for (let i = 0; i < stscN; i++) stscE.push({ first: dv.getUint32(stsc.data + 8 + i * 12), per: dv.getUint32(stsc.data + 12 + i * 12) })
    const offsets = new Array<number>(count)
    let s = 0
    for (let c = 0; c < chunkOffsets.length && s < count; c++) {
      let per = stscE[0].per
      for (const e of stscE) if (c + 1 >= e.first) per = e.per
      let off = chunkOffsets[c]
      for (let k = 0; k < per && s < count; k++) {
        offsets[s] = off
        off += sizes[s]
        s++
      }
    }
    // tempos de decodificação
    const stts = child(dv, stbl, 'stts')!
    const dts = new Array<number>(count)
    {
      const n = dv.getUint32(stts.data + 4)
      let t = 0
      let i = 0
      for (let e = 0; e < n; e++) {
        const cnt = dv.getUint32(stts.data + 8 + e * 8)
        const delta = dv.getUint32(stts.data + 12 + e * 8)
        for (let k = 0; k < cnt && i < count; k++) {
          dts[i++] = t
          t += delta
        }
      }
    }
    const ctsOff = new Array<number>(count).fill(0)
    const ctts = child(dv, stbl, 'ctts')
    if (ctts) {
      const ver = dv.getUint8(ctts.data)
      const n = dv.getUint32(ctts.data + 4)
      let i = 0
      for (let e = 0; e < n; e++) {
        const cnt = dv.getUint32(ctts.data + 8 + e * 8)
        const off = ver === 1 ? dv.getInt32(ctts.data + 12 + e * 8) : dv.getUint32(ctts.data + 12 + e * 8)
        for (let k = 0; k < cnt && i < count; k++) ctsOff[i++] = off
      }
    }
    const stss = child(dv, stbl, 'stss')
    const keys = new Set<number>()
    if (stss) {
      const n = dv.getUint32(stss.data + 4)
      for (let i = 0; i < n; i++) keys.add(dv.getUint32(stss.data + 8 + i * 4) - 1)
    }
    // edit list: deslocamento inicial (media_time)
    let shift = 0
    const elst = path(dv, trak, 'edts', 'elst')
    if (elst) {
      const ver = dv.getUint8(elst.data)
      const n = dv.getUint32(elst.data + 4)
      for (let e = 0; e < n; e++) {
        const base = elst.data + 8 + e * (ver === 1 ? 20 : 12)
        const mediaTime = ver === 1 ? Number(dv.getBigInt64(base + 8)) : dv.getInt32(base + 4)
        if (mediaTime >= 0) {
          shift = mediaTime
          break
        }
      }
    }
    const samples: Sample[] = []
    for (let i = 0; i < count; i++) {
      samples.push({
        offset: offsets[i],
        size: sizes[i],
        dts: Math.round(((dts[i] - shift) * 1e6) / timescale),
        cts: Math.round(((dts[i] + ctsOff[i] - shift) * 1e6) / timescale),
        key: stss ? keys.has(i) : true
      })
    }
    return { codec, width, height, description, samples, timescale }
  }
  throw new Error('trilha de vídeo não encontrada')
}
