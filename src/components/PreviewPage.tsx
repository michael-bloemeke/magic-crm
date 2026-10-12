import { createElement, useEffect, useRef, useState } from 'react'

// THE PROPOSAL, INSIDE THE CRM.
//
// Michael's ask, 2026-09-09: "every time I click on a Proposal it opens up a new window viewer, and
// I have to, like, expand that window, and it's just a pain." So a preview is now a SCREEN in the
// app, the way Pipeline is a screen, with one back button at the top. No second window to size, no
// tab to find again.
//
// WHY AN IFRAME OF THE REAL URL, rather than re-rendering the proposal in React.
//
// He asked for it to look "exactly as it would when the client opens it up in their browser." The
// only way to guarantee that, permanently, is to show the actual page: same HTML, same CSS, same
// edge function, same data. A React copy would be a second implementation of the proposal that
// drifts the first time either side is edited, and the whole point of this screen is to be able to
// trust what he is looking at. Links inside it work because they are the page's own links.
//
// ⚠️ NOTHING HERE MAY EVER COUNT AS A VIEW. The `src` is always the server-built `openUrl`, which
// carries `preview=1` (plus the admin key when the page is no longer public). Michael was explicit:
// "I don't want me viewing it in my CRM to increase the count of the number of times it's been
// viewed... That is important data for my own just reference, and I don't want it messed with."
// Never point this component at a raw proposal URL, and never build the URL in the client.

export type PreviewTarget = {
  // The framed URL. Built on the server, already flagged. See previewUrlFor in crm-proposals.mjs.
  src: string
  // The clean URL, the one Michael actually sends. Copy hands over this, never `src`.
  publicUrl: string
  title: string
  subtitle?: string
  // Where Back goes, in his words: "the proposals page or the project page, wherever I was."
  backLabel: string
  // 'site' = a third-party page (a GigSalad, Bash or Bark lead), shown in an Electron <webview>
  // because those sites refuse to load in an iframe. Added 2026-10-11. Default is the proposal /
  // booking-form iframe, which is Michael's own domain.
  kind?: 'site'
}

// The <webview> for third-party sites. A real browser view inside the window: the sites cannot
// block it the way they block an iframe, and it uses the app's default session, so his GigSalad,
// Bash and Bark logins carry over. Only exists in the desktop app (webviewTag in electron/main.cjs);
// in a plain browser tab the lead button opens a new tab instead and never reaches this.
function SiteView({ src, onLoaded }: { src: string; onLoaded: () => void }) {
  const ref = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.addEventListener('did-stop-loading', onLoaded)
    return () => el.removeEventListener('did-stop-loading', onLoaded)
  }, [onLoaded])
  return createElement('webview', { ref, src, allowpopups: 'true', style: { width: '100%', height: '100%' } })
}

export function PreviewPage({ target, onBack }: { target: PreviewTarget; onBack: () => void }) {
  // Which src has finished loading, rather than a boolean that would have to be reset whenever
  // the target changes. Derived, so switching proposals shows its own spinner with no effect.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const loaded = loadedSrc === target.src

  // Escape backs out, because this is a full-screen takeover and that is what Escape means
  // everywhere else in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack])

  const copy = () => {
    navigator.clipboard.writeText(target.publicUrl).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The bar. Deliberately the only thing on this screen that is not the client's page, and it
          sits OUTSIDE the iframe, so nothing in it can ever appear in what a client sees. */}
      <div className="flex shrink-0 items-center gap-3 border-b border-line bg-surface px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-line-strong bg-surface-2 px-3.5 py-2 text-[13px] font-semibold text-parchment transition-colors hover:border-brass hover:text-brass-bright"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          {target.backLabel}
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-parchment">{target.title}</p>
          {target.subtitle && <p className="truncate text-[11.5px] text-muted">{target.subtitle}</p>}
        </div>

        {/* The reassurance, said out loud on the screen where it matters. */}
        {target.kind !== 'site' && (
          <span className="hidden shrink-0 text-[11px] text-faint sm:block">Preview. Not counted as a view.</span>
        )}

        <button
          type="button"
          onClick={copy}
          title="Copies the clean link, without the preview flag. This is the one to send."
          className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-[12px] font-medium text-muted transition-colors hover:border-brass hover:text-brass-bright"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      <div className="relative min-h-0 flex-1 bg-surface-2">
        {!loaded && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[12.5px] text-muted">{target.kind === 'site' ? 'Loading the lead…' : 'Loading the page the client sees…'}</p>
          </div>
        )}
        {/* No `sandbox`: Michael asked for "all the links and everything to work the same as they
            normally would", and sandboxing would break the page's own navigation and its YouTube
            embed. This frames his own domain, so there is nothing to isolate it from. */}
        {target.kind === 'site' ? (
          <div key={target.src} className="h-full w-full" style={{ opacity: loaded ? 1 : 0, transition: 'opacity 160ms ease' }}>
            <SiteView src={target.src} onLoaded={() => setLoadedSrc(target.src)} />
          </div>
        ) : (
        <iframe
          key={target.src}
          src={target.src}
          title={target.title}
          onLoad={() => setLoadedSrc(target.src)}
          className="h-full w-full border-0"
          style={{ opacity: loaded ? 1 : 0, transition: 'opacity 160ms ease' }}
        />
        )}
      </div>
    </div>
  )
}
