import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { activeAt, isVisual, itemBox, projectDuration, templateOf } from '../engine/compositor'
import { transformAt } from '../engine/keyframes'
import { PreviewEngine } from '../engine/playback'
import { safeRect, snapBox, SAFE_AREAS } from '../features/layout'
import { findItem, setAnimProp } from '../state/commands'
import { ed, useEditor } from '../state/store'
import type { Item, Project, SafePlatform } from '../state/types'
import { fmtTime } from './controls'

let measure: OffscreenCanvasRenderingContext2D | null = null
const mctx = () => (measure ??= new OffscreenCanvas(8, 8).getContext('2d')!)

type Box = NonNullable<ReturnType<typeof itemBox>>

function inBox(px: number, py: number, b: Box, pad = 0): boolean {
  const r = (-b.rotation * Math.PI) / 180
  const dx = px - b.cx
  const dy = py - b.cy
  const x = dx * Math.cos(r) - dy * Math.sin(r)
  const y = dx * Math.sin(r) + dy * Math.cos(r)
  return Math.abs(x) <= b.w / 2 + pad && Math.abs(y) <= b.h / 2 + pad
}

function aabb(b: Box): { x0: number; y0: number; x1: number; y1: number } {
  const r = (b.rotation * Math.PI) / 180
  const c = Math.abs(Math.cos(r))
  const s = Math.abs(Math.sin(r))
  const hw = (b.w * c + b.h * s) / 2
  const hh = (b.w * s + b.h * c) / 2
  return { x0: b.cx - hw, y0: b.cy - hh, x1: b.cx + hw, y1: b.cy + hh }
}

/** Item visual mais acima no ponto (faixas do topo primeiro). */
function hitTest(p: Project, t: number, px: number, py: number): Item | null {
  for (const tr of p.tracks) {
    if (tr.hidden || tr.locked) continue
    for (let i = tr.items.length - 1; i >= 0; i--) {
      const it = tr.items[i]
      if (!isVisual(it) || !activeAt(it, t)) continue
      const b = itemBox(mctx(), p, it, t)
      if (!b) continue
      if (it.mask) {
        const m = it.mask
        if (px < m.x || px > m.x + m.w || py < m.y || py > m.y + m.h) continue
      }
      if (inBox(px, py, b)) return it
    }
  }
  return null
}

function SafeOverlay({ platform, W, H }: { platform: SafePlatform; W: number; H: number }) {
  const r = safeRect(platform, W, H)
  const vertical = H > W
  const k = W / 1080
  const icons = ['♥', '💬', '➤', '⋯']
  const iconX = W - 75 * k
  const spec = SAFE_AREAS[platform]
  return (
    <g pointerEvents="none">
      <path d={`M0 0H${W}V${H}H0Z M${r.x} ${r.y}V${r.y + r.h}H${r.x + r.w}V${r.y}Z`} fill="rgba(255,40,80,0.13)" fillRule="evenodd" />
      <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="rgba(255,90,120,0.8)" strokeDasharray="14 10" strokeWidth={3} />
      {vertical && (
        <g fill="white" opacity={0.75} fontFamily="Inter" fontWeight={700}>
          <text x={45 * k} y={(spec.top * 0.55) * (H / 1920)} fontSize={44 * k}>
            {platform === 'reels' ? 'Reels' : platform === 'tiktok' ? 'Seguindo  |  Para você' : 'Shorts'}
          </text>
          {icons.map((ic, i) => (
            <g key={i} transform={`translate(${iconX} ${H - (spec.bottom + 90 + i * 150) * (H / 1920)})`}>
              <circle r={42 * k} fill="rgba(0,0,0,0.35)" />
              <text textAnchor="middle" dy={16 * k} fontSize={44 * k}>
                {ic}
              </text>
            </g>
          ))}
          <circle cx={75 * k} cy={H - spec.bottom * 0.62 * (H / 1920)} r={34 * k} fill="rgba(255,255,255,0.5)" />
          <text x={125 * k} y={H - spec.bottom * 0.6 * (H / 1920)} fontSize={36 * k}>
            @seuperfil  · Seguir
          </text>
          <text x={45 * k} y={H - spec.bottom * 0.35 * (H / 1920)} fontSize={32 * k} fontWeight={400}>
            Legenda do post aparece aqui...
          </text>
        </g>
      )}
    </g>
  )
}

export function Preview() {
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<PreviewEngine | null>(null)
  const [stage, setStage] = useState({ w: 400, h: 600 })
  const [guides, setGuides] = useState<{ x?: number; y?: number }[]>([])
  const project = useEditor((s) => s.project)
  const time = useEditor((s) => s.time)
  const playing = useEditor((s) => s.playing)
  const selection = useEditor((s) => s.selection)
  const safe = useEditor((s) => s.safe)
  const [quality, setQuality] = useState<'auto' | 'full'>('auto')
  const W = project.settings.width
  const H = project.settings.height

  useEffect(() => {
    engineRef.current = new PreviewEngine(canvasRef.current!)
    return () => engineRef.current?.destroy()
  }, [])

  useLayoutEffect(() => {
    const el = stageRef.current!
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const pad = 16
  const k = Math.min((stage.w - pad * 2) / W, (stage.h - pad * 2) / H)
  const dispW = Math.max(10, Math.floor(W * k))
  const dispH = Math.max(10, Math.floor(H * k))

  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const scale = quality === 'full' ? 1 : Math.min(1, (dispW * dpr) / W)
    engineRef.current?.setSize(Math.round(W * scale), Math.round(H * scale), scale)
  }, [dispW, dispH, W, H, quality])

  const selItem = selection.length === 1 ? findItem(project, selection[0]) : null
  const sel = selItem && isVisual(selItem.item) && activeAt(selItem.item, time) && !selItem.track.locked ? selItem.item : null
  const box = useMemo(() => (sel ? itemBox(mctx(), project, sel, time) : null), [sel, project, time])
  const handle = 10 / k

  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const s = ed()
    const p0 = toProject(e)
    let target: Item | null = null
    let mode: 'move' | 'scale' | 'rotate' = 'move'
    if (sel && box) {
      const rot = (box.rotation * Math.PI) / 180
      const rotHandle = { x: box.cx + Math.sin(rot) * (box.h / 2 + 50 / k), y: box.cy - Math.cos(rot) * (box.h / 2 + 50 / k) }
      if (sel.type !== 'caption' && Math.hypot(p0.x - rotHandle.x, p0.y - rotHandle.y) < handle * 1.6) {
        target = sel
        mode = 'rotate'
      } else if (sel.type !== 'caption') {
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const lx = (sx * box.w) / 2
          const ly = (sy * box.h) / 2
          const hx = box.cx + lx * Math.cos(rot) - ly * Math.sin(rot)
          const hy = box.cy + lx * Math.sin(rot) + ly * Math.cos(rot)
          if (Math.hypot(p0.x - hx, p0.y - hy) < handle * 1.6) {
            target = sel
            mode = 'scale'
          }
        }
      }
      if (!target && inBox(p0.x, p0.y, box, handle)) target = sel
    }
    if (!target) target = hitTest(s.project, s.time, p0.x, p0.y)
    if (!target) {
      s.set({ selection: [] })
      return
    }
    if (!s.selection.includes(target.id) || s.selection.length !== 1) s.set({ selection: [target.id] })
    const it = target
    const local = s.time - it.start
    const tr0 = transformAt(it, local)
    const b0 = itemBox(mctx(), s.project, it, s.time)!
    const tpl0 = it.type === 'caption' ? templateOf(s.project, it.templateId) : null
    const d0 = Math.hypot(p0.x - b0.cx, p0.y - b0.cy) || 1
    const a0 = Math.atan2(p0.y - b0.cy, p0.x - b0.cx)
    const sr = safeRect(s.safe.platform, W, H)
    const gx = [0, W / 2, W, ...(s.safe.snap ? [sr.x, sr.x + sr.w] : [])]
    const gy = [0, H / 2, H, ...(s.safe.snap ? [sr.y, sr.y + sr.h] : [])]
    let moved = false
    s.gestureStart()
    ;(e.target as Element).setPointerCapture(e.pointerId)

    const move = (ev: PointerEvent) => {
      const p = toProject(ev)
      const dx = p.x - p0.x
      const dy = p.y - p0.y
      if (!moved && Math.hypot(dx, dy) * k < 3) return
      moved = true
      const noSnap = ev.altKey
      if (mode === 'move') {
        if (tpl0) {
          let top = b0.cy - b0.h / 2 + dy
          let bottom = top + b0.h
          if (!noSnap) {
            const sn = snapBox({ x0: 0, y0: top, x1: W, y1: bottom }, [], gy, 14 / k)
            top += sn.dy
            bottom += sn.dy
            setGuides(sn.lines)
          }
          const mb = Math.round(((H - bottom) * 1920) / H)
          ed().gestureUpdate((d) => {
            const t = d.templates.find((x) => x.id === tpl0.id)
            if (t) t.marginBottom = Math.max(0, mb)
          })
          return
        }
        let nx = tr0.x + dx
        let ny = tr0.y + dy
        if (!noSnap) {
          const bb = aabb({ ...b0, cx: nx, cy: ny })
          const sn = snapBox(bb, gx, gy, 14 / k)
          nx += sn.dx
          ny += sn.dy
          setGuides(sn.lines)
        } else setGuides([])
        ed().gestureUpdate((d) => {
          setAnimProp(d, it.id, 'x', Math.round(nx * 10) / 10, local)
          setAnimProp(d, it.id, 'y', Math.round(ny * 10) / 10, local)
        })
      } else if (mode === 'scale') {
        const dist = Math.hypot(p.x - b0.cx, p.y - b0.cy)
        const sc = Math.max(0.02, (tr0.scale * dist) / d0)
        ed().gestureUpdate((d) => setAnimProp(d, it.id, 'scale', Math.round(sc * 1000) / 1000, local))
      } else {
        const a = Math.atan2(p.y - b0.cy, p.x - b0.cx)
        let deg = tr0.rotation + ((a - a0) * 180) / Math.PI
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        else if (!noSnap) {
          const near = Math.round(deg / 90) * 90
          if (Math.abs(deg - near) < 4) deg = near
        }
        ed().gestureUpdate((d) => setAnimProp(d, it.id, 'rotation', Math.round(deg * 10) / 10, local))
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setGuides([])
      ed().gestureEnd()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const duration = projectDuration(project)
  const rot = box ? box.rotation : 0

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-[#0b0d11]">
      <div ref={stageRef} className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden">
        <div className="relative shadow-2xl" style={{ width: dispW, height: dispH }}>
          <canvas ref={canvasRef} style={{ width: dispW, height: dispH, display: 'block', background: '#000' }} />
          <svg className="absolute inset-0" width={dispW} height={dispH} viewBox={`0 0 ${W} ${H}`} onPointerDown={onPointerDown} style={{ touchAction: 'none' }}>
            {safe.show && <SafeOverlay platform={safe.platform} W={W} H={H} />}
            {guides.map((g, i) =>
              g.x !== undefined ? (
                <line key={i} x1={g.x} x2={g.x} y1={0} y2={H} stroke="#ff3df0" strokeWidth={2 / k} />
              ) : (
                <line key={i} x1={0} x2={W} y1={g.y} y2={g.y} stroke="#ff3df0" strokeWidth={2 / k} />
              )
            )}
            {sel && box && (
              <g transform={`translate(${box.cx} ${box.cy}) rotate(${rot})`}>
                <rect x={-box.w / 2} y={-box.h / 2} width={box.w} height={box.h} fill="none" stroke="#a48bff" strokeWidth={2 / k} />
                {sel.type !== 'caption' && (
                  <>
                    {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy], i) => (
                      <rect key={i} x={(sx * box.w) / 2 - handle / 2} y={(sy * box.h) / 2 - handle / 2} width={handle} height={handle} fill="white" stroke="#7c5cff" strokeWidth={2 / k} style={{ cursor: 'nwse-resize' }} />
                    ))}
                    <line x1={0} y1={-box.h / 2} x2={0} y2={-box.h / 2 - 50 / k} stroke="#a48bff" strokeWidth={2 / k} />
                    <circle cx={0} cy={-box.h / 2 - 50 / k} r={handle * 0.7} fill="white" stroke="#7c5cff" strokeWidth={2 / k} style={{ cursor: 'grab' }} />
                  </>
                )}
              </g>
            )}
            {sel?.mask && <rect x={sel.mask.x} y={sel.mask.y} width={sel.mask.w} height={sel.mask.h} fill="none" stroke="#38bdf8" strokeDasharray={`${8 / k} ${6 / k}`} strokeWidth={2 / k} pointerEvents="none" />}
          </svg>
        </div>
      </div>
      <div className="h-11 shrink-0 border-t border-line flex items-center gap-2 px-3 bg-panel">
        <button className="btn btn-sm btn-icon" onClick={() => ed().set({ time: 0 })} title="Início (Home)">
          ⏮
        </button>
        <button className="btn btn-sm w-[44px]" onClick={() => ed().set({ playing: !playing })} title="Reproduzir/pausar (Espaço)">
          {playing ? '⏸' : '▶'}
        </button>
        <button className="btn btn-sm btn-icon" onClick={() => ed().set({ time: duration })} title="Fim (End)">
          ⏭
        </button>
        <div className="font-mono text-[12px] ml-2">
          {fmtTime(time, project.settings.fps)} <span className="text-muted">/ {fmtTime(duration, project.settings.fps)}</span>
        </div>
        <div className="flex-1" />
        <span className="text-muted text-[11px]">
          {W}x{H} · {+project.settings.fps.toFixed(2)} fps
        </span>
        <select className="field text-[12px]" value={quality} onChange={(e) => setQuality(e.target.value as 'auto' | 'full')} title="Qualidade do preview">
          <option value="auto">Preview rápido</option>
          <option value="full">Preview completo</option>
        </select>
      </div>
    </div>
  )
}
