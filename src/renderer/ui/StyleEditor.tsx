import { useEffect, useState } from 'react'
import { mediaUrl } from '../../shared/api'
import type { TextStyle } from '../state/types'
import { ColorField, NumberField, Row, Select, Toggle } from './controls'

let fontList: string[] | null = null
const loadedCustom = new Set<string>()

/** Fontes: Inter embutida + fontes carregadas pelo usuário + fontes do Windows. */
async function getFonts(): Promise<string[]> {
  if (fontList) return fontList
  const set = new Set<string>(['Inter'])
  try {
    for (const f of await window.api.listFonts()) {
      await registerFont(f.family, f.path)
      set.add(f.family)
    }
  } catch {
    /* */
  }
  try {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
    if (q) for (const f of await q()) set.add(f.family)
  } catch {
    /* sem permissão */
  }
  fontList = [...set].sort((a, b) => (a === 'Inter' ? -1 : b === 'Inter' ? 1 : a.localeCompare(b)))
  return fontList
}

export async function registerFont(family: string, path: string): Promise<void> {
  if (loadedCustom.has(family)) return
  const face = new FontFace(family, `url("${mediaUrl(path)}")`)
  await face.load()
  document.fonts.add(face)
  loadedCustom.add(family)
}

export function StyleEditor({ style, onChange, onCommit }: { style: TextStyle; onChange: (s: TextStyle) => void; onCommit?: () => void }) {
  const [fonts, setFonts] = useState<string[]>(['Inter'])
  useEffect(() => {
    getFonts().then(setFonts)
  }, [])
  const set = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => onChange({ ...style, [k]: v })
  const commitSet = <K extends keyof TextStyle>(k: K, v: TextStyle[K]) => {
    onChange({ ...style, [k]: v })
    onCommit?.()
  }
  return (
    <div className="flex flex-col gap-2">
      <Row label="Fonte">
        <input className="field flex-1 min-w-0" list="font-list" value={style.font} onChange={(e) => set('font', e.target.value)} onBlur={onCommit} />
        <datalist id="font-list">
          {fonts.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
        <button
          className="btn btn-sm"
          title="Carregar arquivo de fonte (.ttf/.otf)"
          onClick={async () => {
            const r = await window.api.openDialog({ title: 'Escolher fonte', filters: [{ name: 'Fontes', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] })
            if (!r.length) return
            const f = await window.api.copyFont(r[0])
            await registerFont(f.family, f.path)
            fontList = null
            setFonts(await getFonts())
            commitSet('font', f.family)
          }}
        >
          …
        </button>
      </Row>
      <Row label="Peso">
        <Select
          value={String(style.weight)}
          onChange={(v) => commitSet('weight', parseInt(v, 10))}
          options={[400, 500, 600, 700, 800, 900].map((w) => ({ value: String(w), label: { 400: 'Regular', 500: 'Médio', 600: 'Semibold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black' }[w]! }))}
        />
      </Row>
      <Row label="Tamanho">
        <NumberField value={style.size} onChange={(v) => set('size', v)} onCommit={onCommit} min={8} max={400} suffix="px" />
        <Toggle checked={style.uppercase} onChange={(v) => commitSet('uppercase', v)} label="MAIÚSC." />
      </Row>
      <Row label="Cor">
        <ColorField value={style.fill} onChange={(v) => commitSet('fill', v)} />
      </Row>
      <Row label="Contorno">
        <ColorField value={style.stroke.color} onChange={(v) => commitSet('stroke', { ...style.stroke, color: v })} />
        <NumberField value={style.stroke.width} onChange={(v) => set('stroke', { ...style.stroke, width: v })} onCommit={onCommit} min={0} max={40} width={44} />
      </Row>
      <Row label="Sombra">
        <ColorField value={style.shadow.color} alpha onChange={(v) => commitSet('shadow', { ...style.shadow, color: v })} />
      </Row>
      <Row label="">
        <span className="text-muted text-[11px]">desfoque</span>
        <NumberField value={style.shadow.blur} onChange={(v) => set('shadow', { ...style.shadow, blur: v })} onCommit={onCommit} min={0} max={80} width={40} />
        <span className="text-muted text-[11px]">y</span>
        <NumberField value={style.shadow.y} onChange={(v) => set('shadow', { ...style.shadow, y: v })} onCommit={onCommit} min={-60} max={60} width={40} />
      </Row>
      <Row label="Caixa fundo">
        <Select
          value={style.box.mode}
          onChange={(v) => commitSet('box', { ...style.box, mode: v })}
          options={[
            { value: 'none', label: 'Sem caixa' },
            { value: 'block', label: 'Atrás do bloco' },
            { value: 'line', label: 'Atrás de cada linha' },
            { value: 'word', label: 'Atrás da palavra' }
          ]}
        />
      </Row>
      {style.box.mode !== 'none' && (
        <>
          <Row label="Cor da caixa">
            <ColorField value={style.box.color} alpha onChange={(v) => commitSet('box', { ...style.box, color: v })} />
          </Row>
          <Row label="Arredond.">
            <NumberField value={style.box.radius} onChange={(v) => set('box', { ...style.box, radius: v })} onCommit={onCommit} min={0} max={100} width={44} />
          </Row>
          <Row label="Margem">
            <span className="text-muted text-[11px]">lado</span>
            <NumberField value={style.box.padX} onChange={(v) => set('box', { ...style.box, padX: v })} onCommit={onCommit} min={0} max={100} width={40} />
            <span className="text-muted text-[11px]">alto</span>
            <NumberField value={style.box.padY} onChange={(v) => set('box', { ...style.box, padY: v })} onCommit={onCommit} min={0} max={100} width={40} />
          </Row>
        </>
      )}
      <Row label="Alinhar">
        <Select
          value={style.align}
          onChange={(v) => commitSet('align', v)}
          options={[
            { value: 'left', label: 'Esquerda' },
            { value: 'center', label: 'Centro' },
            { value: 'right', label: 'Direita' }
          ]}
        />
      </Row>
      <Row label="Entrelinha">
        <NumberField value={style.lineHeight} onChange={(v) => set('lineHeight', v)} onCommit={onCommit} min={0.6} max={3} step={0.05} digits={2} width={50} />
        <span className="text-muted text-[11px]">espaço</span>
        <NumberField value={style.letterSpacing} onChange={(v) => set('letterSpacing', v)} onCommit={onCommit} min={-10} max={40} width={40} />
      </Row>
    </div>
  )
}
