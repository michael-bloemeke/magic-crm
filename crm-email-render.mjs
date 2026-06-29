// Outgoing-email HTML rendering, shared by every send path (the per-project email builder in
// crm-emails.mjs AND thread replies in crm-comms.mjs) so a composed email, a thread reply, and the
// in-app compose box all render identically. Extracted here to keep a single source of truth and to
// avoid a circular import between crm-emails and crm-comms.

import { loadConfig } from './crm-finance.mjs'

// Strip smart-field placeholder chips down to their plain text, server-side. This is the
// last line of defense so a styled <span class="merge-field">[Label]</span> can NEVER ship to
// a client, no matter which front-end path triggered the send. Filled fields are already plain
// text by send time; only unset placeholders remain, and they go out as the bare bracketed label.
export function stripMergeFields(html) {
  return String(html || '').replace(
    /<span\b[^>]*\bclass="[^"]*\bmerge-field\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    (_, inner) => inner,
  )
}

// Make an outgoing HTML email render like Gmail, and match the compose box / sent receipt exactly
// (which carry the .email-rte class with these same values in src/index.css). Three jobs:
//   1. tightenEmailHtml: normalize spacing. Our draft HTML (Claude-drafted or typed in the rich
//      editor) uses an empty <p><br></p> for a blank line, and email clients render every <p> with
//      a full 1em top+bottom margin, so stacked a blank line balloons to ~50px. We swap each
//      blank-line paragraph for a short half-height spacer, give real paragraphs a controlled
//      smaller bottom margin, and inline Gmail's blue link color so links match the editor.
//   2. EMAIL_BASE_STYLE: a base font wrapper so the recipient's client doesn't fall back to its own
//      font (Gmail otherwise renders an unstyled message in a serif). Arial / 14px / 1.5 / #222.
//   3. renderEmailHtml: wrap the tightened body in that base style.
// Purely presentational: no text is changed. Only touches <p>/<a> tags with no style of their own.
const PARA_STYLE = 'margin:0 0 12px 0'
const BLANK_SPACER = '<div style="margin:0;line-height:12px;font-size:1px">&nbsp;</div>'
const LINK_STYLE = 'color:#1155cc;text-decoration:underline'
export const EMAIL_BASE_STYLE = 'font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222'

export function tightenEmailHtml(html) {
  let s = String(html || '')
  if (!s) return s
  s = s.replace(/>\s+</g, '><') // drop insignificant whitespace the editor/Claude leaves between blocks
  s = s.replace(/<(p|div)\b[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/\1>/gi, BLANK_SPACER) // blank line -> short spacer
  s = s.replace(/<p(?![^>]*\bstyle=)([^>]*)>/gi, `<p$1 style="${PARA_STYLE}">`) // controlled margin on real paragraphs
  s = s.replace(/<a(?![^>]*\bstyle=)([^>]*)>/gi, `<a$1 style="${LINK_STYLE}">`) // Gmail-blue links, matching the editor
  return s
}

// Pull every `data:` image out of HTML into a cid: inline attachment, rewriting the src to cid:.
// Gmail strips data: images from RECEIVED mail, so a signature logo must ride along as an inline
// attachment referenced by Content-ID. Returns the rewritten html plus the images to attach.
export function extractInlineImages(html) {
  const images = []
  let n = 0
  const out = String(html || '').replace(
    /(<img\b[^>]*\bsrc=")data:([^;"]+);base64,([^"]+)(")/gi,
    (_m, pre, contentType, contentBase64, post) => {
      const cid = `sig${n++}@magic-crm`
      const ext = (contentType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
      images.push({ cid, contentType, contentBase64, filename: `signature-${n}.${ext}` })
      return `${pre}cid:${cid}${post}`
    },
  )
  return { html: out, images }
}

// Build the signature block (tightened, same styling as the body), or '' if disabled/empty.
function signatureInner() {
  const cfg = loadConfig()
  if (!cfg || !cfg.signatureEnabled) return ''
  const sig = tightenEmailHtml(String(cfg.signatureHtml || ''))
  return sig ? `<div style="margin-top:16px">${sig}</div>` : ''
}

// Turn a composed body into what actually ships and what we store as the receipt. Both are wrapped
// in the Gmail-like base font (so editor, receipt, and delivered email agree) and carry the
// signature. They differ only in images: the receipt keeps data: URIs (so the in-app sent view
// renders the logo), while the send version uses cid: + inlineImages (so the recipient's Gmail does).
export function composeOutgoing(bodyHtml) {
  const inner = tightenEmailHtml(String(bodyHtml || '')) + signatureInner()
  const wrap = (h) => (h ? `<div style="${EMAIL_BASE_STYLE}">${h}</div>` : h)
  const { html: cidInner, images } = extractInlineImages(inner)
  return { sendHtml: wrap(cidInner), receiptHtml: wrap(inner), inlineImages: images }
}
