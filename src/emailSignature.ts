// The email signature, as a block that lives IN the message body rather than as invisible metadata.
//
// Why in the body: the composer is then honestly WYSIWYG. Michael ticks "Signature" and sees the
// separator and the three lines exactly where they will land, instead of trusting a greyed preview
// labelled "added automatically". It also means a saved draft remembers the choice for free (the
// signature is just part of the draft), the checkbox state can be DERIVED from the body instead of
// tracked alongside it, and every send path carries it without new plumbing.
//
// The block is tagged with data-crm-signature so it can be found again to remove, and so the
// server-side signature (crm-email-render's signatureInner, driven by the Settings toggle) knows to
// stand down and never append a second copy.
//
// The website is deliberately PLAIN TEXT, never an <a>. Michael does not want his site linked in a
// signature, so nothing here creates one.

export const SIGNATURE_ATTR = 'data-crm-signature'

// Michael's signature if Settings has not been filled in. Settings owns the content; this is only
// the fallback so the checkbox is never a no-op on a fresh install.
export const DEFAULT_SIGNATURE_HTML =
  'Michael Bloemeke<div>michaelbloemeke.com</div><div>919-239-9898</div>'

// A short, light rule above the signature — the conventional email separator, kept deliberately
// narrow and pale so it reads as a divider rather than a border across the message. Built as a
// bordered div rather than an <hr> because Outlook renders <hr> inconsistently, and with an &nbsp;
// at 1px so clients that collapse empty elements still draw it.
const RULE =
  '<div style="width:150px;border-top:1px solid #d8d8d8;font-size:1px;line-height:1px;margin:0 0 10px 0">&nbsp;</div>'

/** The signature block: separator rule, then the signature lines. */
export function signatureBlock(sigHtml?: string): string {
  const inner = (sigHtml || '').trim() || DEFAULT_SIGNATURE_HTML
  return (
    `<div ${SIGNATURE_ATTR}="1" style="margin-top:22px">` +
    RULE +
    `<div style="color:#555555;font-size:13px;line-height:1.6">${inner}</div>` +
    `</div>`
  )
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
}

/** True if this body already carries the signature block. Drives the checkbox. */
export function hasSignature(html: string): boolean {
  return (html || '').includes(SIGNATURE_ATTR)
}

/** Remove every signature block from the body (no-op if there is none). */
export function withoutSignature(html: string): string {
  if (!hasSignature(html)) return html || ''
  const doc = parse(html)
  doc.querySelectorAll(`[${SIGNATURE_ATTR}]`).forEach((el) => el.remove())
  return doc.body.innerHTML
}

/** Append the signature to the end of the body, replacing one if it is already there. */
export function withSignature(html: string, sigHtml?: string): string {
  return withoutSignature(html) + signatureBlock(sigHtml)
}
