// Vite dev-server plugin: serves the CRM data layer over HTTP so the React app
// can read the live project records and persist stage changes.
//
//   GET  /api/projects        -> { projects: [...] } (live from the JSON files)
//   POST /api/stage           -> body { id, stageId }; persists to crm-pipeline.json
//
// Dev-only. When this becomes an Electron app, the renderer will call the same
// crm-data-core functions over IPC instead.

import { exec } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadAll,
  setStage,
  loadLayout,
  saveLayout,
  loadTasks,
  addTask,
  updateTask,
  deleteTask,
  updateProjectField,
  logCall,
  createProject,
  archiveProject,
  completeProject,
  restoreProject,
  deleteProject,
  loadTemplates,
  saveTemplate,
  deleteTemplate,
  loadStructure,
  saveStructure,
  reassignStage,
} from './crm-data-core.mjs'
import { loadThreads, draftReply, sendEmail, loadInbox, markRead } from './crm-comms.mjs'
import { loadEmails, saveProjectEmail, sendProjectEmail, deleteProjectEmail } from './crm-emails.mjs'
import {
  loadPortals,
  savePortal,
  unpublishPortal,
  buildBundle,
  writeBundleFile,
  deployPortal,
  SHAREABLE_FIELDS,
  PORTAL_BASE_URL,
} from './crm-portal.mjs'
import { getAuthUrl, exchangeCode, isConnected, credentialsPresent, unreadByProject } from './crm-gmail.mjs'
import { listFiles, saveFile, readFile, deleteFile } from './crm-files.mjs'
import { loadContacts, addContact, updateContact, deleteContact } from './crm-contacts.mjs'
import {
  loadLinks,
  seedLinksIfNeeded,
  linkContact,
  unlinkContact,
  purgeContact,
  deleteProjectLinks,
  setProjectContacts,
} from './crm-links.mjs'
import {
  computeFinance,
  loadConfig,
  saveConfig,
  loadPayments,
  addPayment,
  updatePayment,
  deletePayment,
  deletePaymentsForProject,
  deleteTripsForProject,
  loadExpenses,
  addExpense,
  updateExpense,
  deleteExpense,
  loadMileage,
  addTrip,
  deleteTrip,
  setMileageRate,
} from './crm-finance.mjs'

// Read a JSON request body, then run a handler (sync or async) that returns a
// response object.
function withbody(req, res, handler) {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', async () => {
    try {
      const result = await handler(JSON.parse(body || '{}'))
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(result))
    } catch (e) {
      res.statusCode = 400
      res.end(JSON.stringify({ error: String(e?.message || e) }))
    }
  })
}

// Auto-backup: while the app is running, push the code + data repos to GitHub on a
// timer. This runs in the app's process, which already has the file access the CRM
// needs, so it sidesteps the macOS rule that blocks background schedulers (launchd/
// cron) from touching the Desktop folder. Fire-and-forget; never blocks the server.
// (Moves to the Electron main process when the app is packaged.)
function runBackup() {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts', 'backup.sh')
  exec(`/bin/bash "${script}"`, { timeout: 120000 }, (err, stdout, stderr) => {
    const out = `${stdout || ''}${stderr || ''}`.trim()
    if (out) console.log('[crm-backup]', out.replace(/\n/g, ' | '))
  })
}

export function crmDataPlugin() {
  return {
    name: 'crm-data',
    configureServer(server) {
      // Back up shortly after the app starts, then every 4 hours it stays running.
      const t1 = setTimeout(runBackup, 90_000)
      const t2 = setInterval(runBackup, 4 * 60 * 60 * 1000)
      server.httpServer?.on('close', () => {
        clearTimeout(t1)
        clearInterval(t2)
      })

      server.middlewares.use('/api/projects', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const data = loadAll()
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(data))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      server.middlewares.use('/api/stage', (req, res, next) => {
        if (req.method !== 'POST' && req.method !== 'PUT') return next()
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          try {
            const { id, stageId } = JSON.parse(body || '{}')
            const result = setStage(id, stageId)
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(result))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
        })
      })

      // Editable pipeline structure (categories + stages).
      server.middlewares.use('/api/pipeline/structure', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ structure: loadStructure() }))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          withbody(req, res, (b) => ({ structure: saveStructure(b.structure) }))
          return
        }
        next()
      })
      // Move every project on a set of stages onto another stage (used by the
      // "Dump all projects into Inquiry" delete action).
      server.middlewares.use('/api/pipeline/reassign', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => reassignStage(b.fromStageIds, b.toStageId))
      })

      server.middlewares.use('/api/flow-layout', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ flowLayout: loadLayout() }))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
          return
        }
        if (req.method === 'POST' || req.method === 'PUT') {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            try {
              const layout = JSON.parse(body || '{}')
              saveLayout(layout)
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
            } catch (e) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: String(e?.message || e) }))
            }
          })
          return
        }
        next()
      })

      server.middlewares.use('/api/tasks/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ task: addTask(b) }))
      })
      server.middlewares.use('/api/tasks/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ task: updateTask(b) }))
      })
      server.middlewares.use('/api/tasks/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteTask(b.id))
      })
      server.middlewares.use('/api/tasks', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ tasks: loadTasks() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      server.middlewares.use('/api/comms/draft', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => draftReply(b))
      })
      server.middlewares.use('/api/comms/send', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => sendEmail(b))
      })
      server.middlewares.use('/api/comms/read', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => markRead(b))
      })
      server.middlewares.use('/api/comms', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => loadThreads(b.projectId))
      })

      server.middlewares.use('/api/project/field', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => updateProjectField(b))
      })

      server.middlewares.use('/api/project/log-call', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => logCall(b))
      })

      server.middlewares.use('/api/project/create', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => {
          const project = createProject(b)
          // Initialize the project's contact links EXPLICITLY so the auto-seeder
          // never fabricates a contact from the project name. Only attach a
          // contact when the form actually provided contact info; if the contact
          // fields were left blank, the project is created with NO contact.
          const split = (v) =>
            String(v ?? '')
              .split(/[,;]/)
              .map((s) => s.trim())
              .filter(Boolean)
          const norm = (s) => String(s || '').trim().toLowerCase()
          const name = split(b.contactNames)[0] || ''
          const emails = split(b.contactEmails).filter((e) => e.includes('@'))
          const phones = split(b.contactPhones)
          if (name || emails.length) {
            // Reuse an existing contact if one matches by email or name; else create.
            const contacts = loadContacts()
            let match = null
            for (const e of emails) {
              match = contacts.find((c) => c.emails.some((x) => norm(x) === norm(e)))
              if (match) break
            }
            if (!match && name) match = contacts.find((c) => norm(c.name) === norm(name))
            const contact =
              match || addContact({ name: name || emails[0], emails, phones, type: 'client', relationship: 'active' })
            setProjectContacts(project.id, [contact.id])
          } else {
            setProjectContacts(project.id, []) // explicit empty entry -> never auto-seeded
          }
          return { project }
        })
      })

      // Archive / complete / restore: move a project between canonical buckets.
      server.middlewares.use('/api/project/archive', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => archiveProject(b))
      })
      server.middlewares.use('/api/project/complete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => completeProject(b))
      })
      server.middlewares.use('/api/project/restore', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => restoreProject(b))
      })
      // Permanent delete: removes the canonical record AND the CRM's overlay data
      // (stage, tasks, payments, mileage) for that project. No undo.
      server.middlewares.use('/api/project/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => {
          const result = deleteProject(b)
          deletePaymentsForProject(b.id)
          deleteTripsForProject(b.id)
          deleteProjectLinks(b.id)
          return result
        })
      })

      // --- Contacts (specific paths before the generic GET) ---
      server.middlewares.use('/api/contacts/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ contact: addContact(b) }))
      })
      server.middlewares.use('/api/contacts/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ contact: updateContact(b) }))
      })
      server.middlewares.use('/api/contacts/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        // Deleting a contact also strips it from every project it was on, so it
        // stays gone (no resurrection) and no project keeps a dangling link.
        withbody(req, res, (b) => {
          const result = deleteContact(b.id)
          purgeContact(b.id)
          return result
        })
      })
      server.middlewares.use('/api/contacts', (req, res, next) => {
        if (req.method !== 'GET') return next()
        // Seed a contact for any project that has never been initialized (ONCE
        // per project), then return all contacts. This only ADDS links for new
        // projects; it never re-creates a contact Michael removed or renamed.
        try {
          seedLinksIfNeeded()
        } catch (e) {
          console.error('[crm-links] seed failed:', e?.message || e)
        }
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ contacts: loadContacts() }))
      })

      // --- Project <-> contact links ---
      server.middlewares.use('/api/links/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ links: linkContact(b.projectId, b.contactId) }))
      })
      server.middlewares.use('/api/links/remove', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ links: unlinkContact(b.projectId, b.contactId) }))
      })
      server.middlewares.use('/api/links', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ links: loadLinks() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Inbox (all pipeline-relevant mail) ---
      server.middlewares.use('/api/inbox', (req, res, next) => {
        if (req.method !== 'GET') return next()
        loadInbox()
          .then((data) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(data))
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          })
      })

      // --- Email templates (specific paths before the generic GET) ---
      server.middlewares.use('/api/templates/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ template: saveTemplate(b) }))
      })
      server.middlewares.use('/api/templates/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteTemplate(b.id))
      })
      server.middlewares.use('/api/templates', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ templates: loadTemplates() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Composed per-project emails (thank-you, etc.) ---
      server.middlewares.use('/api/emails/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ email: saveProjectEmail(b) }))
      })
      server.middlewares.use('/api/emails/send', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => sendProjectEmail(b))
      })
      server.middlewares.use('/api/emails/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteProjectEmail(b.id))
      })
      server.middlewares.use('/api/emails', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ emails: loadEmails() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Client portal (settings + curated bundle preview) ---
      server.middlewares.use('/api/portal/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ portal: savePortal(b) }))
      })
      // Publish = save the latest config, write the curated bundle, push it live.
      server.middlewares.use('/api/portal/publish', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const portal = savePortal({ projectId: b.projectId, patch: { ...(b.patch || {}), published: true } })
          writeBundleFile(b.projectId)
          const deploy = await deployPortal()
          return { portal, bundle: buildBundle(b.projectId), baseUrl: PORTAL_BASE_URL, deploy }
        })
      })
      // Unpublish = mark unpublished, remove the bundle file, push so the link 404s.
      server.middlewares.use('/api/portal/unpublish', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const portal = unpublishPortal(b.projectId)
          writeBundleFile(b.projectId)
          const deploy = await deployPortal()
          return { portal, baseUrl: PORTAL_BASE_URL, deploy }
        })
      })
      server.middlewares.use('/api/portal/bundle', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
          const projectId = url.searchParams.get('projectId') || ''
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ bundle: buildBundle(projectId) }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
      server.middlewares.use('/api/portal', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ portals: loadPortals(), shareableFields: SHAREABLE_FIELDS, baseUrl: PORTAL_BASE_URL }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Business files (upload raw bytes; specific paths before generic GET) ---
      const MAX_UPLOAD = 200 * 1024 * 1024 // 200 MB cap so a stray huge drop can't OOM the dev server
      server.middlewares.use('/api/files/upload', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        const name = url.searchParams.get('name') || 'upload.bin'
        const chunks = []
        let size = 0
        let aborted = false
        req.on('data', (c) => {
          size += c.length
          if (size > MAX_UPLOAD) {
            aborted = true
            res.statusCode = 413
            res.end(JSON.stringify({ error: 'File too large (200 MB max)' }))
            req.destroy()
            return
          }
          chunks.push(c)
        })
        req.on('error', () => {
          if (!aborted) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Upload failed' }))
          }
        })
        req.on('end', () => {
          if (aborted) return
          try {
            const file = saveFile(name, Buffer.concat(chunks))
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ file }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
        })
      })
      // Types we must NOT render inline (an SVG/HTML doc would execute scripts on
      // our own origin). Everything else previews inline; these download instead.
      const UNSAFE_INLINE = new Set(['image/svg+xml', 'text/html'])
      server.middlewares.use('/api/files/raw', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        const name = url.searchParams.get('name') || ''
        try {
          const f = readFile(name)
          if (!f) {
            res.statusCode = 404
            res.end('Not found')
            return
          }
          // Strip characters that would break the quoted header value.
          const safeHeaderName = f.name.replace(/["\r\n]/g, '_')
          const disposition = UNSAFE_INLINE.has(f.contentType) ? 'attachment' : 'inline'
          res.setHeader('Content-Type', f.contentType)
          res.setHeader('X-Content-Type-Options', 'nosniff')
          res.setHeader(
            'Content-Disposition',
            `${disposition}; filename="${safeHeaderName}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          )
          res.end(f.buffer)
        } catch (e) {
          res.statusCode = 400
          res.end(String(e?.message || e))
        }
      })
      server.middlewares.use('/api/files/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteFile(b.name))
      })
      server.middlewares.use('/api/files', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ files: listFiles() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Editable settings ---
      server.middlewares.use('/api/config', (req, res, next) => {
        if (req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(loadConfig()))
          return
        }
        if (req.method === 'POST') {
          withbody(req, res, (b) => saveConfig(b))
          return
        }
        next()
      })

      // --- Finance (specific paths before the generic GET) ---
      server.middlewares.use('/api/finance/payments/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ payment: addPayment(b) }))
      })
      server.middlewares.use('/api/finance/payments/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ payment: updatePayment(b) }))
      })
      server.middlewares.use('/api/finance/payments/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deletePayment(b.id))
      })
      server.middlewares.use('/api/finance/payments', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ payments: loadPayments() }))
      })
      server.middlewares.use('/api/finance/expenses/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ expense: addExpense(b) }))
      })
      server.middlewares.use('/api/finance/expenses/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ expense: updateExpense(b) }))
      })
      server.middlewares.use('/api/finance/expenses/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteExpense(b.id))
      })
      server.middlewares.use('/api/finance/expenses', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ expenses: loadExpenses() }))
      })
      server.middlewares.use('/api/finance/mileage/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ trip: addTrip(b) }))
      })
      server.middlewares.use('/api/finance/mileage/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteTrip(b.id))
      })
      server.middlewares.use('/api/finance/mileage/rate', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => setMileageRate(b.rate))
      })
      server.middlewares.use('/api/finance/mileage', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(loadMileage()))
      })
      server.middlewares.use('/api/finance', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(computeFinance()))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Gmail connect flow ---
      server.middlewares.use('/api/gmail/status', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ connected: isConnected(), hasCredentials: credentialsPresent() }))
      })
      server.middlewares.use('/api/gmail/unread', (req, res, next) => {
        if (req.method !== 'GET') return next()
        if (!isConnected()) {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ unread: {} }))
          return
        }
        unreadByProject()
          .then((counts) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ unread: counts }))
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          })
      })
      server.middlewares.use('/api/gmail/auth', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.statusCode = 302
          res.setHeader('Location', getAuthUrl())
          res.end()
        } catch (e) {
          res.statusCode = 500
          res.end(`Could not start Gmail auth: ${String(e?.message || e)}`)
        }
      })
      server.middlewares.use('/api/gmail/callback', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        const code = url.searchParams.get('code')
        const err = url.searchParams.get('error')
        if (err || !code) {
          res.statusCode = 302
          res.setHeader('Location', '/?gmail=error')
          res.end()
          return
        }
        exchangeCode(code)
          .then(() => {
            res.statusCode = 302
            res.setHeader('Location', '/?gmail=connected')
            res.end()
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(`Gmail connection failed: ${String(e?.message || e)}`)
          })
      })
    },
  }
}
