import { nanoid } from 'nanoid'
import type { CaptionTemplate, Project, TextStyle, Track, Transform } from './types'

export const uid = () => nanoid(10)

export const FORMATS = {
  '9:16': { width: 1080, height: 1920, label: 'Vertical 9:16 (1080x1920)' },
  '16:9': { width: 1920, height: 1080, label: 'Horizontal 16:9 (1920x1080)' }
} as const

export function defaultTransform(w: number, h: number): Transform {
  return { x: w / 2, y: h / 2, scale: 1, rotation: 0, opacity: 1 }
}

export function baseTextStyle(): TextStyle {
  return {
    font: 'Inter',
    weight: 800,
    italic: false,
    size: 75,
    uppercase: true,
    fill: '#ffffff',
    stroke: { color: '#000000', width: 5 },
    shadow: { color: 'rgba(0,0,0,0.55)', blur: 12, x: 0, y: 4 },
    box: { mode: 'none', color: 'rgba(0,0,0,0.6)', radius: 18, padX: 20, padY: 10 },
    align: 'center',
    lineHeight: 1.15,
    letterSpacing: 0
  }
}

/** Modelos de legenda prontos. O primeiro segue o REGRAS-DE-EDICAO.md (Regra 2). */
export function builtinTemplates(): CaptionTemplate[] {
  const reels: CaptionTemplate = {
    id: 'reels-padrao',
    name: 'Reels Padrão',
    style: baseTextStyle(),
    highlight: { enabled: false, color: '#FFE600', scale: 1, boxColor: '#7C3AED' },
    animation: { type: 'none', target: 'block', duration: 0.15 },
    marginBottom: 380,
    marginX: 80,
    maxLines: 2,
    wordsMin: 3,
    wordsMax: 6,
    minBlockDur: 0.6
  }
  const karaoke: CaptionTemplate = {
    ...structuredClone(reels),
    id: 'karaoke-amarelo',
    name: 'Karaokê Amarelo',
    highlight: { enabled: true, color: '#FFE600', scale: 1, boxColor: '#7C3AED' },
    animation: { type: 'pop', target: 'block', duration: 0.18 }
  }
  const caixa: CaptionTemplate = {
    ...structuredClone(reels),
    id: 'palavra-caixa',
    name: 'Palavra em Caixa',
    style: { ...baseTextStyle(), stroke: { color: '#000000', width: 4 }, box: { mode: 'word', color: '#7C3AED', radius: 16, padX: 14, padY: 6 } },
    highlight: { enabled: true, color: '#FFFFFF', scale: 1, boxColor: '#7C3AED' },
    animation: { type: 'pop', target: 'word', duration: 0.15 },
    wordsMin: 2,
    wordsMax: 4
  }
  const fundo: CaptionTemplate = {
    ...structuredClone(reels),
    id: 'bloco-fundo',
    name: 'Bloco com Fundo',
    style: {
      ...baseTextStyle(),
      weight: 700,
      size: 64,
      stroke: { color: '#000000', width: 0 },
      shadow: { color: 'rgba(0,0,0,0)', blur: 0, x: 0, y: 0 },
      box: { mode: 'line', color: 'rgba(0,0,0,0.75)', radius: 14, padX: 22, padY: 8 }
    },
    animation: { type: 'fade', target: 'block', duration: 0.15 }
  }
  return [reels, karaoke, caixa, fundo]
}

export function newTrack(name: string): Track {
  return { id: uid(), name, hidden: false, muted: false, locked: false, items: [] }
}

export function newProject(): Project {
  return {
    version: 1,
    name: 'Sem título',
    settings: { width: 1080, height: 1920, fps: 30, background: '#000000' },
    assets: [],
    tracks: [newTrack('Faixa 1')],
    templates: builtinTemplates(),
    glossary: [{ from: 'cloud', to: 'Claude' }],
    markers: []
  }
}
