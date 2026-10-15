import { generateCaptions, newProjectAction, openProject, pickAndImport, saveProject } from '../actions'
import { SAFE_AREAS } from '../features/layout'
import { applySplitScreen, findItem } from '../state/commands'
import { FORMATS } from '../state/defaults'
import { ed, useEditor } from '../state/store'
import type { SafePlatform } from '../state/types'

export function changeFormat(fmt: keyof typeof FORMATS): void {
  const s = ed()
  const { width: W, height: H } = FORMATS[fmt]
  const { width: oW, height: oH } = s.project.settings
  if (W === oW && H === oH) return
  s.commit((d) => {
    d.settings.width = W
    d.settings.height = H
    const kx = W / oW
    const ky = H / oH
    for (const t of d.tracks)
      for (const it of t.items) {
        it.transform.x *= kx
        it.transform.y *= ky
        for (const k of ['x', 'y'] as const) for (const f of it.keyframes[k] ?? []) f.v *= k === 'x' ? kx : ky
        if (it.mask) it.mask = { x: it.mask.x * kx, y: it.mask.y * ky, w: it.mask.w * kx, h: it.mask.h * ky }
        if (it.type === 'text') it.maxWidth = W * 0.85
      }
  })
}

export function splitScreenAction(): void {
  const s = ed()
  const vids = s.selection.map((id) => findItem(s.project, id)?.item).filter((i) => i && (i.type === 'video' || i.type === 'image'))
  if (vids.length !== 2) {
    s.notify('Selecione 2 vídeos na timeline (Ctrl + clique) e clique em "Tela dividida".', 'error')
    return
  }
  // o que está mais acima na lista de faixas (ou começou antes) fica em cima
  const [a, b] = vids as NonNullable<(typeof vids)[number]>[]
  s.commit((d) => applySplitScreen(d, a.id, b.id, 0.5))
  s.notify('Tela dividida criada. Ajuste a divisão no painel à direita.')
}

export function TopBar() {
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const settings = useEditor((s) => s.project.settings)
  const name = useEditor((s) => s.project.name)
  const dirty = useEditor((s) => s.dirty)
  const safe = useEditor((s) => s.safe)
  const set = useEditor((s) => s.set)
  const fmt = settings.width > settings.height ? '16:9' : '9:16'

  return (
    <div className="h-12 shrink-0 flex items-center gap-2 px-3 border-b border-line bg-panel">
      <div className="font-extrabold tracking-tight text-[15px] mr-2">
        <span className="text-accent2">Editor</span>Video
      </div>
      <button className="btn btn-sm" onClick={newProjectAction} title="Novo (Ctrl+N)">
        Novo
      </button>
      <button className="btn btn-sm" onClick={() => openProject()} title="Abrir (Ctrl+O)">
        Abrir
      </button>
      <button className="btn btn-sm" onClick={() => saveProject()} title="Salvar (Ctrl+S)">
        Salvar
      </button>
      <button className="btn btn-sm" onClick={pickAndImport} title="Importar (Ctrl+I)">
        + Importar
      </button>
      <div className="w-px h-6 bg-line mx-1" />
      <button className="btn btn-sm btn-icon" disabled={!canUndo} onClick={() => ed().undo()} title="Desfazer (Ctrl+Z)">
        ↶
      </button>
      <button className="btn btn-sm btn-icon" disabled={!canRedo} onClick={() => ed().redo()} title="Refazer (Ctrl+Y)">
        ↷
      </button>
      <div className="w-px h-6 bg-line mx-1" />
      <select className="field" value={fmt} onChange={(e) => changeFormat(e.target.value as keyof typeof FORMATS)} title="Formato do vídeo">
        {Object.entries(FORMATS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 ml-2 cursor-pointer" title="Mostrar a interface do app por cima do vídeo">
        <input type="checkbox" checked={safe.show} onChange={(e) => set({ safe: { ...safe, show: e.target.checked } })} />
        Área segura
      </label>
      <select className="field" value={safe.platform} onChange={(e) => set({ safe: { ...safe, platform: e.target.value as SafePlatform } })}>
        {Object.entries(SAFE_AREAS).map(([k, v]) => (
          <option key={k} value={k}>
            {v.label}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 cursor-pointer" title="Camadas grudam nas bordas da área segura ao arrastar">
        <input type="checkbox" checked={safe.snap} onChange={(e) => set({ safe: { ...safe, snap: e.target.checked } })} />
        Ímã
      </label>

      <div className="flex-1 text-center text-muted truncate">
        {name}
        {dirty ? ' •' : ''}
      </div>

      <button className="btn btn-sm" onClick={() => set({ modal: { kind: 'autocut' } })} title="Remove os silêncios do vídeo">
        ✂ Corte automático
      </button>
      <button className="btn btn-sm" onClick={splitScreenAction} title="Selecione 2 vídeos">
        ⬒ Tela dividida
      </button>
      <button className="btn btn-sm" onClick={() => generateCaptions()} title="Transcreve e cria a legenda">
        CC Legendar
      </button>
      <button className="btn btn-sm btn-icon" onClick={() => set({ modal: { kind: 'settings' } })} title="Configurações">
        ⚙
      </button>
      <button className="btn btn-primary" onClick={() => set({ modal: { kind: 'export' } })} title="Exportar (Ctrl+E)">
        Exportar
      </button>
    </div>
  )
}
