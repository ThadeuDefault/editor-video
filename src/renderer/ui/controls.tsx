import { useEffect, useRef, useState, type ReactNode } from 'react'

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border-b border-line">
      <div className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none" onClick={() => setOpen(!open)}>
        <span className="text-muted text-[10px]">{open ? '▼' : '▶'}</span>
        <span className="font-semibold text-[12px] uppercase tracking-wide text-[#c9cede] flex-1">{title}</span>
        <span onClick={(e) => e.stopPropagation()}>{right}</span>
      </div>
      {open && <div className="px-3 pb-3 flex flex-col gap-2">{children}</div>}
    </div>
  )
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 min-h-[26px]">
      <div className="w-[88px] shrink-0 text-muted text-[12px]">{label}</div>
      <div className="flex-1 flex items-center gap-2 min-w-0">{children}</div>
    </div>
  )
}

/** Campo numérico com arraste horizontal no rótulo e edição por teclado. */
export function NumberField({
  value,
  onChange,
  onCommit,
  step = 1,
  min = -Infinity,
  max = Infinity,
  digits = 0,
  suffix,
  width = 70
}: {
  value: number
  onChange: (v: number) => void
  onCommit?: () => void
  step?: number
  min?: number
  max?: number
  digits?: number
  suffix?: string
  width?: number
}) {
  const [text, setText] = useState(value.toFixed(digits))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(Number.isFinite(value) ? value.toFixed(digits) : '')
  }, [value, digits])
  const clamp = (v: number) => Math.min(max, Math.max(min, v))
  const startDrag = (e: React.PointerEvent) => {
    const x0 = e.clientX
    const v0 = value
    const move = (ev: PointerEvent) => onChange(clamp(+(v0 + Math.round((ev.clientX - x0) / 2) * step).toFixed(6)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onCommit?.()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className="flex items-center gap-1">
      <span className="cursor-ew-resize text-muted px-0.5" onPointerDown={startDrag} title="Arraste para ajustar">
        ⇔
      </span>
      <input
        className="field text-right"
        style={{ width }}
        value={text}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false
          const v = parseFloat(text.replace(',', '.'))
          if (Number.isFinite(v)) {
            onChange(clamp(v))
            onCommit?.()
          } else setText(value.toFixed(digits))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const v = clamp(value + (e.key === 'ArrowUp' ? step : -step) * (e.shiftKey ? 10 : 1))
            onChange(v)
            onCommit?.()
          }
        }}
        onChange={(e) => setText(e.target.value)}
      />
      {suffix && <span className="text-muted text-[11px]">{suffix}</span>}
    </div>
  )
}

export function Slider({ value, onChange, min, max, step = 0.01, onCommit }: { value: number; onChange: (v: number) => void; min: number; max: number; step?: number; onCommit?: () => void }) {
  return (
    <input
      type="range"
      className="flex-1 min-w-0"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
    />
  )
}

/** Converte qualquer cor CSS em #rrggbb + alfa para o seletor nativo. */
function splitColor(c: string): { hex: string; alpha: number } {
  const m = /rgba?\(([^)]+)\)/.exec(c)
  if (m) {
    const [r, g, b, a] = m[1].split(',').map((x) => parseFloat(x))
    const hex = '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
    return { hex, alpha: a ?? 1 }
  }
  if (/^#[0-9a-f]{8}$/i.test(c)) return { hex: c.slice(0, 7), alpha: parseInt(c.slice(7), 16) / 255 }
  return { hex: c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c, alpha: 1 }
}

function joinColor(hex: string, alpha: number): string {
  if (alpha >= 0.999) return hex
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r},${g},${b},${+alpha.toFixed(2)})`
}

export function ColorField({ value, onChange, alpha = false }: { value: string; onChange: (v: string) => void; alpha?: boolean }) {
  const { hex, alpha: a } = splitColor(value)
  return (
    <div className="flex items-center gap-2 flex-1 min-w-0">
      <input type="color" value={hex} onChange={(e) => onChange(joinColor(e.target.value, a))} className="w-8 h-6 bg-transparent border-0 p-0 cursor-pointer" />
      <input className="field w-[78px] font-mono text-[11px]" value={hex} onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && onChange(joinColor(e.target.value, a))} />
      {alpha && (
        <>
          <input type="range" min={0} max={1} step={0.05} value={a} onChange={(e) => onChange(joinColor(hex, parseFloat(e.target.value)))} className="flex-1 min-w-0" />
          <span className="text-muted text-[11px] w-8">{Math.round(a * 100)}%</span>
        </>
      )}
    </div>
  )
}

export function Select<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <select className="field flex-1 min-w-0" value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  )
}

export function Modal({ title, children, onClose, width = 520, footer }: { title: string; children: ReactNode; onClose: () => void; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bg-panel border border-line rounded-xl shadow-2xl flex flex-col max-h-[90vh]" style={{ width }}>
        <div className="flex items-center px-4 py-3 border-b border-line">
          <div className="font-semibold text-[15px] flex-1">{title}</div>
          <button className="btn btn-sm btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="p-4 overflow-auto flex flex-col gap-3">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-line flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-2 bg-[#0f1115] rounded-full overflow-hidden border border-line">
      <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  )
}

export function fmtTime(t: number, fps = 30): string {
  const s = Math.max(0, t)
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const f = Math.floor((s - Math.floor(s)) * fps)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}
