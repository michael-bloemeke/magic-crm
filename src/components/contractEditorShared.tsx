import { type ReactNode } from 'react'

// Shared bits for the contract rich-text editor, used by both the Generate dialog and the
// Settings "default contract" editor: the document CSS (serif page look + field-span
// highlighting) and the toolbar primitives. Field spans (.cf) are highlighted so auto-filled
// spots are visible; unfilled ones (.cf-missing) get a warning highlight. These are CSS
// CLASSES (not inline styles), so html-to-pdfmake ignores them and the PDF renders clean.

export function ContractDocStyles() {
  return (
    <style>{`
      .ct-page ::selection { background: #bcd7fb !important; color: #1f1c17 !important; }
      .ct-brand { text-align: center; font-family: Georgia, 'Times New Roman', serif; font-weight: 700;
        font-size: 13.5px; letter-spacing: 0.08em; color: #1f1c17; margin: 0 0 6px; }
      .ct-title { text-align: center; font-family: Georgia, 'Times New Roman', serif; font-weight: 700;
        font-size: 16.5px; letter-spacing: 0.06em; color: #1f1c17; padding-bottom: 12px;
        margin: 0 0 14px; border-bottom: 1px solid #1f1c17; }
      .ct-doc { font-family: Georgia, 'Times New Roman', serif; color: #1f1c17; }
      .ct-doc p { margin: 0 0 6px; font-size: 12px; line-height: 1.65; }
      .ct-doc h1 { font-size: 17px; font-weight: 700; margin: 10px 0 5px; }
      .ct-doc h2 { font-size: 15px; font-weight: 700; margin: 9px 0 4px; }
      .ct-doc h3 { font-size: 13.5px; font-weight: 700; margin: 8px 0 3px; }
      .ct-doc ul, .ct-doc ol { margin: 0 0 6px; padding-left: 22px; }
      .ct-doc li { font-size: 12px; line-height: 1.65; margin-bottom: 2px; }
      .ct-doc:focus { outline: none; }
      .ct-doc .cf { background: rgba(120,160,210,0.20); border-radius: 3px; padding: 0 2px;
        -webkit-box-decoration-break: clone; box-decoration-break: clone; }
      .ct-doc .cf-missing { background: rgba(224,138,107,0.30); color: #7a2e16; }
      .ct-sig { font-family: Georgia, 'Times New Roman', serif; color: #1f1c17; font-size: 12px;
        margin-top: 16px; padding-top: 13px; border-top: 1px solid #1f1c17; }
      .ct-sig div { margin-bottom: 10px; }
    `}</style>
  )
}

// Toolbar button: act on mousedown (preventDefault) so the editor keeps its selection.
export function TB({ onApply, title, children }: { onApply: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault()
        onApply()
      }}
      className="min-w-[28px] rounded-md border border-transparent px-2 py-1 text-[11.5px] text-muted transition-colors hover:border-line hover:bg-surface-3 hover:text-parchment"
    >
      {children}
    </button>
  )
}

export function Divider() {
  return <span className="mx-0.5 h-4 w-px bg-line" aria-hidden />
}

export function Dropdown({
  open,
  onToggle,
  label,
  children,
  accent,
  wide,
}: {
  open: boolean
  onToggle: () => void
  label: ReactNode
  children: ReactNode
  accent?: boolean
  wide?: boolean
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault()
          onToggle()
        }}
        className={
          accent
            ? 'rounded-md border border-brass-dim/60 px-2 py-1 text-[11.5px] font-medium text-brass-bright hover:border-brass'
            : 'rounded-md border border-transparent px-2 py-1 text-[11.5px] text-muted transition-colors hover:border-line hover:bg-surface-3 hover:text-parchment'
        }
      >
        {label}
      </button>
      {open && (
        <div
          className={`absolute left-0 top-[calc(100%+4px)] z-10 max-h-64 overflow-y-auto rounded-lg border border-line-strong bg-surface-2 py-1 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] ${wide ? 'w-60' : 'w-44'}`}
        >
          {children}
        </div>
      )}
    </div>
  )
}

export function MenuItem({ onPick, children }: { onPick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault()
        onPick()
      }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-parchment hover:bg-surface-3"
    >
      {children}
    </button>
  )
}
