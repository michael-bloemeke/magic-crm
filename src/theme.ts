// Color schemes for the app. The actual color values live as CSS variables in
// index.css: the @theme block defines EMBER (the default), and a
// :root[data-theme="fism"] block overrides them for FISM. Switching a theme just
// sets data-theme on <html>; the swatches below are only for the picker preview.

export type ThemeId = 'ember' | 'fism' | 'light' | 'dark' | 'grey'

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
  {
    id: 'light',
    label: 'Light',
    tagline: 'Clean & bright',
    swatch: { bg: '#eceef1', surface: '#ffffff', accent: '#b07d2a' },
  },
  {
    id: 'dark',
    label: 'Dark',
    tagline: 'Neutral near-black',
    swatch: { bg: '#0f1012', surface: '#1b1d21', accent: '#7cabe0' },
  },
  {
    id: 'grey',
    label: 'Grey',
    tagline: 'Muted mid-tone',
    swatch: { bg: '#3b3d42', surface: '#4b4e55', accent: '#c8a670' },
  },
]

// Every selectable theme id, for validating what's in storage.
const VALID_THEMES: ThemeId[] = ['ember', 'fism', 'light', 'dark', 'grey']

// Bumped to -v2 so the new FISM default takes effect even where an older 'ember' value was
// already saved (e.g. the first Electron launch before FISM became the default).
const STORAGE_KEY = 'magic-crm-theme-v2'

export function getTheme(): ThemeId {
  try {
    const t = localStorage.getItem(STORAGE_KEY)
    if (t && (VALID_THEMES as string[]).includes(t)) return t as ThemeId
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
