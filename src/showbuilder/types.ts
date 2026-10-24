import type { Node, Edge } from 'reactflow'

export type ShowSummary = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type Show = ShowSummary & {
  nodes: Node[]
  edges: Edge[]
  showProps?: string[]
}

export type TrickProp = {
  name: string
  reusable?: boolean
}

export type Trick = {
  id: string
  name: string
  description?: string
  script?: string
  source?: string
  props?: TrickProp[]
  duration?: string
  notes?: string
  tagIds?: string[]
  preferredWidth?: number
  preferredHeight?: number
  createdAt: string
  updatedAt: string
}

export type Tag = {
  id: string
  name: string
  color?: string
  createdAt: string
  updatedAt: string
}

export type AudioFile = {
  id: string
  displayName: string
  originalFilename: string
  storedFilename: string
  mimeType: string
  size: number
  createdAt: string
  updatedAt: string
}

export type Music = {
  id: string
  name: string
  description?: string
  startCue?: string
  stopCue?: string
  audioFileId?: string | null
  createdAt: string
  updatedAt: string
}

export type Other = {
  id: string
  name: string
  description?: string
  duration?: string
  color?: string
  props?: TrickProp[]
  preferredWidth?: number
  preferredHeight?: number
  createdAt: string
  updatedAt: string
}
