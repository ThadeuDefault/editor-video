import type { Draft } from 'immer'
import { useEffect, useState } from 'react'
import { splitAtPlayhead } from '../actions'
import { templateOf } from '../engine/compositor'
import { keyframeAt, transformAt } from '../engine/keyframes'
import { retimeWords } from '../features/captions'
import { coverTransform } from '../features/layout'
import { findItem, layoutSplitGroup, mediaLimit, removeSplit, setAnimProp, toggleKeyframe } from '../state/commands'
import { defaultTransform } from '../state/defaults'
import { ed, useEditor } from '../state/store'
import type { AnimProp, CaptionItem, Easing, Item, Project, TextItem, VideoItem, AudioItem } from '../state/types'
import { ColorField, fmtTime, NumberField, Row, Section, Select, Slider, Toggle } from './controls'
import { splitScreenAction } from './TopBar'
import { StyleEditor } from './StyleEditor'

/** Alterações contínuas viram um único passo de desfazer. */
const live = (fn: (d: Draft<Project>) => void) => {
  const s = ed()
  if (!s.gestureBase) s.gestureStart()
  s.gestureUpdate(fn)
}
const done = () => ed().gestureEnd()
const once = (fn: (d: Draft<Project>) => void) => {
  live(fn)
  done()
}

function updItem(id: string, fn: (it: Draft<Item>) => void) {
  return (d: Draft<Project>) => {
    const f = findItem(d, id)
    if (f) fn(f.item)
  }
}

export function Inspector() {
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const f = selection.length === 1 ? findItem(project, selection[0]) : null
  return (
    <div className="w-[330px] shrink-0 border-l border-line bg-panel overflow-auto">
      {selection.length === 0 && <ProjectPanel />}
      {selection.length > 1 && <MultiPanel count={selection.length} />}
      {f && <ItemPanel item={f.item} key={f.item.id} />}
    </div>
  )
}

function ProjectPanel() {
  const p = useEditor((s) => s.project)
  return (
    <>
      <Section title="Projeto">
        <Row label="Nome">
          <input className="field flex-1" defaultValue={p.name} key={p.name} onBlur={(e) => e.target.value !== p.name && once((d) => void (d.name = e.target.value))} />
        </Row>
        <Row label="Resolução">
          <span>
            {p.settings.width} × {p.settings.height}
          </span>
        </Row>
        <Row label="FPS">
          <Select
            value={String(+p.settings.fps.toFixed(3))}
            onChange={(v) => once((d) => void (d.settings.fps = parseFloat(v)))}
            options={[...new Set([23.976, 24, 25, 29.97, 30, 50, 59.94, 60, +p.settings.fps.toFixed(3)])].sort((a, b) => a - b).map((f) => ({ value: String(f), label: `${f} fps` }))}
          />
        </Row>
        <Row label="Fundo">
          <ColorField value={p.settings.background} onChange={(v) => once((d) => void (d.settings.background = v))} />
        </Row>
      </Section>
      <Section title="Atalhos">
        <div className="text-[12px] text-muted leading-6">
          <b className="text-white">Espaço</b> reproduzir/pausar
          <br />
          <b className="text-white">S</b> dividir no cursor · <b className="text-white">Del</b> excluir
          <br />
          <b className="text-white">Shift+Del</b> excluir e fechar buraco
          <br />
          <b className="text-white">Ctrl+Z / Ctrl+Y</b> desfazer / refazer
          <br />
          <b className="text-white">Ctrl+C / Ctrl+V</b> copiar / colar no cursor
          <br />
          <b className="text-white">← →</b> 1 frame · <b className="text-white">Shift+← →</b> 1 s
          <br />
          <b className="text-white">Ctrl+roda</b> zoom na timeline
          <br />
          <b className="text-white">Alt</b> ao arrastar: desliga o ímã
          <br />
          <b className="text-white">Ctrl+clique</b> seleciona vários
        </div>
      </Section>
    </>
  )
}

function MultiPanel({ count }: { count: number }) {
  return (
    <Section title={`${count} itens selecionados`}>
      <button className="btn" onClick={splitScreenAction}>
        ⬒ Criar tela dividida (2 vídeos)
      </button>
      <button className="btn" onClick={() => ed().set({ modal: { kind: 'autocut' } })}>
        ✂ Remover silêncios dos selecionados
      </button>
    </Section>
  )
}

const PROPS: { k: AnimProp; label: string; mul: number; suffix: string; step: number; digits: number }[] = [
  { k: 'x', label: 'Posição X', mul: 1, suffix: 'px', step: 1, digits: 0 },
  { k: 'y', label: 'Posição Y', mul: 1, suffix: 'px', step: 1, digits: 0 },
  { k: 'scale', label: 'Escala', mul: 100, suffix: '%', step: 1, digits: 1 },
  { k: 'rotation', label: 'Rotação', mul: 1, suffix: '°', step: 1, digits: 1 },
  { k: 'opacity', label: 'Opacidade', mul: 100, suffix: '%', step: 1, digits: 0 }
]

function TransformSection({ item }: { item: Item }) {
  const time = useEditor((s) => s.time)
  const project = useEditor((s) => s.project)
  const local = Math.max(0, Math.min(item.duration, time - item.start))
  const tr = transformAt(item, local)
  const W = project.settings.width
  const H = project.settings.height
  const kfAtNow = PROPS.map((p) => keyframeAt(item.keyframes[p.k], local))
  const anyKf = kfAtNow.find(Boolean)
  const seekKf = (dir: 1 | -1) => {
    const all = [...new Set(Object.values(item.keyframes).flatMap((l) => (l ?? []).map((k) => k.t)))].sort((a, b) => a - b)
    const next = dir > 0 ? all.find((t) => t > local + 1e-3) : [...all].reverse().find((t) => t < local - 1e-3)
    if (next !== undefined) ed().set({ time: item.start + next })
  }
  const asset = 'assetId' in item ? project.assets.find((a) => a.id === item.assetId) : undefined
  return (
    <Section
      title="Transformação"
      right={
        <span className="flex gap-1">
          <button className="btn btn-sm btn-icon" title="Keyframe anterior" onClick={() => seekKf(-1)}>
            ◀
          </button>
          <button className="btn btn-sm btn-icon" title="Próximo keyframe" onClick={() => seekKf(1)}>
            ▶
          </button>
        </span>
      }
    >
      {(time < item.start || time > item.start + item.duration) && <div className="text-[11px] text-[#ffb86b]">O cursor está fora do item: keyframes serão gravados na borda.</div>}
      {PROPS.map((p, i) => {
        const has = !!item.keyframes[p.k]?.length
        const at = !!kfAtNow[i]
        return (
          <Row key={p.k} label={p.label}>
            <NumberField
              value={tr[p.k] * p.mul}
              step={p.step}
              digits={p.digits}
              suffix={p.suffix}
              min={p.k === 'opacity' ? 0 : p.k === 'scale' ? 1 : -Infinity}
              max={p.k === 'opacity' ? 100 : Infinity}
              onChange={(v) => live((d) => setAnimProp(d, item.id, p.k, v / p.mul, local))}
              onCommit={done}
            />
            <button
              className="text-[15px] w-6"
              style={{ color: at ? '#ffd43b' : has ? '#a48bff' : '#555c6e' }}
              title={at ? 'Remover keyframe' : 'Adicionar keyframe neste tempo'}
              onClick={() => once((d) => toggleKeyframe(d, item.id, p.k, local))}
            >
              {at ? '◆' : '◇'}
            </button>
          </Row>
        )
      })}
      {anyKf && (
        <Row label="Suavização">
          <Select
            value={anyKf.ease}
            onChange={(v) =>
              once(
                updItem(item.id, (it) => {
                  for (const p of PROPS) {
                    const k = keyframeAt(it.keyframes[p.k], local)
                    if (k) k.ease = v as Easing
                  }
                })
              )
            }
            options={[
              { value: 'linear', label: 'Linear' },
              { value: 'easeInOut', label: 'Suave (entrada e saída)' },
              { value: 'easeIn', label: 'Acelerando' },
              { value: 'easeOut', label: 'Desacelerando' },
              { value: 'hold', label: 'Segurar (salto)' }
            ]}
          />
        </Row>
      )}
      <div className="flex gap-2 flex-wrap">
        <button className="btn btn-sm" onClick={() => once(updItem(item.id, (it) => void ((it.transform.x = W / 2), (it.transform.y = H / 2), delete it.keyframes.x, delete it.keyframes.y)))}>
          Centralizar
        </button>
        {asset && asset.kind !== 'audio' && (
          <>
            <button
              className="btn btn-sm"
              title="Preenche a tela inteira (corta as sobras)"
              onClick={() => once(updItem(item.id, (it) => void ((it.transform = coverTransform(asset, { x: 0, y: 0, w: W, h: H }, W, H)), (it.keyframes = {}))))}
            >
              Preencher tela
            </button>
            <button className="btn btn-sm" onClick={() => once(updItem(item.id, (it) => void ((it.transform = defaultTransform(W, H)), (it.keyframes = {}))))}>
              Encaixar
            </button>
          </>
        )}
        {Object.keys(item.keyframes).length > 0 && (
          <button className="btn btn-sm" onClick={() => once(updItem(item.id, (it) => void (it.keyframes = {})))}>
            Limpar keyframes
          </button>
        )}
      </div>
    </Section>
  )
}

function TimeSection({ item }: { item: Item }) {
  const project = useEditor((s) => s.project)
  const limit = mediaLimit(project, item)
  return (
    <Section title="Tempo">
      <Row label="Início">
        <NumberField value={item.start} step={0.01} digits={2} min={0} suffix="s" onChange={(v) => live(updItem(item.id, (it) => void (it.start = v)))} onCommit={done} />
      </Row>
      <Row label="Duração">
        <NumberField value={item.duration} step={0.01} digits={2} min={0.05} max={limit} suffix="s" onChange={(v) => live(updItem(item.id, (it) => void (it.duration = v)))} onCommit={done} />
      </Row>
      {(item.type === 'video' || item.type === 'audio') && (
        <Row label="Na mídia">
          <span className="text-muted text-[12px]">
            {fmtTime(item.inPoint)} → {fmtTime(item.inPoint + item.duration)}
          </span>
        </Row>
      )}
    </Section>
  )
}

function AudioSection({ item }: { item: VideoItem | AudioItem }) {
  return (
    <Section title="Áudio">
      <Row label="Volume">
        <Slider value={item.volume} min={0} max={2} step={0.01} onChange={(v) => live(updItem(item.id, (it) => void ((it as VideoItem).volume = v)))} onCommit={done} />
        <span className="w-10 text-right text-[12px]">{Math.round(item.volume * 100)}%</span>
      </Row>
      <Row label="">
        <Toggle checked={item.muted} onChange={(v) => once(updItem(item.id, (it) => void ((it as VideoItem).muted = v)))} label="Mudo" />
      </Row>
      <Row label="Fade in">
        <NumberField value={item.fadeIn} step={0.05} digits={2} min={0} max={item.duration / 2} suffix="s" onChange={(v) => live(updItem(item.id, (it) => void ((it as VideoItem).fadeIn = v)))} onCommit={done} />
      </Row>
      <Row label="Fade out">
        <NumberField value={item.fadeOut} step={0.05} digits={2} min={0} max={item.duration / 2} suffix="s" onChange={(v) => live(updItem(item.id, (it) => void ((it as VideoItem).fadeOut = v)))} onCommit={done} />
      </Row>
      <button className="btn btn-sm" onClick={() => ed().set({ modal: { kind: 'autocut' } })}>
        ✂ Remover silêncios deste clipe
      </button>
    </Section>
  )
}

function MaskSection({ item }: { item: Item }) {
  const p = useEditor((s) => s.project)
  const m = item.mask
  return (
    <Section title="Recorte (máscara)" defaultOpen={!!m}>
      <Toggle
        checked={!!m}
        label="Mostrar só uma área do quadro"
        onChange={(v) => once(updItem(item.id, (it) => void (v ? (it.mask = { x: 0, y: 0, w: p.settings.width, h: p.settings.height / 2 }) : delete it.mask)))}
      />
      {m &&
        (['x', 'y', 'w', 'h'] as const).map((k) => (
          <Row key={k} label={{ x: 'X', y: 'Y', w: 'Largura', h: 'Altura' }[k]}>
            <NumberField value={m[k]} min={0} suffix="px" onChange={(v) => live(updItem(item.id, (it) => void (it.mask![k] = v)))} onCommit={done} />
          </Row>
        ))}
    </Section>
  )
}

function SplitSection({ item }: { item: Item }) {
  const lay = item.layout!
  return (
    <Section title="Tela dividida">
      <Row label="Divisão">
        <Slider
          value={lay.ratio}
          min={0.2}
          max={0.8}
          step={0.01}
          onChange={(v) =>
            live((d) => {
              for (const t of d.tracks) for (const i of t.items) if (i.layout?.group === lay.group) i.layout.ratio = v
              layoutSplitGroup(d, lay.group)
            })
          }
          onCommit={done}
        />
        <span className="w-12 text-right text-[12px]">
          {Math.round(lay.ratio * 100)}/{Math.round((1 - lay.ratio) * 100)}
        </span>
      </Row>
      <div className="flex gap-2 flex-wrap">
        {[0.5, 0.6, 0.4].map((r) => (
          <button
            key={r}
            className="btn btn-sm"
            onClick={() =>
              once((d) => {
                for (const t of d.tracks) for (const i of t.items) if (i.layout?.group === lay.group) i.layout.ratio = r
                layoutSplitGroup(d, lay.group)
              })
            }
          >
            {r * 100}/{100 - r * 100}
          </button>
        ))}
        <button
          className="btn btn-sm"
          onClick={() =>
            once((d) => {
              for (const t of d.tracks) for (const i of t.items) if (i.layout?.group === lay.group) i.layout.role = i.layout.role === 'top' ? 'bottom' : 'top'
              layoutSplitGroup(d, lay.group)
            })
          }
        >
          ⇅ Inverter
        </button>
        <button className="btn btn-sm" onClick={() => once((d) => layoutSplitGroup(d, lay.group))} title="Reenquadrar as duas metades">
          Reenquadrar
        </button>
        <button className="btn btn-sm" onClick={() => once((d) => removeSplit(d, lay.group))}>
          Desfazer divisão
        </button>
      </div>
      <div className="text-muted text-[11px]">Use escala e posição para ajustar o enquadramento dentro de cada metade.</div>
    </Section>
  )
}

function TextSection({ item }: { item: TextItem }) {
  const [text, setText] = useState(item.text)
  useEffect(() => setText(item.text), [item.text])
  return (
    <>
      <Section title="Texto">
        <textarea
          className="field min-h-[80px] resize-y"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            live(updItem(item.id, (it) => void ((it as TextItem).text = e.target.value)))
          }}
          onBlur={done}
        />
        <Row label="Largura máx.">
          <NumberField value={item.maxWidth} min={50} suffix="px" onChange={(v) => live(updItem(item.id, (it) => void ((it as TextItem).maxWidth = v)))} onCommit={done} />
        </Row>
      </Section>
      <Section title="Estilo">
        <StyleEditor style={item.style} onChange={(st) => live(updItem(item.id, (it) => void ((it as TextItem).style = st)))} onCommit={done} />
      </Section>
    </>
  )
}

function CaptionSection({ item }: { item: CaptionItem }) {
  const p = useEditor((s) => s.project)
  const text = item.words.map((w) => w.text).join(' ')
  const [val, setVal] = useState(text)
  useEffect(() => setVal(text), [text])
  const tpl = templateOf(p, item.templateId)
  const mergeNext = () =>
    once((d) => {
      const f = findItem(d, item.id)!
      const next = f.track.items.filter((i) => i.type === 'caption' && i.start >= item.start + item.duration - 0.01).sort((a, b) => a.start - b.start)[0] as Draft<CaptionItem> | undefined
      if (!next) return
      const cur = f.item as Draft<CaptionItem>
      const off = next.start - cur.start
      cur.words.push(...next.words.map((w) => ({ ...w, start: w.start + off, end: w.end + off })))
      cur.duration = next.start + next.duration - cur.start
      f.track.items = f.track.items.filter((i) => i.id !== next.id)
    })
  return (
    <>
      <Section title="Legenda">
        <textarea
          className="field min-h-[64px] resize-y"
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onBlur={() => val !== text && once(updItem(item.id, (it) => void ((it as CaptionItem).words = retimeWords(it as CaptionItem, val))))}
        />
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-sm" onClick={splitAtPlayhead} title="Divide o bloco no cursor">
            Dividir no cursor
          </button>
          <button className="btn btn-sm" onClick={mergeNext}>
            Juntar com o próximo
          </button>
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {item.words.map((w, i) => (
            <button
              key={i}
              className="text-[11px] px-1.5 py-0.5 rounded bg-panel2 border border-line hover:border-accent"
              title={`${(item.start + w.start).toFixed(2)}s → ${(item.start + w.end).toFixed(2)}s`}
              onClick={() => ed().set({ time: item.start + w.start + 0.001 })}
            >
              {w.text}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Modelo">
        <Row label="Modelo">
          <Select value={item.templateId} onChange={(v) => once(updItem(item.id, (it) => void ((it as CaptionItem).templateId = v)))} options={p.templates.map((t) => ({ value: t.id, label: t.name }))} />
        </Row>
        <div className="flex gap-2 flex-wrap">
          <button className="btn btn-sm" onClick={() => ed().set({ modal: { kind: 'template', id: tpl.id } })}>
            Editar modelo
          </button>
          <button
            className="btn btn-sm"
            onClick={() =>
              once((d) => {
                const f = findItem(d, item.id)!
                for (const i of f.track.items) if (i.type === 'caption') i.templateId = item.templateId
              })
            }
          >
            Aplicar à faixa toda
          </button>
        </div>
        <div className="text-muted text-[11px]">Arraste a legenda no preview para subir/descer todas as legendas desse modelo.</div>
      </Section>
    </>
  )
}

function ItemPanel({ item }: { item: Item }) {
  const title = { video: 'Vídeo', image: 'Imagem', audio: 'Áudio', text: 'Texto', caption: 'Legenda' }[item.type]
  return (
    <>
      <div className="px-3 py-2 border-b border-line font-semibold">{title}</div>
      {item.type === 'text' && <TextSection item={item} />}
      {item.type === 'caption' && <CaptionSection item={item} />}
      {item.layout && <SplitSection item={item} />}
      {item.type !== 'audio' && item.type !== 'caption' && <TransformSection item={item} />}
      {(item.type === 'video' || item.type === 'audio') && <AudioSection item={item} />}
      <TimeSection item={item} />
      {(item.type === 'video' || item.type === 'image') && !item.layout && <MaskSection item={item} />}
    </>
  )
}
