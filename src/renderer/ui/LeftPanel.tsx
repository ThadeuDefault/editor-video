import { useEffect, useMemo, useState } from 'react'
import { mediaUrl, WHISPER_MODELS, type WhisperStatus } from '../../shared/api'
import { addAssetToTimeline, addText, exportSrt, generateCaptions, pickAndImport } from '../actions'
import { retimeWords } from '../features/captions'
import { makeTextItem, placeItem } from '../state/commands'
import { baseTextStyle, uid } from '../state/defaults'
import { ed, useEditor } from '../state/store'
import type { AssetInfo, CaptionItem, CaptionTemplate, TextStyle } from '../state/types'
import { fmtTime } from './controls'

const TABS = [
  { id: 'media', label: 'Mídia' },
  { id: 'captions', label: 'Legendas' },
  { id: 'text', label: 'Texto' },
  { id: 'templates', label: 'Modelos' }
] as const

export function LeftPanel() {
  const panel = useEditor((s) => s.panel)
  return (
    <div className="w-[330px] shrink-0 border-r border-line bg-panel flex flex-col min-h-0">
      <div className="flex border-b border-line px-1">
        {TABS.map((t) => (
          <div key={t.id} className={`tab ${panel === t.id ? 'active' : ''}`} onClick={() => ed().set({ panel: t.id })}>
            {t.label}
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {panel === 'media' && <MediaBin />}
        {panel === 'captions' && <CaptionsPanel />}
        {panel === 'text' && <TextPanel />}
        {panel === 'templates' && <TemplatesPanel />}
      </div>
    </div>
  )
}

// ---------------- Mídia ----------------

function AssetThumb({ a }: { a: AssetInfo }) {
  if (a.kind === 'image') return <img src={mediaUrl(a.proxyPath)} className="w-full h-full object-contain" draggable={false} />
  if (a.kind === 'video') return <video src={mediaUrl(a.proxyPath) + '#t=0.5'} preload="metadata" muted className="w-full h-full object-contain pointer-events-none" />
  return <div className="w-full h-full flex items-center justify-center text-3xl text-[#59d68b]">♪</div>
}

function MediaBin() {
  const assets = useEditor((s) => s.project.assets)
  const tracks = useEditor((s) => s.project.tracks)
  const used = useMemo(() => new Set(tracks.flatMap((t) => t.items.map((i) => ('assetId' in i ? i.assetId : '')))), [tracks])
  return (
    <div className="p-3 flex flex-col gap-3">
      <button className="btn btn-primary w-full py-3" onClick={pickAndImport}>
        + Importar vídeos, imagens ou áudios
      </button>
      <div className="text-muted text-[11px] leading-relaxed">
        Arraste arquivos para cá ou direto na timeline. Dê duplo clique numa mídia para colocá-la na timeline, ou arraste até a faixa desejada.
      </div>
      <div className="grid grid-cols-2 gap-2">
        {assets.map((a) => (
          <div
            key={a.id}
            className="bg-panel2 border border-line rounded-lg overflow-hidden cursor-pointer hover:border-accent group relative"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-asset', a.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onDoubleClick={() => addAssetToTimeline(a.id)}
            title={a.originalPath}
          >
            <div className="h-[110px] bg-black">
              <AssetThumb a={a} />
            </div>
            <div className="px-2 py-1.5">
              <div className="truncate text-[12px]">{a.name}</div>
              <div className="text-muted text-[11px] flex gap-2">
                <span>{a.kind === 'video' ? 'Vídeo' : a.kind === 'image' ? 'Imagem' : 'Áudio'}</span>
                {a.duration > 0 && <span>{fmtTime(a.duration, 30).slice(0, 5)}</span>}
                {a.transcript && <span title="Transcrito">CC</span>}
              </div>
            </div>
            {!used.has(a.id) && (
              <button
                className="absolute top-1 right-1 btn btn-sm btn-icon opacity-0 group-hover:opacity-100"
                title="Remover do projeto"
                onClick={(e) => {
                  e.stopPropagation()
                  ed().commit((d) => {
                    d.assets = d.assets.filter((x) => x.id !== a.id)
                  })
                }}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------- Legendas ----------------

function CaptionsPanel() {
  const templates = useEditor((s) => s.project.templates)
  const glossary = useEditor((s) => s.project.glossary)
  const tracks = useEditor((s) => s.project.tracks)
  const time = useEditor((s) => s.time)
  const [tplId, setTplId] = useState(templates[0]?.id)
  const [status, setStatus] = useState<WhisperStatus | null>(null)
  const [model, setModel] = useState<string>('')
  const busy = useEditor((s) => Object.keys(s.tasks).some((k) => k.startsWith('transcribe')))

  useEffect(() => {
    window.api.whisperStatus().then((st) => {
      setStatus(st)
      setModel((m) => m || st.models[0] || '')
    })
  }, [busy])

  const captions = useMemo(() => {
    const out: CaptionItem[] = []
    for (const t of tracks) for (const i of t.items) if (i.type === 'caption') out.push(i)
    return out.sort((a, b) => a.start - b.start)
  }, [tracks])

  const installed = status && status.models.length > 0 && (status.cpu || status.cuda)

  return (
    <div className="p-3 flex flex-col gap-3">
      <div className="bg-panel2 border border-line rounded-lg p-3 flex flex-col gap-2">
        <div className="font-semibold">Legenda automática</div>
        <label className="text-muted text-[12px]">Modelo de legenda</label>
        <select className="field" value={tplId} onChange={(e) => setTplId(e.target.value)}>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        {installed ? (
          <>
            <label className="text-muted text-[12px]">Transcrição</label>
            <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
              {WHISPER_MODELS.filter((m) => status!.models.includes(m.id)).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} {status!.cuda && status!.hasNvidia ? '· GPU' : '· CPU'}
                </option>
              ))}
            </select>
            <button className="btn btn-primary py-2.5" disabled={busy} onClick={() => generateCaptions(tplId, model)}>
              {busy ? 'Transcrevendo…' : 'Gerar legendas (1 clique)'}
            </button>
            <button className="btn btn-sm" onClick={() => ed().set({ modal: { kind: 'whisper' } })}>
              Baixar outro modelo
            </button>
          </>
        ) : (
          <button className="btn btn-primary py-2.5" onClick={() => ed().set({ modal: { kind: 'whisper' } })}>
            Instalar transcrição (1ª vez)
          </button>
        )}
        <div className="text-muted text-[11px] leading-relaxed">
          A legenda é gerada a partir do que está na timeline (já com os cortes). Gerar de novo substitui a faixa "Legendas".
        </div>
      </div>

      <Glossary glossary={glossary} />

      <div className="flex items-center">
        <div className="font-semibold flex-1">Blocos ({captions.length})</div>
        <button className="btn btn-sm" onClick={() => exportSrt()} disabled={!captions.length}>
          Salvar .srt
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {captions.map((c) => (
          <CaptionRow key={c.id} c={c} active={time >= c.start && time < c.start + c.duration} />
        ))}
      </div>
    </div>
  )
}

function CaptionRow({ c, active }: { c: CaptionItem; active: boolean }) {
  const text = c.words.map((w) => w.text).join(' ')
  const [val, setVal] = useState(text)
  useEffect(() => setVal(text), [text])
  return (
    <div className={`flex gap-2 items-start p-1.5 rounded-md ${active ? 'bg-accent/20' : ''}`}>
      <button className="text-muted text-[11px] font-mono pt-1 hover:text-white" onClick={() => ed().set({ time: c.start + 0.001, selection: [c.id] })}>
        {fmtTime(c.start).slice(0, 5)}
      </button>
      <input
        className="field flex-1 text-[12px]"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onFocus={() => ed().set({ time: c.start + 0.001, selection: [c.id] })}
        onBlur={() => {
          if (val === text) return
          ed().commit((d) => {
            for (const t of d.tracks)
              for (const i of t.items) if (i.id === c.id && i.type === 'caption') i.words = retimeWords(i as CaptionItem, val)
          })
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  )
}

function Glossary({ glossary }: { glossary: { from: string; to: string }[] }) {
  const [open, setOpen] = useState(false)
  const update = (fn: (g: { from: string; to: string }[]) => void) =>
    ed().commit((d) => {
      fn(d.glossary)
    })
  return (
    <div className="bg-panel2 border border-line rounded-lg p-3 flex flex-col gap-2">
      <div className="flex items-center cursor-pointer" onClick={() => setOpen(!open)}>
        <div className="font-semibold flex-1">Glossário de correções ({glossary.length})</div>
        <span className="text-muted">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <>
          <div className="text-muted text-[11px]">Termos que a transcrição erra. Ex.: "cloud" → "Claude". Também ajuda o reconhecimento.</div>
          {glossary.map((g, i) => (
            <div key={i} className="flex gap-1 items-center">
              <input className="field flex-1 w-0" value={g.from} placeholder="ouvido como" onChange={(e) => update((gl) => void (gl[i].from = e.target.value))} />
              <span className="text-muted">→</span>
              <input className="field flex-1 w-0" value={g.to} placeholder="escrever" onChange={(e) => update((gl) => void (gl[i].to = e.target.value))} />
              <button className="btn btn-sm btn-icon" onClick={() => update((gl) => void gl.splice(i, 1))}>
                ✕
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button className="btn btn-sm" onClick={() => update((gl) => void gl.push({ from: '', to: '' }))}>
              + Termo
            </button>
            <button
              className="btn btn-sm"
              onClick={() => {
                window.api.settingsSet('glossary', ed().project.glossary)
                ed().notify('Glossário salvo como padrão para novos projetos')
              }}
            >
              Salvar como padrão
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------- Texto ----------------

const TEXT_PRESETS: { name: string; text: string; style: Partial<TextStyle> }[] = [
  { name: 'Título', text: 'TÍTULO', style: { size: 110, weight: 900 } },
  { name: 'Subtítulo', text: 'Subtítulo', style: { size: 64, weight: 600, uppercase: false, stroke: { color: '#000', width: 3 } } },
  { name: 'Destaque', text: 'DESTAQUE', style: { size: 80, weight: 800, box: { mode: 'block', color: '#7C3AED', radius: 18, padX: 24, padY: 10 }, stroke: { color: '#000', width: 0 } } },
  { name: 'Faixa preta', text: 'Texto informativo', style: { size: 54, weight: 600, uppercase: false, stroke: { color: '#000', width: 0 }, box: { mode: 'line', color: 'rgba(0,0,0,0.75)', radius: 10, padX: 20, padY: 8 } } },
  { name: 'Amarelo', text: 'ATENÇÃO', style: { size: 96, weight: 900, fill: '#FFE600' } }
]

function TextPanel() {
  return (
    <div className="p-3 flex flex-col gap-3">
      <button className="btn btn-primary py-2.5" onClick={addText}>
        + Adicionar texto
      </button>
      <div className="text-muted text-[11px]">Estilos prontos (entram no cursor da timeline):</div>
      <div className="grid grid-cols-2 gap-2">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.name}
            className="bg-[#0b0d11] border border-line rounded-lg h-[70px] hover:border-accent flex items-center justify-center px-2"
            onClick={() => {
              const s = ed()
              const id = uid()
              s.commit((d) => {
                const it = makeTextItem(s.time, d.settings.width, d.settings.height, p.text)
                it.id = id
                it.style = { ...baseTextStyle(), ...p.style } as TextStyle
                placeItem(d, it, 0)
              })
              ed().set({ selection: [id] })
            }}
          >
            <span
              style={{
                fontWeight: p.style.weight,
                color: p.style.fill ?? '#fff',
                background: p.style.box && p.style.box.mode !== 'none' ? p.style.box.color : undefined,
                padding: '2px 8px',
                borderRadius: 6,
                fontSize: 15,
                WebkitTextStroke: p.style.stroke?.width === 0 ? undefined : '0.6px #000'
              }}
            >
              {p.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// ---------------- Modelos ----------------

function TemplatesPanel() {
  const templates = useEditor((s) => s.project.templates)
  const apply = (tpl: CaptionTemplate) =>
    ed().commit((d) => {
      for (const t of d.tracks) for (const i of t.items) if (i.type === 'caption') i.templateId = tpl.id
    })
  return (
    <div className="p-3 flex flex-col gap-2">
      <div className="text-muted text-[11px]">Modelos de legenda. Edite um modelo e todas as legendas que o usam mudam juntas.</div>
      {templates.map((t) => (
        <div key={t.id} className="bg-panel2 border border-line rounded-lg p-2 flex flex-col gap-2">
          <div className="h-[64px] rounded-md bg-[linear-gradient(135deg,#334,#556)] flex items-center justify-center overflow-hidden">
            <span
              style={{
                fontFamily: `"${t.style.font}", Inter`,
                fontWeight: t.style.weight,
                fontSize: 20,
                color: t.style.fill,
                WebkitTextStroke: t.style.stroke.width ? `${Math.min(2, t.style.stroke.width / 3)}px ${t.style.stroke.color}` : undefined,
                paintOrder: 'stroke fill',
                textTransform: t.style.uppercase ? 'uppercase' : 'none',
                background: t.style.box.mode === 'block' || t.style.box.mode === 'line' ? t.style.box.color : undefined,
                padding: '2px 8px',
                borderRadius: 6
              }}
            >
              Exemplo de{' '}
              <span
                style={{
                  color: t.highlight.enabled ? t.highlight.color : undefined,
                  background: t.style.box.mode === 'word' ? t.highlight.boxColor : undefined,
                  borderRadius: 4,
                  padding: '0 3px'
                }}
              >
                legenda
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex-1 truncate font-medium">{t.name}</div>
            <button className="btn btn-sm" onClick={() => ed().set({ modal: { kind: 'template', id: t.id } })}>
              Editar
            </button>
            <button className="btn btn-sm" onClick={() => apply(t)} title="Aplicar a todas as legendas">
              Aplicar
            </button>
            <button
              className="btn btn-sm btn-icon"
              title="Duplicar"
              onClick={() => {
                const id = uid()
                ed().commit((d) => {
                  d.templates.push({ ...JSON.parse(JSON.stringify(t)), id, name: t.name + ' (cópia)' })
                })
                ed().set({ modal: { kind: 'template', id } })
              }}
            >
              ⧉
            </button>
            {templates.length > 1 && (
              <button
                className="btn btn-sm btn-icon"
                title="Excluir"
                onClick={() => {
                  if (!confirm(`Excluir o modelo "${t.name}"?`)) return
                  ed().commit((d) => {
                    d.templates = d.templates.filter((x) => x.id !== t.id)
                    const fallback = d.templates[0].id
                    for (const tr of d.tracks) for (const i of tr.items) if (i.type === 'caption' && i.templateId === t.id) i.templateId = fallback
                  })
                }}
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
