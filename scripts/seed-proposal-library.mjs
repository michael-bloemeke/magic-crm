// Fills `proposal_library` (the saved styles, packages and review bank the proposal editor builds
// from). Run once, on 2026-11-26, when the editor was built. Re-running it would throw away
// whatever Michael has since edited in the Proposal template, so it refuses unless --force.
//
//   ~/.local/node22/bin/node scripts/seed-proposal-library.mjs [--force] [--dry]
//
// WHERE THE DEFAULTS CAME FROM. Nothing here is newly written copy:
//   - Styles: the description each style carried most often on the proposals actually sent, as of
//     2026-11-26 (the Sumesh Kaza mingling and formal-show text, the Caitlyn Keane private set, the
//     Garry Corts after party). The photo is the one each style used most.
//   - Packages: the bullets from the most recent proposals that used each package. Only the
//     client-specific bits were taken out (a named couple, "three hours", travel to Atlanta).
//   - Reviews: every review used on a proposal, in the trimmed form it was sent, plus every written
//     five-star review in Library/reference/google-reviews.json and other-platform-reviews.json.
//     Occult-coded reviews are left out under the standing rule in templates/review-bank.md.
//   - Presets: the four reviews used most often on proposals of that kind.

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { sb } from '../crm-store.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BUSINESS = path.resolve(here, '..', '..')
const force = process.argv.includes('--force')
const dry = process.argv.includes('--dry')

const STYLES = [
  {
    key: 'mingling',
    name: 'Mingling magic',
    photo: '/assets/photos/cocktail-hour-guest-reaction.webp',
    description:
      "Michael works the party a few people at a time. He walks up to a group, introduces himself, and does close-up magic right there in front of them, with people helping out in every trick. Then he moves on to the next group, and the next room, and circles back as the night goes on. When a bigger crowd gathers around to see what's going on, he stays put and plays to the whole group. It runs inside the party rather than taking a slot in it, so there is nothing to schedule around and nothing for anyone to set up.\n\nIt's very interactive and very conversational, and it's a lot of fun. A lot of the material involves several people at once, so guests end up in it together, and everyone walks away with something to talk about besides just sports and the weather.\n\nHe feels out the room as he goes, and special attention for any guests you would like is there on request. It is a mixture of magic, mentalism, and comedy, with a variety of material, so there is something for everybody.",
  },
  {
    key: 'private-set',
    name: 'A private performance for the wedding party',
    photo: '/assets/photos/wedding-couple-laughing.webp',
    description:
      "A fifteen minute close-up show for the wedding party, and nobody else. It happens at the end of the cocktail hour, once everyone has gathered to line up for the entrances, right before the reception starts.\n\nThe two of you will be at the cocktail hour, but you'll be pulled in every direction the whole time, which means the people at the center of the wedding are the ones most likely to miss the magic. So the whole wedding party gets a show of their own. Fifteen minutes, inches away, no audience but them, and it's the perfect way to get everyone hyped up before they walk into the reception.\n\nIt ends with two magic souvenirs for the two of you. One is an impossible object, framed and yours to keep. The other is a surprise wedding gift.",
  },
  {
    key: 'formal-show',
    name: 'The formal show',
    photo: '/assets/photos/mentalism-three-volunteers.webp',
    description:
      "Everybody gathers, someone introduces Michael, and he performs a show for the whole room. It is a mixture of magic, mind reading, and comedy.\n\nIt's extremely interactive the whole way through. People come up and help out, and others take part right from where they are, so the whole room is in on it. Michael plays off the audience and the show is catered to the guests who are there.\n\nAll of it is clean, and he brings everything he needs.",
  },
  {
    key: 'after-party',
    name: 'The after party',
    photo: '/assets/photos/european-style-close-up.webp',
    description:
      "After the show, Michael stays on for about half an hour and teaches everybody a few tricks they can do themselves. Some card work, and a few things with everyday objects.\n\nNothing that takes months of practice, but nothing throwaway either, so people walk away actually able to do them. Everyone gets a written packet of everything covered, so nobody has to remember it on the night.\n\nIt works best on a smaller group, and it turns the end of the evening into something people are doing rather than something that is winding down.",
  },
]

const PACKAGES = [
  {
    key: 'mingling',
    name: 'Mingling magic',
    tagline: 'Close-up magic, group to group',
    price: '$2,000',
    duration: '',
    recommended: false,
    includes: [
      'Up to two hours of mingling close-up magic, group to group',
      'Special attention for any guests you would like, on request',
      'A variety of material, so there is something for everybody',
      'All of it clean',
      'No stage, sound system or AV needed, and nothing for anyone to set up',
    ],
  },
  {
    key: 'show',
    name: 'The show',
    tagline: 'A show for everybody',
    price: '$2,000',
    duration: '',
    recommended: false,
    includes: [
      'A show of about 50 minutes for everybody',
      'Extremely interactive, with guests helping out the whole way through',
      'A variety of material, so there is something for everybody',
      'All of it clean',
    ],
  },
  {
    key: 'both',
    name: 'Mingling magic and the show',
    tagline: 'Mingling magic, then the show for everybody',
    price: '$2,500',
    duration: '',
    recommended: true,
    includes: [
      'Up to two hours of mingling close-up magic, group to group',
      'A show of about 50 minutes for everybody',
      'Extremely interactive, with guests helping out the whole way through',
      'Special attention for any guests you would like, on request',
      'A variety of material, so there is something for everybody',
      'All of it clean',
    ],
  },
  {
    key: 'wedding',
    name: 'The wedding playbook',
    tagline: 'Close-up magic through the cocktail hour, plus a private set for the wedding party.',
    price: '$1,250',
    duration: '',
    recommended: true,
    includes: [
      'Mingling close-up magic for the whole cocktail hour',
      'A private fifteen minute close-up show for the wedding party, away from the guests',
      'An impossible magic souvenir, framed for the couple to keep',
      'A second special gift for the bride and groom',
      'Special attention for any guests you would like, on request',
      'Arrives before your guests do and starts without needing an introduction',
      'No stage, no sound, no setup, and nothing for you or your coordinator to run',
      'All of the material is clean and family friendly, perfectly suitable for the adults as well as any kids present',
    ],
  },
]

// Which reviews each one-click button adds, by name as it appears in the bank. The four used most
// often on proposals of that kind. General is the exception: there is no "general" proposal to count,
// so it is the glowing, event-neutral ones.
const PRESETS = {
  wedding: ['Sarah and Jake A.', 'Scott T.', 'Paige P.', 'Jack S.'],
  corporate: ['Brooke Taylor', 'Luis H.', 'Paige Pluska', 'Beth Radford'],
  general: ['Sumali S.', 'Linda Cramer', 'Khushbu Parekh', 'Dasha B.'],
  house: ['Kevin Ji', 'Sydney Benfey', 'Laine Sherman', 'Olivia Boles'],
}

// templates/review-bank.md rule 4: no occult-coded quotes, even joking ones.
const OCCULT = /wizard|shadow realm|voodoo|witch|sorcer|devil|demon|satan|black magic|dark arts|\bspell|possess|hogwarts|necromanc|hex\b/i

const TAGS = {
  wedding: /wedding|bride|groom|reception|bridal|our big day|married/i,
  corporate: /company|corporate|team|office|co-?workers|employee|staff|work event|luncheon at work|business|conference|chamber|client|banquet|gala|fundraiser|members/i,
  holiday: /holiday|christmas|xmas|new year/i,
  house: /birthday|house party|our home|our house|backyard|anniversary|family party|dinner party|friends and family/i,
  bachelorette: /bachelorette|bachelor party/i,
  mingling: /close[- ]up|mingl|table to table|walked around|walking around|stroll|cocktail hour|in our hands|up close/i,
  show: /\bshow\b|stage|audience|volunteer|performance/i,
}

const tagsFor = (text, usedTypes = {}) => {
  const tags = new Set()
  for (const [tag, re] of Object.entries(TAGS)) if (re.test(text)) tags.add(tag)
  if (usedTypes.wedding) tags.add('wedding')
  if (usedTypes.corporate || usedTypes['holiday-party']) tags.add('corporate')
  if (usedTypes['holiday-party']) tags.add('holiday')
  if (usedTypes.bachelorette) tags.add('bachelorette')
  if (usedTypes.private) tags.add('house')
  return [...tags]
}

const idFor = (name, text) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + createHash('sha1').update(text).digest('hex').slice(0, 6)

// A loose fingerprint, so the raw Google copy of a review that was already used (in trimmed form)
// on a proposal is not listed twice.
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
const firstWords = (s, n = 7) => norm(String(s).replace(/^\s*\.{3}\s*/, '')).split(' ').slice(0, n).join(' ')

async function main() {
  const { data: existing, error: exErr } = await sb().from('proposal_library').select('*').eq('id', 1).maybeSingle()
  if (exErr) throw new Error(exErr.message)
  if (existing && Array.isArray(existing.styles) && existing.styles.length && !force) {
    throw new Error('proposal_library already has styles. Re-run with --force to overwrite (this discards edits made in the Proposal template).')
  }

  // 1. Every review already sent on a proposal, in the form it was sent.
  const { data: props, error } = await sb().from('proposals').select('event_type,reviews,updated_at').order('updated_at')
  if (error) throw new Error(error.message)
  const used = new Map()
  for (const p of props || []) {
    for (const r of p.reviews || []) {
      if (!r?.name || !r?.text) continue
      const cur = used.get(r.name) || { name: r.name, used: 0, types: {} }
      cur.used++
      cur.types[p.event_type] = (cur.types[p.event_type] || 0) + 1
      cur.text = r.text // the newest wins
      cur.company = r.company || ''
      cur.highlight = Array.isArray(r.highlight) ? r.highlight : []
      used.set(r.name, cur)
    }
  }

  const bank = []
  const seen = new Set()
  for (const r of used.values()) {
    if (OCCULT.test(r.text)) continue
    // ⚠️ Carmen Victoria Milam's proposal (2026-10-13) printed Morgan Robinson's review ("Michael
    // absolutely blew us away!") under Samantha Hoag's name. Checked against google-reviews.json on
    // 2026-11-26. The bank carries both real reviews under their real names instead.
    if (r.name === 'Samantha Hoag' && /^Michael absolutely blew us away/.test(r.text)) continue
    bank.push({
      id: idFor(r.name, r.text),
      name: r.name,
      text: r.text,
      company: r.company,
      highlight: r.highlight,
      tags: tagsFor(r.text, r.types),
      source: 'proposals',
      used: r.used,
    })
    seen.add(firstWords(r.text))
  }

  // 2. Every other written five-star review on file.
  const google = JSON.parse(fs.readFileSync(path.join(BUSINESS, 'Library/reference/google-reviews.json'), 'utf8'))
  const other = JSON.parse(fs.readFileSync(path.join(BUSINESS, 'Library/reference/other-platform-reviews.json'), 'utf8')).reviews || []
  const raw = [
    ...google.map((g) => ({ name: g.name, text: g.text, rating: g.rating, source: 'google' })),
    ...other.map((o) => ({ name: o.name, text: o.text, rating: o.rating, source: o.source || 'other', event: o.event || '' })),
  ]
  for (const r of raw) {
    const text = String(r.text || '').trim()
    if (!text || Number(r.rating) !== 5) continue
    if (OCCULT.test(text) || /gustavo bora/i.test(r.name)) continue
    const fp = firstWords(text)
    // Also skip it when a trimmed proposal copy starts partway into it.
    if (seen.has(fp) || [...used.values()].some((u) => norm(text).includes(firstWords(u.text, 6)))) continue
    seen.add(fp)
    bank.push({
      id: idFor(r.name, text),
      name: r.name,
      text,
      company: '',
      highlight: [],
      tags: tagsFor(text + ' ' + (r.event || '')),
      source: r.source,
      used: 0,
    })
  }

  // Most used first, then the longer (usually richer) reviews.
  bank.sort((a, b) => b.used - a.used || b.text.length - a.text.length)

  const byName = new Map(bank.map((r) => [r.name, r]))
  const presets = {}
  for (const [k, names] of Object.entries(PRESETS)) {
    presets[k] = names.map((n) => {
      const r = byName.get(n)
      if (!r) throw new Error(`Preset ${k}: no review named "${n}" in the bank`)
      return r.id
    })
  }
  // The "Best" filter: everything in a preset, plus anything used on five or more proposals.
  const best = new Set([...Object.values(presets).flat(), ...bank.filter((r) => r.used >= 5).map((r) => r.id)])
  for (const r of bank) if (best.has(r.id)) r.tags = [...new Set([...r.tags, 'best'])]

  const row = { id: 1, styles: STYLES, packages: PACKAGES, reviews: bank, review_presets: presets, updated_at: new Date().toISOString() }
  console.log(`styles ${STYLES.length}, packages ${PACKAGES.length}, reviews ${bank.length} (${bank.filter((r) => r.source === 'proposals').length} from proposals)`)
  for (const [k, ids] of Object.entries(presets)) console.log(`  ${k}: ${ids.map((id) => byName.get(bank.find((r) => r.id === id).name).name).join(', ')}`)
  if (dry) return
  const { error: upErr } = await sb().from('proposal_library').upsert(row)
  if (upErr) throw new Error(upErr.message)
  console.log('saved')
}

main().catch((e) => {
  console.error(e.message || e)
  process.exit(1)
})
