import type { AssetInfo, Word } from '../../shared/api'

export type Id = string

export type AnimProp = 'x' | 'y' | 'scale' | 'rotation' | 'opacity'
export const ANIM_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity']

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export interface Keyframe {
  /** segundos relativos ao início do item */
  t: number
  v: number
  ease: Easing
}

export interface Transform {
  /** centro do item em pixels do projeto */
  x: number
  y: number
  /** 1 = encaixado no quadro (contain) */
  scale: number
  /** graus */
  rotation: number
  /** 0..1 */
  opacity: number
}

/** Retângulo de recorte em coordenadas do projeto (não se move com o item) */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ItemBase {
  id: Id
  /** posição na timeline (s) */
  start: number
  duration: number
  transform: Transform
  keyframes: Partial<Record<AnimProp, Keyframe[]>>
  mask?: Rect
  /** tela dividida */
  layout?: { kind: 'split'; group: Id; role: 'top' | 'bottom'; ratio: number }
}

export interface VideoItem extends ItemBase {
  type: 'video'
  assetId: Id
  inPoint: number
  volume: number
  muted: boolean
  fadeIn: number
  fadeOut: number
}

export interface ImageItem extends ItemBase {
  type: 'image'
  assetId: Id
}

export interface AudioItem extends ItemBase {
  type: 'audio'
  assetId: Id
  inPoint: number
  volume: number
  muted: boolean
  fadeIn: number
  fadeOut: number
}

export interface TextStyle {
  font: string
  weight: number
  italic: boolean
  size: number
  uppercase: boolean
  fill: string
  stroke: { color: string; width: number }
  shadow: { color: string; blur: number; x: number; y: number }
  /** caixa de fundo */
  box: { mode: 'none' | 'block' | 'line' | 'word'; color: string; radius: number; padX: number; padY: number }
  align: 'left' | 'center' | 'right'
  lineHeight: number
  letterSpacing: number
}

export interface TextItem extends ItemBase {
  type: 'text'
  text: string
  style: TextStyle
  /** largura máxima para quebra de linha (px do projeto) */
  maxWidth: number
}

export interface CaptionWord extends Word {}

export interface CaptionItem extends ItemBase {
  type: 'caption'
  /** tempos relativos ao início do item */
  words: CaptionWord[]
  templateId: Id
}

export type Item = VideoItem | ImageItem | AudioItem | TextItem | CaptionItem
export type ItemType = Item['type']

export interface Track {
  id: Id
  name: string
  hidden: boolean
  muted: boolean
  locked: boolean
  /** faixa gerada pela legenda automática (substituída ao gerar de novo) */
  captions?: boolean
  items: Item[]
}

export interface CaptionTemplate {
  id: Id
  name: string
  style: TextStyle
  highlight: { enabled: boolean; color: string; scale: number; boxColor: string }
  animation: { type: 'none' | 'pop' | 'fade' | 'slide' | 'bounce'; target: 'block' | 'word'; duration: number }
  /** distância da base do texto até o fim do quadro (px, referência 1920 de altura) */
  marginBottom: number
  marginX: number
  maxLines: number
  wordsMin: number
  wordsMax: number
  minBlockDur: number
}

export interface GlossaryEntry {
  from: string
  to: string
}

export type SafePlatform = 'reels' | 'tiktok' | 'shorts'

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  background: string
}

export interface Project {
  version: number
  name: string
  settings: ProjectSettings
  assets: AssetInfo[]
  tracks: Track[]
  templates: CaptionTemplate[]
  glossary: GlossaryEntry[]
  markers: number[]
}

export type { AssetInfo, Word }
