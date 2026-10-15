import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Draft } from 'immer'
import { addAssetToTimeline, importFiles, splitAtPlayhead } from '../actions'
import { projectDuration } from '../engine/compositor'
import { WAVE_RATE } from '../features/autoCut'
import { closeGaps, deleteItems, findItem, mediaLimit, nextTrackName, overlaps } from '../state/commands'
import { newTrack } from '../state/defaults'
import { ed, useEditor } from '../state/store'
import type { AssetInfo, Item, Project, Track } from '../state/types'
import { useWave } from './waveCache'

const HEAD_W = 176
const RULER_H = 26
const TRACK_H = 54
const SNAP_PX = 8

const COLORS: Record<Item['type'], string> = {
  video: '#3d5adf',
  image: '#0f9f7a',
  audio: '#2f9e44',
  text: '#d9480f',
  caption: '#7048e8'
}

function itemLabel(it: Item, assets: Map<string, AssetInfo>): string {
  if (it.type === 'text') return it.text.replace(/\n/g, ' ')
  if (it.type === 'caption') return it.words.map((w) => w.text).join(' ')
  return assets.get(it.assetId)?.name ?? '(mídia ausente)'
}

/** Move o item para outra faixa/posição (dentro de um gesto). */
function moveItemTo(d: Draft<Project>, id: string, trackIndex: number, start: number): void {
  const f = findItem(d, id)
  if (!f) return
  const it = f.item
  it.start = Math.max(0, start)
  if (trackIndex !== f.ti && d.tracks[trackIndex]) {
    f.track.items.splice(f.ii, 1)
    d.tracks[trackIndex].items.push(it)
  }
}

function Wave({ asset, inPoint, duration, width }: { asset: AssetInfo; inPoint: number; duration: number; width: number }) {
  const wave = useWave(asset)
  const ref = useRef<HTMLCanvasElement>(null)
  const cw = Math.max(1, Math.min(Math.round(width), 6000))
  useEffect(() => {
    const c = ref.current
    if (!c || !wave) return
    c.width = cw
    c.height = 40
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, cw, 40)
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    for (let x = 0; x < cw; x++) {
      const t0 = inPoint + (x / cw) * duration
      const t1 = inPoint + ((x + 1) / cw) * duration
      let m = 0
      for (let i = Math.floor(t0 * WAVE_RATE); i <= Math.floor(t1 * WAVE_RATE) && i < wave.length; i++) m = Math.max(m, wave[i])
      const h = Math.min(40, Math.sqrt(m) * 70)
      ctx.fillRect(x, 40 - h, 1, h)
    }
  }, [wave, inPoint, duration, cw])
  return <canvas ref={ref} className="absolute left-0 bottom-0 pointer-events-none" style={{ width, height: 28 }} />
}

const ItemView = memo(function ItemView({ it, zoom, selected, asset, locked, cutRemove }: { it: Item; zoom: number; selected: boolean; asset?: AssetInfo; locked: boolean; cutRemove?: [number, number][] }) {
  const left = it.start * zoom
  const width = Math.max(2, it.duration * zoom)
  const kfTimes = useMemo(() => [...new Set(Object.values(it.keyframes).flatMap((l) => (l ?? []).map((k) => k.t)))], [it.keyframes])
  const assets = useMemo(() => new Map(asset ? [[asset.id, asset]] : []), [asset])
  return (
    <div
      data-item={it.id}
      className={`absolute top-[3px] bottom-[3px] rounded-md overflow-hidden ${locked ? 'opacity-60' : 'cursor-grab'}`}
      style={{
        left,
        width,
        background: COLORS[it.type],
        boxShadow: selected ? '0 0 0 2px #fff, 0 0 0 4px #7c5cff' : 'inset 0 0 0 1px rgba(255,255,255,0.15)',
        zIndex: selected ? 3 : 1
      }}
      title={itemLabel(it, assets)}
    >
      {(it.type === 'video' || it.type === 'audio') && asset?.hasAudio && <Wave asset={asset} inPoint={it.inPoint} duration={it.duration} width={width} />}
      <div className="relative px-2 pt-1 text-[11px] font-medium truncate text-white/95 pointer-events-none">
        {it.layout ? '⬒ ' : ''}
        {it.type === 'video' && it.muted ? '🔇 ' : ''}
        {itemLabel(it, assets)}
      </div>
      {cutRemove?.map(([s, e], i) => (
        <div
          key={i}
          className="absolute top-0 bottom-0 bg-[#ff2d55]/70 pointer-events-none"
          style={{ left: (s - (it as { inPoint: number }).inPoint) * zoom, width: Math.max(1, (e - s) * zoom) }}
        />
      ))}
      {kfTimes.map((t, i) => (
        <div key={i} className="absolute bottom-[3px] w-[8px] h-[8px] bg-[#ffd43b] rotate-45 pointer-events-none" style={{ left: t * zoom - 4 }} />
      ))}
      {!locked && (
        <>
          <div data-handle="l" className="absolute left-0 top-0 bottom-0 w-[7px] cursor-ew-resize hover:bg-white/30" />
          <div data-handle="r" className="absolute right-0 top-0 bottom-0 w-[7px] cursor-ew-resize hover:bg-white/30" />
        </>
      )}
    </div>
  )
})

function TrackHeader({ track, index, count }: { track: Track; index: number; count: number }) {
  const [editing, setEditing] = useState(false)
  const selected = useEditor((s) => s.selectedTrack === track.id)
  const upd = (fn: (t: Draft<Track>) => void) =>
    ed().commit((d) => {
      const t = d.tracks.find((x) => x.id === track.id)
      if (t) fn(t)
    })
  const btn = 'w-[22px] h-[22px] rounded hover:bg-white/10 flex items-center justify-center text-[12px]'
  return (
    <div
      className={`sticky left-0 z-20 shrink-0 border-b border-r border-line flex flex-col justify-center px-2 gap-1 ${selected ? 'bg-[#262b38]' : 'bg-panel'}`}
      style={{ width: HEAD_W, height: TRACK_H }}
      onPointerDown={() => ed().set({ selectedTrack: track.id })}
    >
      {editing ? (
        <input
          autoFocus
          className="field text-[12px] py-0.5"
          defaultValue={track.name}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v) upd((t) => void (t.name = v))
            setEditing(false)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <div className="text-[12px] truncate font-medium" onDoubleClick={() => setEditing(true)} title="Duplo clique para renomear">
          {track.name}
        </div>
      )}
      <div className="flex items-center gap-0.5 text-muted">
        <button className={btn} title={track.hidden ? 'Mostrar' : 'Ocultar'} onClick={() => upd((t) => void (t.hidden = !t.hidden))}>
          {track.hidden ? '◌' : '◉'}
        </button>
        <button className={btn} title={track.muted ? 'Ativar som' : 'Silenciar'} onClick={() => upd((t) => void (t.muted = !t.muted))}>
          {track.muted ? '🔇' : '🔊'}
        </button>
        <button className={btn} title={track.locked ? 'Destravar' : 'Travar'} onClick={() => upd((t) => void (t.locked = !t.locked))}>
          {track.locked ? '🔒' : '🔓'}
        </button>
        <button
          className={btn}
          title="Subir camada"
          disabled={index === 0}
          onClick={() =>
            ed().commit((d) => {
              const [t] = d.tracks.splice(index, 1)
              d.tracks.splice(index - 1, 0, t)
            })
          }
        >
          ▲
        </button>
        <button
          className={btn}
          title="Descer camada"
          disabled={index === count - 1}
          onClick={() =>
            ed().commit((d) => {
              const [t] = d.tracks.splice(index, 1)
              d.tracks.splice(index + 1, 0, t)
            })
          }
        >
          ▼
        </button>
        <button
          className={btn}
          title="Excluir faixa"
          onClick={() => {
            if (track.items.length && !confirm(`Excluir a faixa "${track.name}" e seus ${track.items.length} itens?`)) return
            ed().commit((d) => {
              d.tracks = d.tracks.filter((t) => t.id !== track.id)
              if (!d.tracks.length) d.tracks.push(newTrack('Faixa 1'))
            })
          }}
        >
          ✕
        </button>
      </div>
    </div>
  )
}

function Playhead() {
  const time = useEditor((s) => s.time)
  const zoom = useEditor((s) => s.zoom)
  return (
    <div className="absolute top-0 bottom-0 z-30 pointer-events-none" style={{ left: HEAD_W + time * zoom }}>
      <div className="absolute top-0 bottom-0 w-[2px] -ml-[1px] bg-[#ff4d6d]" />
      <div className="absolute top-0 -ml-[7px] w-[14px] h-[14px] bg-[#ff4d6d] rounded-b-md" />
    </div>
  )
}

function Ruler({ zoom, width, onSeek }: { zoom: number; width: number; onSeek: (e: React.PointerEvent) => void }) {
  // passo das marcações adequado ao zoom
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const step = steps.find((s) => s * zoom >= 70) ?? 600
  const marks: number[] = []
  for (let t = 0; t * zoom < width; t += step) marks.push(+t.toFixed(3))
  const fmt = (t: number) => {
    const m = Math.floor(t / 60)
    const s = t % 60
    return step < 1 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`
  }
  return (
    <div className="sticky top-0 z-25 flex bg-panel border-b border-line" style={{ height: RULER_H, width: HEAD_W + width, zIndex: 25 }}>
      <div className="sticky left-0 z-30 bg-panel border-r border-line shrink-0" style={{ width: HEAD_W }} />
      <div className="relative flex-1 cursor-pointer" onPointerDown={onSeek}>
        {marks.map((t) => (
          <div key={t} className="absolute top-0 bottom-0 border-l border-[#3a4050] pl-1 text-[10px] text-muted" style={{ left: t * zoom }}>
            {fmt(t)}
          </div>
        ))}
      </div>
    </div>
  )
}

export function Timeline() {
  const project = useEditor((s) => s.project)
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const cutPreview = useEditor((s) => s.cutPreview)
  const playing = useEditor((s) => s.playing)
  const scroller = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(800)
  const [snapOn, setSnapOn] = useState(true)
  const assets = useMemo(() => new Map(project.assets.map((a) => [a.id, a])), [project.assets])
  const duration = projectDuration(project)
  const contentW = Math.max(viewW - HEAD_W, (duration + 20) * zoom)

  useLayoutEffect(() => {
    const el = scroller.current!
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // acompanha o cursor durante a reprodução
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const el = scroller.current
      if (el) {
        const x = ed().time * ed().zoom
        const visible = el.clientWidth - HEAD_W
        if (x < el.scrollLeft || x > el.scrollLeft + visible - 40) el.scrollLeft = Math.max(0, x - 60)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const timeAt = (clientX: number) => {
    const el = scroller.current!
    const r = el.getBoundingClientRect()
    return Math.max(0, (clientX - r.left - HEAD_W + el.scrollLeft) / ed().zoom)
  }
  const rowAt = (clientY: number) => {
    const el = scroller.current!
    const r = el.getBoundingClientRect()
    return Math.floor((clientY - r.top - RULER_H + el.scrollTop) / TRACK_H)
  }

  const scrub = (e: React.PointerEvent) => {
    const fps = ed().project.settings.fps || 30
    const seek = (x: number) => ed().set({ time: Math.round(timeAt(x) * fps) / fps })
    seek(e.clientX)
    const move = (ev: PointerEvent) => seek(ev.clientX)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onLanePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    const itemEl = target.closest('[data-item]') as HTMLElement | null
    const s = ed()
    if (!itemEl) {
      if (!e.ctrlKey) s.set({ selection: [] })
      scrub(e)
      return
    }
    const id = itemEl.dataset.item!
    const f = findItem(s.project, id)
    if (!f || f.track.locked) return
    const handle = target.dataset.handle as 'l' | 'r' | undefined
    let sel = s.selection
    if (e.ctrlKey || e.shiftKey) {
      sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]
      s.set({ selection: sel })
      return
    }
    if (!sel.includes(id)) {
      sel = [id]
      s.set({ selection: sel })
    }
    s.set({ selectedTrack: f.track.id })
    const x0 = e.clientX
    const z = s.zoom
    const it0 = f.item
    const moving = handle ? [id] : sel
    const starts = new Map(moving.map((mid) => [mid, findItem(s.project, mid)?.item.start ?? 0]))
    const snapTimes: number[] = [0, s.time, ...s.project.markers]
    for (const t of s.project.tracks) for (const i of t.items) if (!moving.includes(i.id)) snapTimes.push(i.start, i.start + i.duration)
    const snap = (t: number) => {
      if (!snapOn) return t
      let best = t
      let bd = SNAP_PX / z
      for (const st of snapTimes) if (Math.abs(st - t) < bd) {
        bd = Math.abs(st - t)
        best = st
      }
      return best
    }
    const limit = mediaLimit(s.project, it0)
    const row0 = f.ti
    let started = false
    let targetRow = row0

    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) / z
      if (!started) {
        if (Math.abs(ev.clientX - x0) < 3 && Math.abs(rowAt(ev.clientY) - row0) === 0) return
        started = true
        ed().gestureStart()
      }
      if (handle === 'l') {
        const end = it0.start + it0.duration
        const minStart = it0.type === 'video' || it0.type === 'audio' ? it0.start - it0.inPoint : 0
        const ns = Math.min(end - 0.05, Math.max(Math.max(0, minStart), snap(it0.start + dt)))
        const delta = ns - it0.start
        ed().gestureUpdate((d) => {
          const it = findItem(d, id)!.item
          it.start = ns
          it.duration = it0.duration - delta
          if (it.type === 'video' || it.type === 'audio') it.inPoint = (it0 as { inPoint: number }).inPoint + delta
          if (it.type === 'caption') it.words = (it0 as typeof it).words.map((w) => ({ ...w, start: w.start - delta, end: w.end - delta }))
          for (const k of Object.keys(it.keyframes) as (keyof typeof it.keyframes)[]) it.keyframes[k] = (it0.keyframes[k] ?? []).map((kf) => ({ ...kf, t: kf.t - delta }))
        })
      } else if (handle === 'r') {
        const ne = snap(it0.start + it0.duration + dt)
        const nd = Math.min(limit, Math.max(0.05, ne - it0.start))
        ed().gestureUpdate((d) => {
          findItem(d, id)!.item.duration = nd
        })
      } else {
        // move (vários itens: só na horizontal)
        let dd = dt
        const lead = starts.get(id)!
        const snapped = snap(lead + dt)
        const snappedEnd = snap(lead + it0.duration + dt) - it0.duration
        if (snapped !== lead + dt) dd = snapped - lead
        else if (snappedEnd !== lead + dt) dd = snappedEnd - lead
        const minStart = Math.min(...[...starts.values()])
        dd = Math.max(dd, -minStart)
        const p = ed().project
        targetRow = moving.length === 1 ? Math.max(0, Math.min(p.tracks.length - 1, rowAt(ev.clientY))) : row0
        if (p.tracks[targetRow]?.locked) targetRow = findItem(p, id)!.ti
        ed().gestureUpdate((d) => {
          for (const mid of moving) moveItemTo(d, mid, mid === id ? targetRow : findItem(d, mid)!.ti, starts.get(mid)! + dd)
        })
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!started) return
      // sobreposição ao soltar: cria uma faixa nova acima
      const p = ed().project
      const fixes: string[] = []
      for (const mid of moving) {
        const fm = findItem(p, mid)
        if (fm && overlaps(fm.track, fm.item.start, fm.item.start + fm.item.duration, [mid])) fixes.push(mid)
      }
      if (fixes.length) {
        ed().gestureUpdate((d) => {
          for (const mid of fixes) {
            const fm = findItem(d, mid)!
            if (handle) {
              // aparar sobre outro item: volta ao limite do vizinho
              const others = fm.track.items.filter((o) => o.id !== mid)
              if (handle === 'r') {
                const next = others.filter((o) => o.start >= it0.start).sort((a, b) => a.start - b.start)[0]
                if (next) fm.item.duration = Math.max(0.05, next.start - fm.item.start)
              } else {
                const prev = others.filter((o) => o.start < it0.start).sort((a, b) => b.start - a.start)[0]
                if (prev) {
                  const end = fm.item.start + fm.item.duration
                  const delta = prev.start + prev.duration - fm.item.start
                  fm.item.start += delta
                  fm.item.duration = end - fm.item.start
                  if (fm.item.type === 'video' || fm.item.type === 'audio') fm.item.inPoint += delta
                }
              }
              continue
            }
            const [it] = fm.track.items.splice(fm.ii, 1)
            const nt = newTrack(nextTrackName(d))
            nt.items.push(JSON.parse(JSON.stringify(it)))
            d.tracks.splice(fm.ti, 0, nt as Draft<Track>)
          }
        })
      }
      ed().gestureUpdate((d) => {
        for (const t of d.tracks) t.items.sort((a, b) => a.start - b.start)
      })
      ed().gestureEnd()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onWheel = (e: React.WheelEvent) => {
    const el = scroller.current!
    if (e.ctrlKey) {
      e.preventDefault()
      const t = timeAt(e.clientX)
      const nz = Math.max(4, Math.min(1500, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      ed().set({ zoom: nz })
      requestAnimationFrame(() => {
        const r = el.getBoundingClientRect()
        el.scrollLeft = t * nz - (e.clientX - r.left - HEAD_W)
      })
    } else if (e.shiftKey) {
      el.scrollLeft += e.deltaY
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    const start = timeAt(e.clientX)
    const row = Math.max(0, Math.min(project.tracks.length - 1, rowAt(e.clientY)))
    const assetId = e.dataTransfer.getData('application/x-asset')
    if (assetId) {
      addAssetToTimeline(assetId, { start, trackIndex: row })
      return
    }
    const files = [...e.dataTransfer.files].map((f) => window.appCtl.pathForFile(f)).filter(Boolean)
    if (files.length) await importFiles(files, { start, trackIndex: row })
  }

  const cutMap = useMemo(() => new Map((cutPreview ?? []).map((c) => [c.itemId, c.remove])), [cutPreview])
  const selTrack = useEditor((s) => s.selectedTrack)

  return (
    <div className="h-full flex flex-col bg-panel">
      <div className="h-9 shrink-0 flex items-center gap-2 px-2 border-b border-line">
        <button
          className="btn btn-sm"
          onClick={() =>
            ed().commit((d) => {
              d.tracks.unshift(newTrack(nextTrackName(d)) as Draft<Track>)
            })
          }
          title="Faixas ilimitadas: cada faixa aceita vídeo, imagem, texto, legenda ou áudio. A faixa de cima fica na frente."
        >
          + Faixa
        </button>
        <button className="btn btn-sm" onClick={splitAtPlayhead} title="Cortar no cursor (S)">
          ✂ Dividir
        </button>
        <button
          className="btn btn-sm"
          disabled={!selection.length}
          onClick={() => {
            const ids = ed().selection
            ed().commit((d) => deleteItems(d, ids, false))
            ed().set({ selection: [] })
          }}
          title="Excluir (Del)"
        >
          Excluir
        </button>
        <button
          className="btn btn-sm"
          disabled={!selection.length}
          onClick={() => {
            const ids = ed().selection
            ed().commit((d) => deleteItems(d, ids, true))
            ed().set({ selection: [] })
          }}
          title="Excluir e puxar o resto (Shift+Del)"
        >
          Excluir e fechar
        </button>
        <button className="btn btn-sm" disabled={!selTrack} onClick={() => selTrack && ed().commit((d) => closeGaps(d, selTrack))} title="Encosta todos os clipes da faixa selecionada">
          Fechar buracos
        </button>
        <label className="flex items-center gap-1.5 ml-1 cursor-pointer text-[12px]">
          <input type="checkbox" checked={snapOn} onChange={(e) => setSnapOn(e.target.checked)} />
          Ímã
        </label>
        <div className="flex-1" />
        <span className="text-muted text-[11px]">Zoom</span>
        <input type="range" min={Math.log(4)} max={Math.log(1500)} step={0.01} value={Math.log(zoom)} onChange={(e) => ed().set({ zoom: Math.exp(parseFloat(e.target.value)) })} className="w-[140px]" />
        <button className="btn btn-sm" onClick={() => duration > 0 && ed().set({ zoom: Math.max(4, Math.min(1500, (viewW - HEAD_W - 40) / duration)) })}>
          Ajustar
        </button>
      </div>
      <div ref={scroller} className="flex-1 overflow-auto relative min-h-0" onWheel={onWheel} onDragOver={(e) => e.preventDefault()} onDrop={onDrop} data-lane>
        <div className="relative" style={{ width: HEAD_W + contentW, minHeight: '100%' }}>
          <Ruler zoom={zoom} width={contentW} onSeek={scrub} />
          {project.tracks.map((t, ti) => (
            <div key={t.id} className="flex" style={{ height: TRACK_H }}>
              <TrackHeader track={t} index={ti} count={project.tracks.length} />
              <div className={`relative border-b border-line ${t.hidden ? 'opacity-50' : ''}`} style={{ width: contentW, background: ti % 2 ? '#14171d' : '#161a21' }} onPointerDown={onLanePointerDown}>
                {t.items.map((it) => (
                  <ItemView key={it.id} it={it} zoom={zoom} selected={selection.includes(it.id)} asset={'assetId' in it ? assets.get(it.assetId) : undefined} locked={t.locked} cutRemove={cutMap.get(it.id)} />
                ))}
              </div>
            </div>
          ))}
          <div className="flex" style={{ height: TRACK_H }}>
            <div className="sticky left-0 z-20 bg-panel border-r border-line text-muted text-[11px] px-2 flex items-center" style={{ width: HEAD_W }}>
              Solte mídia aqui para criar faixa
            </div>
            <div
              className="flex-1"
              onPointerDown={(e) => {
                ed().set({ selection: [] })
                scrub(e)
              }}
              onDrop={async (e) => {
                e.preventDefault()
                e.stopPropagation()
                const start = timeAt(e.clientX)
                ed().commit((d) => {
                  d.tracks.push(newTrack(nextTrackName(d)) as Draft<Track>)
                })
                const row = ed().project.tracks.length - 1
                const assetId = e.dataTransfer.getData('application/x-asset')
                if (assetId) addAssetToTimeline(assetId, { start, trackIndex: row })
                else {
                  const files = [...e.dataTransfer.files].map((f) => window.appCtl.pathForFile(f)).filter(Boolean)
                  if (files.length) await importFiles(files, { start, trackIndex: row })
                }
              }}
            />
          </div>
          <Playhead />
        </div>
      </div>
    </div>
  )
}
