#!/usr/bin/env node
//
// Proposal pages from the command line, until the CRM grows a panel for them.
//
//   node scripts/proposal.mjs new <project-id>          start a draft, seeded from the event type
//   node scripts/proposal.mjs show <project-id>         print the row and the link
//   node scripts/proposal.mjs edit <project-id> <file>  apply a JSON patch written by hand
//   node scripts/proposal.mjs publish <project-id>      make the link live
//   node scripts/proposal.mjs retire <project-id>       take the page down
//   node scripts/proposal.mjs stats <project-id>        was it opened, and how often
//   node scripts/proposal.mjs list                      every proposal, newest first
//
// The edit file is plain JSON with any of these keys. Nothing else is read:
//
//   {
//     "hero_line": "One line of warmth under the heading. Not a sales pitch.",
//     "recommendation": "What the night looks like with him in it.\n\nBlank lines split paragraphs.",
//     "packages": [
//       { "name": "", "tagline": "", "price": "$1,800", "duration": "1 hour",
//         "includes": ["", ""], "recommended": true }
//     ],
//     "reviews": [{ "name": "Deegan M.", "text": "..." }],
//     "photos": { "hero": "/assets/photos/x.webp", "format": "", "portrait": "", "gallery": [] },
//     "video_id": "uTaXL4lPcHQ",
//     "expires_at": "2027-03-19T12:00:00Z"
//   }
//
// COPY RULES, because everything above lands in front of a client:
//   - No em-dashes or en-dashes anywhere. Regular hyphens are fine.
//   - Never "World Champion". "Most Original Act at the FISM World Championship of Magic" is fine.
//   - Prices are flat numbers. Travel is never itemized and distance is never mentioned: surfacing
//     it invites "let's find someone local and cheaper".
//   - Reviews are real, verbatim, and attributed. Never write one.
//   - The date is "penciled in" until payment. Never "on my calendar" or "locked in".

import { readFileSync } from 'node:fs'
import {
  ensureProposal, loadProposal, saveProposal, publishProposal,
  retireProposal, proposalStats, proposalGaps, proposalUrl,
} from '../crm-proposals.mjs'
import { sb } from '../crm-store.mjs'
import { loadAll } from '../crm-data-core.mjs'

const [cmd, projectId, arg] = process.argv.slice(2)

const need = (what) => {
  if (!projectId) {
    console.error(`Needs a project id. Example: node scripts/proposal.mjs ${what} shone-williams`)
    process.exit(1)
  }
}

const print = (o) => console.log(JSON.stringify(o, null, 2))

try {
  switch (cmd) {
    case 'new': {
      need('new')
      const row = await ensureProposal(projectId)
      console.log(`Draft ready for ${projectId}.`)
      console.log(`Link (not live yet): ${proposalUrl(row.token)}`)
      const gaps = proposalGaps(row, loadAll().projects.find((p) => p.id === projectId))
      if (gaps.length) console.log(`Still needs: ${gaps.join(', ')}.`)
      break
    }

    case 'show': {
      need('show')
      const row = await loadProposal(projectId)
      if (!row) {
        console.log(`No proposal for ${projectId} yet. Run: node scripts/proposal.mjs new ${projectId}`)
        break
      }
      print({ ...row, url: proposalUrl(row.token) })
      break
    }

    case 'edit': {
      need('edit')
      if (!arg) {
        console.error('Needs a JSON file. Example: node scripts/proposal.mjs edit shone-williams /tmp/p.json')
        process.exit(1)
      }
      await ensureProposal(projectId)
      const patch = JSON.parse(readFileSync(arg, 'utf8'))
      const row = await saveProposal(projectId, patch)
      console.log(`Saved. Status is still "${row.status}".`)
      const gaps = proposalGaps(row, loadAll().projects.find((p) => p.id === projectId))
      console.log(gaps.length ? `Still needs: ${gaps.join(', ')}.` : 'Ready to publish.')
      break
    }

    case 'publish': {
      need('publish')
      const row = await publishProposal(projectId)
      console.log('Live. Send this link:')
      console.log(row.url)
      break
    }

    case 'retire': {
      need('retire')
      await retireProposal(projectId)
      console.log(`Retired. The link now shows the friendly expired message rather than a 404.`)
      break
    }

    case 'stats': {
      need('stats')
      const s = await proposalStats(projectId)
      if (!s) {
        console.log(`No proposal for ${projectId}.`)
        break
      }
      print(s)
      break
    }

    case 'list': {
      const { data, error } = await sb()
        .from('proposals')
        .select('project_id, status, view_count, first_viewed_at, last_viewed_at, expires_at')
        .order('updated_at', { ascending: false })
      if (error) throw error
      if (!data.length) {
        console.log('No proposals yet.')
        break
      }
      for (const r of data) {
        const seen = r.view_count ? `${r.view_count} view${r.view_count === 1 ? '' : 's'}` : 'not opened'
        console.log(`${r.status.padEnd(8)} ${r.project_id.padEnd(30)} ${seen}`)
      }
      break
    }

    default:
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 20).join('\n').replace(/^\/\/ ?/gm, ''))
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}
