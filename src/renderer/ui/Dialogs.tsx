import type { Draft } from 'immer'
import { useEffect, useMemo, useRef, useState } from 'react'
import { WHISPER_MODELS, type AppInfo, type GpuInfo, type WhisperStatus } from '../../shared/api'
import { errMsg, generateCaptions, mergeTemplates, requestCancelExport, runExport } from '../actions'
import { drawCaption } from '../engine/captionRender'
import { captionItemsOf } from '../engine/exporter'
import { DEFAULT_SILENCE, detectSpeech, keptDuration, type SilenceOptions } from '../features/autoCut'
import { applyKeepRanges, findItem } from '../state/commands'
import { defaultTransform } from '../state/defaults'
import { ed, useEditor } from '../state/store'
import type { CaptionItem, CaptionTemplate, Project, VideoItem, AudioItem } from '../state/types'
import { ColorField, Modal, NumberField, ProgressBar, Row, Select, Slider, Toggle } from './controls'
import { StyleEditor } from './StyleEditor'
import { loadWave } from './waveCache'

export function Dialogs() {
  const modal = useEditor((s) => s.modal)
  const close = () => ed().set({ modal: null })
  if (!modal) return null
  switch (modal.kind) {
    case 'export':
      return <ExportDialog onClose={close} />
    case 'autocut':
      return <AutoCutDialog onClose={close} />
    case 'template':
      return <TemplateDialog id={modal.id} onClose={close} />
    case 'whisper':
      return <WhisperDialog onClose={close} />
    case 'settings':
      return <SettingsDialog onClose={close} />
  }
}

// ---------------- Exportar ----------------

const QUALITY = [
  { value: '16000', label: 'Alta (16 Mbps)' },
  { value: '10000', label: 'Média (10 Mbps)' },
  { value: '6000', label: 'Leve (6 Mbps)' }
]

function ExportDialog({ onClose }: { onClose: () => void }) {
  const p = useEditor((s) => s.project)
  const filePath = useEditor((s) => s.filePath)
  const task = useEditor((s) => s.tasks['export'])
  const hasCaptions = captionItemsOf(p).length > 0
  const firstVideo = p.assets.find((a) => a.kind === 'video')
  const defaultPath = useMemo(() => {
    const base = filePath ? filePath.replace(/\.vproj$/i, '') : firstVideo ? firstVideo.originalPath.replace(/\.[^.\\/]+$/, '') : p.name
    return `${base}${hasCaptions ? ' - legendado' : ' - editado'}.mp4`
  }, [filePath, firstVideo, p.name, hasCaptions])
  const [out, setOut] = useState(defaultPath)
  const [bitrate, setBitrate] = useState('16000')
  const [scale, setScale] = useState('1')
  const [srt, setSrt] = useState(hasCaptions)
  const W = Math.round((p.settings.width * parseFloat(scale)) / 2) * 2
  const H = Math.round((p.settings.height * parseFloat(scale)) / 2) * 2

  return (
    <Modal
      title="Exportar vídeo"
      onClose={() => !task && onClose()}
      footer={
        task ? (
          <button className="btn" onClick={requestCancelExport}>
            Cancelar
          </button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Fechar
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                const ok = await runExport({ out, bitrate: Math.round(parseInt(bitrate, 10) * parseFloat(scale) ** 1.5), scale: parseFloat(scale), srt })
                if (ok) onClose()
              }}
            >
              Exportar MP4
            </button>
          </>
        )
      }
    >
      <Row label="Arquivo">
        <input className="field flex-1 text-[12px]" value={out} onChange={(e) => setOut(e.target.value)} />
        <button
          className="btn btn-sm"
          onClick={async () => {
            const r = await window.api.saveDialog({ title: 'Salvar vídeo', defaultPath: out, filters: [{ name: 'MP4', extensions: ['mp4'] }] })
            if (r) setOut(r)
          }}
        >
          …
        </button>
      </Row>
      <Row label="Resolução">
        <Select
          value={scale}
          onChange={setScale}
          options={[
            { value: '1', label: `${p.settings.width}x${p.settings.height} (original)` },
            { value: String(2 / 3), label: `${Math.round((p.settings.width * 2) / 3)}x${Math.round((p.settings.height * 2) / 3)} (720p)` }
          ]}
        />
      </Row>
      <Row label="Qualidade">
        <Select value={bitrate} onChange={setBitrate} options={QUALITY} />
      </Row>
      <Row label="FPS">
        <span>{+p.settings.fps.toFixed(3)} (do projeto)</span>
      </Row>
      <Row label="Legenda">
        <Toggle checked={srt} onChange={setSrt} label={hasCaptions ? 'Gerar também o arquivo .srt' : 'Sem legendas na timeline'} />
      </Row>
      <div className="text-muted text-[11px]">
        Saída {W}x{H} H.264 + AAC. O vídeo original nunca é alterado.
      </div>
      {task && (
        <div className="flex flex-col gap-2">
          <div className="text-[12px]">{task.label}</div>
          <ProgressBar value={task.progress} />
        </div>
      )}
    </Modal>
  )
}

// ---------------- Corte automático ----------------

function AutoCutDialog({ onClose }: { onClose: () => void }) {
  const p = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const targets = useMemo(() => {
    const sel = selection.map((id) => findItem(p, id)?.item).filter((i): i is VideoItem | AudioItem => !!i && (i.type === 'video' || i.type === 'audio'))
    if (sel.length) return sel
    const all: VideoItem[] = []
    for (const t of p.tracks) if (!t.locked) for (const i of t.items) if (i.type === 'video') all.push(i)
    return all
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [opts, setOpts] = useState<SilenceOptions>({ ...DEFAULT_SILENCE })
  const [auto, setAuto] = useState(true)
  const [thr, setThr] = useState(-40)
  const [zoom, setZoom] = useState(false)
  const [result, setResult] = useState<{ id: string; keep: [number, number][]; before: number }[]>([])
  const [autoThr, setAutoThr] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const res: typeof result = []
      let firstThr: number | null = null
      for (const it of targets) {
        const a = p.assets.find((x) => x.id === it.assetId)
        if (!a) continue
        const wave = await loadWave(a)
        if (!wave) continue
        const r = detectSpeech(wave, it.inPoint, it.inPoint + it.duration, { ...opts, thresholdDb: auto ? null : thr })
        firstThr ??= r.thresholdDb
        res.push({ id: it.id, keep: r.keep, before: it.duration })
      }
      if (!alive) return
      setResult(res)
      setAutoThr(firstThr)
      ed().set({
        cutPreview: res.map((r) => {
          const it = targets.find((t) => t.id === r.id)!
          const remove: [number, number][] = []
          let cur = it.inPoint
          for (const [s, e] of r.keep) {
            if (s > cur + 1e-3) remove.push([cur, s])
            cur = e
          }
          if (it.inPoint + it.duration > cur + 1e-3) remove.push([cur, it.inPoint + it.duration])
          return { itemId: r.id, remove }
        })
      })
    })()
    return () => {
      alive = false
    }
  }, [opts, auto, thr, targets, p.assets])

  const close = () => {
    ed().set({ cutPreview: null })
    onClose()
  }
  const before = result.reduce((a, r) => a + r.before, 0)
  const after = result.reduce((a, r) => a + keptDuration(r.keep), 0)
  const noAudio = targets.length > 0 && result.length === 0

  return (
    <Modal
      title="Corte automático de silêncio"
      onClose={close}
      width={560}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancelar
          </button>
          <button
            className="btn btn-primary"
            disabled={!result.length}
            onClick={() => {
              ed().commit((d) => {
                for (const r of result) if (r.keep.length) applyKeepRanges(d, r.id, r.keep, zoom)
              })
              ed().notify(`Silêncios removidos: ${(before - after).toFixed(1)}s a menos`)
              close()
            }}
          >
            Aplicar cortes
          </button>
        </>
      }
    >
      <div className="text-[12px] text-muted">
        {targets.length === 0
          ? 'Nenhum vídeo na timeline.'
          : selection.length
            ? `Aplicando em ${targets.length} clipe(s) selecionado(s).`
            : `Aplicando em todos os ${targets.length} vídeo(s) da timeline. Selecione clipes para limitar.`}{' '}
        As partes em vermelho na timeline serão removidas.
      </div>
      {noAudio && <div className="text-[#ffb86b] text-[12px]">Os clipes escolhidos não têm áudio.</div>}
      <Row label="Volume mínimo">
        <Toggle checked={auto} onChange={setAuto} label="Automático" />
        {auto && autoThr !== null && <span className="text-muted text-[12px]">({autoThr.toFixed(0)} dB)</span>}
      </Row>
      {!auto && (
        <Row label="Limiar">
          <Slider value={thr} min={-70} max={-10} step={1} onChange={setThr} />
          <span className="w-14 text-right text-[12px]">{thr} dB</span>
        </Row>
      )}
      <Row label="Silêncio mín.">
        <NumberField value={opts.minSilence} step={0.05} digits={2} min={0.1} max={3} suffix="s" onChange={(v) => setOpts({ ...opts, minSilence: v })} />
        <span className="text-muted text-[11px]">pausas maiores que isso são cortadas</span>
      </Row>
      <Row label="Respiro">
        <NumberField value={opts.keepGap} step={0.05} digits={2} min={0} max={1} suffix="s" onChange={(v) => setOpts({ ...opts, keepGap: v })} />
        <span className="text-muted text-[11px]">mantido entre as frases</span>
      </Row>
      <Row label="Ignorar ruídos">
        <NumberField value={opts.minSpeech} step={0.01} digits={2} min={0} max={0.5} suffix="s" onChange={(v) => setOpts({ ...opts, minSpeech: v })} />
        <span className="text-muted text-[11px]">estalos mais curtos que isso</span>
      </Row>
      <Toggle checked={zoom} onChange={setZoom} label="Zoom alternado de 8% nos cortes (disfarça o pulo)" />
      {result.length > 0 && (
        <div className="bg-panel2 border border-line rounded-lg p-3 text-[13px]">
          Duração: <b>{before.toFixed(1)}s</b> → <b className="text-accent2">{after.toFixed(1)}s</b> ({(before - after).toFixed(1)}s de silêncio removidos, {result.reduce((a, r) => a + Math.max(0, r.keep.length - 1), 0)} cortes)
        </div>
      )}
    </Modal>
  )
}

// ---------------- Editor de modelo de legenda ----------------

const SAMPLE = ['ISSO', 'É', 'UM', 'EXEMPLO', 'DE', 'LEGENDA']

function TemplatePreview({ tpl, W, H }: { tpl: CaptionTemplate; W: number; H: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const tplRef = useRef(tpl)
  tplRef.current = tpl
  const pw = W > H ? 400 : 240
  const ph = Math.round((pw * H) / W)
  useEffect(() => {
    const c = ref.current!
    c.width = pw * 2
    c.height = ph * 2
    const ctx = c.getContext('2d')!
    const item: CaptionItem = {
      id: 'preview',
      type: 'caption',
      start: 0,
      duration: 2.6,
      transform: defaultTransform(W, H),
      keyframes: {},
      templateId: tpl.id,
      words: SAMPLE.map((t, i) => ({ text: t, start: i * 0.35, end: i * 0.35 + 0.33 }))
    }
    let raf = 0
    const t0 = performance.now()
    const tick = () => {
      const t = ((performance.now() - t0) / 1000) % 3
      const g = ctx.createLinearGradient(0, 0, c.width, c.height)
      g.addColorStop(0, '#4a5568')
      g.addColorStop(1, '#a0aec0')
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, c.width, c.height)
      const k = c.width / W
      ctx.setTransform(k, 0, 0, k, 0, 0)
      if (t < 2.6) drawCaption(ctx, item, tplRef.current, t, W, H)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [W, H, pw, ph, tpl.id])
  return <canvas ref={ref} style={{ width: pw, height: ph }} className="rounded-lg border border-line shrink-0" />
}

function TemplateDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const tpl = useEditor((s) => s.project.templates.find((t) => t.id === id))
  const settings = useEditor((s) => s.project.settings)
  useEffect(() => {
    ed().gestureStart()
    return () => ed().gestureEnd()
  }, [])
  if (!tpl) return null
  const upd = (fn: (t: Draft<CaptionTemplate>) => void) =>
    ed().gestureUpdate((d: Draft<Project>) => {
      const t = d.templates.find((x) => x.id === id)
      if (t) fn(t)
    })
  return (
    <Modal
      title="Modelo de legenda"
      onClose={onClose}
      width={880}
      footer={
        <>
          <button
            className="btn"
            onClick={async () => {
              const lib = (await window.api.settingsGet<CaptionTemplate[]>('templates')) ?? []
              await window.api.settingsSet('templates', mergeTemplates(lib, [JSON.parse(JSON.stringify(tpl))]))
              ed().notify('Modelo salvo na biblioteca (disponível em novos projetos)')
            }}
          >
            Salvar na biblioteca
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Concluir
          </button>
        </>
      }
    >
      <div className="flex gap-5">
        <div className="flex flex-col gap-2 items-center">
          <TemplatePreview tpl={tpl} W={settings.width} H={settings.height} />
          <div className="text-muted text-[11px]">Prévia ao vivo</div>
        </div>
        <div className="flex-1 grid grid-cols-2 gap-x-5 gap-y-2 min-w-0">
          <div className="flex flex-col gap-2 min-w-0">
            <Row label="Nome">
              <input className="field flex-1" value={tpl.name} onChange={(e) => upd((t) => void (t.name = e.target.value))} />
            </Row>
            <StyleEditor style={tpl.style} onChange={(st) => upd((t) => void (t.style = st))} />
          </div>
          <div className="flex flex-col gap-2 min-w-0">
            <div className="font-semibold text-[12px] uppercase text-[#c9cede]">Palavra falada</div>
            <Toggle checked={tpl.highlight.enabled} onChange={(v) => upd((t) => void (t.highlight.enabled = v))} label="Destacar a palavra falada (karaokê)" />
            {tpl.highlight.enabled && (
              <>
                <Row label="Cor">
                  <ColorField value={tpl.highlight.color} onChange={(v) => upd((t) => void (t.highlight.color = v))} />
                </Row>
                <Row label="Escala">
                  <NumberField value={tpl.highlight.scale * 100} min={50} max={200} suffix="%" onChange={(v) => upd((t) => void (t.highlight.scale = v / 100))} />
                </Row>
              </>
            )}
            {tpl.style.box.mode === 'word' && (
              <Row label="Caixa ativa">
                <ColorField value={tpl.highlight.boxColor} alpha onChange={(v) => upd((t) => void (t.highlight.boxColor = v))} />
              </Row>
            )}
            <div className="font-semibold text-[12px] uppercase text-[#c9cede] mt-2">Animação de entrada</div>
            <Row label="Tipo">
              <Select
                value={tpl.animation.type}
                onChange={(v) => upd((t) => void (t.animation.type = v))}
                options={[
                  { value: 'none', label: 'Nenhuma' },
                  { value: 'pop', label: 'Pop' },
                  { value: 'bounce', label: 'Pulo' },
                  { value: 'fade', label: 'Fade' },
                  { value: 'slide', label: 'Subir' }
                ]}
              />
            </Row>
            {tpl.animation.type !== 'none' && (
              <>
                <Row label="Aplicar em">
                  <Select
                    value={tpl.animation.target}
                    onChange={(v) => upd((t) => void (t.animation.target = v))}
                    options={[
                      { value: 'block', label: 'Bloco inteiro' },
                      { value: 'word', label: 'Cada palavra (aparece ao ser falada)' }
                    ]}
                  />
                </Row>
                <Row label="Duração">
                  <NumberField value={tpl.animation.duration} step={0.01} digits={2} min={0.03} max={1} suffix="s" onChange={(v) => upd((t) => void (t.animation.duration = v))} />
                </Row>
              </>
            )}
            <div className="font-semibold text-[12px] uppercase text-[#c9cede] mt-2">Posição e blocos</div>
            <Row label="Margem inf.">
              <NumberField value={tpl.marginBottom} min={0} max={1900} suffix="px" onChange={(v) => upd((t) => void (t.marginBottom = v))} />
            </Row>
            <Row label="Margem lat.">
              <NumberField value={tpl.marginX} min={0} max={500} suffix="px" onChange={(v) => upd((t) => void (t.marginX = v))} />
            </Row>
            <Row label="Máx. linhas">
              <NumberField value={tpl.maxLines} min={1} max={5} onChange={(v) => upd((t) => void (t.maxLines = Math.round(v)))} />
            </Row>
            <Row label="Palavras">
              <NumberField value={tpl.wordsMin} min={1} max={12} width={44} onChange={(v) => upd((t) => void (t.wordsMin = Math.round(v)))} />
              <span className="text-muted">a</span>
              <NumberField value={tpl.wordsMax} min={1} max={20} width={44} onChange={(v) => upd((t) => void (t.wordsMax = Math.round(v)))} />
            </Row>
            <Row label="Tempo mín.">
              <NumberField value={tpl.minBlockDur} step={0.05} digits={2} min={0.1} max={3} suffix="s" onChange={(v) => upd((t) => void (t.minBlockDur = v))} />
            </Row>
            <div className="text-muted text-[11px]">Palavras por bloco e tempo mínimo valem na próxima vez que gerar as legendas.</div>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ---------------- Instalação da transcrição ----------------

function WhisperDialog({ onClose }: { onClose: () => void }) {
  const [st, setSt] = useState<WhisperStatus | null>(null)
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  const [model, setModel] = useState(WHISPER_MODELS[0].id)
  const [cuda, setCuda] = useState(false)
  const [busy, setBusy] = useState(false)
  const task = useEditor((s) => s.tasks['whisper-install'])
  useEffect(() => {
    window.api.whisperStatus().then((s) => {
      setSt(s)
      setCuda(s.hasNvidia)
      const missing = WHISPER_MODELS.find((m) => !s.models.includes(m.id))
      if (s.models.length && missing) setModel(missing.id)
    })
    window.api.gpuInfo().then(setGpu)
  }, [])
  const install = async () => {
    setBusy(true)
    ed().setTask('whisper-install', { progress: 0, label: 'Preparando download' })
    try {
      await window.api.whisperInstall(model, cuda)
      ed().notify('Transcrição instalada!')
      onClose()
      generateCaptions()
    } catch (e) {
      ed().notify('Falha na instalação: ' + errMsg(e), 'error')
    } finally {
      ed().setTask('whisper-install', null)
      setBusy(false)
    }
  }
  const sel = WHISPER_MODELS.find((m) => m.id === model)!
  const needCuda = cuda && !st?.cuda
  const total = (st?.models.includes(model) ? 0 : sel.sizeMb) + (needCuda ? 690 : 0) + (st?.cpu ? 0 : 9)
  return (
    <Modal
      title="Instalar transcrição automática"
      onClose={() => !busy && onClose()}
      footer={
        <>
          <button className="btn" disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button className="btn btn-primary" disabled={busy} onClick={install}>
            {total > 0 ? `Baixar e instalar (~${total} MB)` : 'Pronto, continuar'}
          </button>
        </>
      }
    >
      <div className="text-[13px] leading-relaxed">
        A legenda é feita <b>100% no seu computador</b> (Whisper). Isso é baixado só uma vez e fica na pasta <i>EditorVideo-dados</i>, ao lado do programa.
      </div>
      <div className="text-[12px] text-muted">{gpu?.hasNvidia ? `Placa detectada: ${gpu.gpuName}` : 'Nenhuma placa NVIDIA detectada — será usada a CPU.'}</div>
      <div className="flex flex-col gap-2">
        {WHISPER_MODELS.map((m) => (
          <label key={m.id} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer ${model === m.id ? 'border-accent bg-accent/10' : 'border-line'}`}>
            <input type="radio" checked={model === m.id} onChange={() => setModel(m.id)} />
            <div className="flex-1">
              <div className="font-medium">{m.label}</div>
              <div className="text-muted text-[11px]">{m.id.startsWith('large') ? 'Melhor precisão em português. Recomendado com placa NVIDIA.' : 'Mais leve e rápido na CPU, um pouco menos preciso.'}</div>
            </div>
            {st?.models.includes(m.id) && <span className="text-[11px] text-[#59d68b]">instalado</span>}
          </label>
        ))}
      </div>
      {st?.hasNvidia && <Toggle checked={cuda} onChange={setCuda} label={`Usar a placa NVIDIA (muito mais rápido; +690 MB)${st.cuda ? ' — já instalado' : ''}`} />}
      {task && (
        <div className="flex flex-col gap-2">
          <div className="text-[12px]">{task.label}</div>
          <ProgressBar value={task.progress} />
        </div>
      )}
    </Modal>
  )
}

// ---------------- Configurações ----------------

function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [gpu, setGpu] = useState<GpuInfo | null>(null)
  useEffect(() => {
    window.api.appInfo().then(setInfo)
    window.api.gpuInfo().then(setGpu)
  }, [])
  return (
    <Modal title="Configurações" onClose={onClose}>
      <Row label="Versão">{info?.version}</Row>
      <Row label="Dados">
        <span className="text-[12px] break-all flex-1">{info?.dataDir}</span>
        <button className="btn btn-sm" onClick={() => info && window.api.showInFolder(info.dataDir + '\\configuracoes.json')}>
          Abrir
        </button>
      </Row>
      <Row label="Placa">{gpu ? gpu.gpuName ?? 'Sem NVIDIA' : '…'}</Row>
      <Row label="Encoder">{gpu?.ffmpegH264}</Row>
      <div className="flex gap-2">
        <button
          className="btn"
          onClick={async () => {
            if (!confirm('Apagar os arquivos convertidos (cache)? Projetos abertos vão reconverter as mídias quando forem abertos de novo.')) return
            const n = await window.api.clearCache()
            ed().notify(`${(n / 1e6).toFixed(0)} MB liberados`)
          }}
        >
          Limpar cache de mídia
        </button>
        <button className="btn" onClick={() => window.appCtl.toggleDevTools()}>
          Ferramentas do desenvolvedor
        </button>
      </div>
    </Modal>
  )
}
