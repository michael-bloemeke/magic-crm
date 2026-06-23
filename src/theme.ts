// Color schemes for the app. The actual color values live as CSS variables in
// index.css: the @theme block defines EMBER (the default), and a
// :root[data-theme="fism"] block overrides them for FISM. Switching a theme just
// sets data-theme on <html>; the swatches below are only for the picker preview.

export type ThemeId = 'ember' | 'fism'

export type Theme = {
  id: ThemeId
  label: string
  tagline: string
  // Preview swatch (independent of the CSS so the dropdown can render instantly).
  swatch: { bg: string; surface: string; accent: string }
}

export const THEMES: Theme[] = [
  {
    id: 'ember',
    label: 'Ember',
    tagline: 'Warm near-black & brass',
    swatch: { bg: '#100e0c', surface: '#221d17', accent: '#cb9b5d' },
  },
  {
    id: 'fism',
    label: 'FISM',
    tagline: 'Royal navy & gold',
    swatch: { bg: '#0a0e1f', surface: '#182241', accent: '#c9a961' },
  },
]

// Bumped to -v2 so the new FISM default takes effect even where an older 'ember' value was
// already saved (e.g. the first Electron launch before FISM became the default).
const STORAGE_KEY = 'magic-crm-theme-v2'

export function getTheme(): ThemeId {
  try {
    const t = localStorage.getItem(STORAGE_KEY)
    if (t === 'fism' || t === 'ember') return t
  } catch {
    // ignore (private mode / no storage)
  }
  return 'fism' // default scheme (royal navy & gold) when nothing is saved yet
}

export function applyTheme(id: ThemeId) {
  document.documentElement.dataset.theme = id
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    // ignore
  }
}
