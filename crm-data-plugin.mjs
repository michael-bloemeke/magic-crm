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
  loadPortal,
  savePortal,
  unpublishPortal,
  buildBundle,
  writeBundleFile,
  deployPortal,
  currentShareableFields,
  PORTAL_BASE_URL,
} from './crm-portal.mjs'
import {
  loadQuestionnaire,
  loadQuestionnaires,
  setQuestionnaire,
  pullResponse,
  isBlobConfigured,
  loadUnseenSubmissions,
  markSubmissionSeen,
  loadTemplate as loadQuestionnaireTemplate,
  saveTemplate as saveQuestionnaireTemplate,
} from './crm-questionnaire.mjs'
import { loadRecipient, saveRecipient } from './crm-recipients.mjs'
import { loadCustomValues, setCustomValue } from './crm-custom-fields.mjs'
import { importNewInquiries, listNotifications as listInquiryNotifications, dismissNotification as dismissInquiry, status as inquiriesStatus } from './crm-inquiries.mjs'
import {
  status as qbStatus,
  authUrl as qbAuthUrl,
  handleCallback as qbHandleCallback,
  disconnect as qbDisconnect,
  loadInvoices as qbLoadInvoices,
  createInvoiceForProject as qbCreateInvoice,
  sendInvoiceForProject as qbSendInvoice,
  refreshInvoiceStatus as qbRefreshInvoice,
  invoicePdfForProject as qbInvoicePdf,
} from './crm-quickbooks.mjs'
import {
  loadContracts,
  draftContract,
  createContract,
  setContractStatus,
  deleteContract,
  contractPdf,
  sendForSignature,
  refreshSignature,
  signedContractPdf,
  sendContractFromTemplate,
} from './crm-contracts.mjs'
import { loadUnseenNotifications, addNotification, markNotificationSeen } from './crm-notifications.mjs'
import {
  isClaudeAvailable,
  isClaudeConfigured,
  draftEmail as claudeDraftEmail,
  completeTemplate as claudeCompleteTemplate,
  draftReply as claudeDraftReply,
  chat as claudeChat,
} from './crm-claude.mjs'
import { status as esignStatus, listTemplates as esignListTemplates } from './crm-esign.mjs'
import {
  defaultTemplateHtml,
  FIELD_DEFS as CONTRACT_FIELD_DEFS,
  BRAND as CONTRACT_BRAND,
  TITLE as CONTRACT_TITLE,
  SIGNATURE_LINES as CONTRACT_SIGNATURE_LINES,
} from './crm-contract-template.mjs'
import { getAuthUrl, exchangeCode, isConnected, credentialsPresent, unreadByProject } from './crm-gmail.mjs'
import { listFiles, saveFile, readFile, deleteFile } from './crm-files.mjs'
import { saveAttachment, deleteAttachment } from './crm-email-attachments.mjs'
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
// Gmail rejects messages over ~25 MB (attachments are base64-inflated), so cap uploads there.
const MAX_EMAIL_ATTACHMENT = 25 * 1024 * 1024

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
      // One-off email attachment uploads (kept out of the Files page). Raw body = file bytes.
      server.middlewares.use('/api/email-attachments/upload', (req, res, next) => {
        if (req.method !== 'POST') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        const name = url.searchParams.get('name') || 'attachment.bin'
        const chunks = []
        let size = 0
        let aborted = false
        req.on('data', (c) => {
          size += c.length
          if (size > MAX_EMAIL_ATTACHMENT) {
            aborted = true
            res.statusCode = 413
            res.end(JSON.stringify({ error: 'Attachment too large (25 MB max)' }))
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
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ attachment: saveAttachment(name, Buffer.concat(chunks)) }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
        })
      })
      server.middlewares.use('/api/email-attachments/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteAttachment(b.id))
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
          // Built-ins minus deleted, plus custom fields: what may be shared on the portal right now.
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ portals: loadPortals(), shareableFields: currentShareableFields(), baseUrl: PORTAL_BASE_URL }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Client questionnaire (optional portal add-on). Specific paths before generic. ---
      // Turn it on/off + edit the intro. Enabling publishes the portal so the link is live and
      // the bundle carries the questions, then redeploys (~20-40s, same as a portal publish).
      server.middlewares.use('/api/questionnaire/set', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const questionnaire = setQuestionnaire(b.projectId, { enabled: b.enabled, intro: b.intro })
          let portal = loadPortal(b.projectId)
          if (b.enabled) portal = savePortal({ projectId: b.projectId, patch: { published: true } })
          writeBundleFile(b.projectId)
          const deploy = await deployPortal()
          const token = portal?.token || ''
          return { questionnaire, portalUrl: token ? `${PORTAL_BASE_URL}/p/${token}` : '', published: !!portal?.published, deploy }
        })
      })
      // Pull a project's latest submission, auto-fill its mapped fields, and (on a fresh one)
      // rebuild + redeploy the portal so its Event details reflect what the client just entered.
      const pullAndRepublish = async (projectId) => {
        const result = await pullResponse(projectId)
        if (result?.fresh) {
          try {
            writeBundleFile(projectId)
            result.deploy = await deployPortal()
          } catch (e) {
            result.deploy = { ok: false, error: String(e?.message || e) }
          }
        }
        return result
      }
      // Attach the project's display name to each unseen submission for the notification list.
      const submissionsWithNames = () => {
        const byId = new Map(loadAll().projects.map((p) => [p.id, p.client]))
        return loadUnseenSubmissions().map((s) => ({ ...s, projectName: byId.get(s.projectId) || s.projectId }))
      }

      server.middlewares.use('/api/questionnaire/pull', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await pullAndRepublish(b.projectId))
      })
      // Background sweep used by the app's notification poll: pull every active-but-unanswered
      // questionnaire (the gate is one-time, so a project that already has a response has nothing
      // new), republishing any that just came in. Returns the current unseen submissions.
      server.middlewares.use('/api/questionnaire/check', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async () => {
          const qs = loadQuestionnaires()
          let fresh = 0
          for (const [projectId, q] of Object.entries(qs)) {
            if (!q || !q.enabled || q.response) continue
            const r = await pullAndRepublish(projectId)
            if (r?.fresh) fresh++
          }
          return { fresh, submissions: submissionsWithNames() }
        })
      })
      // The current unseen submissions (cheap; does not pull).
      server.middlewares.use('/api/questionnaire/submissions', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ submissions: submissionsWithNames() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
      // Acknowledge a submission (clears its notification). Returns the remaining unseen ones.
      server.middlewares.use('/api/questionnaire/seen', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => {
          markSubmissionSeen(b.projectId)
          return { submissions: submissionsWithNames() }
        })
      })

      // --- Document recipients (contract signer + invoice bill-to) ---
      server.middlewares.use('/api/recipients/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ recipient: saveRecipient(b.projectId, b) }))
      })
      server.middlewares.use('/api/recipients', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
          const projectId = url.searchParams.get('projectId') || ''
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ recipient: loadRecipient(projectId) }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Per-project values for user-defined custom event fields ---
      server.middlewares.use('/api/custom-values/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => setCustomValue(b))
      })
      server.middlewares.use('/api/custom-values', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
          const projectId = url.searchParams.get('projectId') || ''
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ values: loadCustomValues(projectId) }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Global questionnaire template (Settings editor) ---
      server.middlewares.use('/api/questionnaire-template/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ template: saveQuestionnaireTemplate(b) }))
      })
      server.middlewares.use('/api/questionnaire-template', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ template: loadQuestionnaireTemplate() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Status-change notifications (invoice paid, contract viewed, contract signed) ---
      const NOTIF_LABELS = {
        'invoice-paid': 'Invoice paid',
        'contract-viewed': 'Contract viewed',
        'contract-signed': 'Contract signed',
      }
      const withNotifNames = (events) => {
        const byId = new Map(loadAll().projects.map((p) => [p.id, p.client]))
        return events.map((e) => ({ ...e, projectName: byId.get(e.projectId) || e.projectId, label: NOTIF_LABELS[e.kind] || e.kind }))
      }
      // Poll SignWell + QuickBooks for status transitions and record any NEWLY detected ones (only a
      // transition that happens during this sweep fires, so pre-existing signed/paid states do not
      // spam). Each item is wrapped in try/catch so one unreachable service does not break the sweep.
      const sweepStatusNotifications = async () => {
        const active = new Set(loadAll().projects.filter((p) => p.bucket === 'active').map((p) => p.id))
        let contracts = {}
        try {
          contracts = loadContracts()
        } catch {
          contracts = {}
        }
        for (const [projectId, versions] of Object.entries(contracts)) {
          if (!active.has(projectId)) continue
          for (const v of versions || []) {
            const e = v && v.esign
            if (!e || !e.id || e.signedAt) continue
            const stLower = String(e.status || '').toLowerCase()
            if (['declined', 'expired', 'bounced', 'canceled', 'cancelled', 'error'].includes(stLower)) continue
            const had = { viewed: !!e.viewedAt, signed: !!e.signedAt }
            try {
              const ref = await refreshSignature(projectId, v.id)
              const ne = (ref && ref.esign) || {}
              if (!had.viewed && ne.viewedAt) addNotification(projectId, 'contract-viewed', v.id)
              if (!had.signed && ne.signedAt) addNotification(projectId, 'contract-signed', v.id)
            } catch {
              /* SignWell unreachable / not configured for this one; skip */
            }
          }
        }
        let invoices = {}
        try {
          invoices = qbLoadInvoices()
        } catch {
          invoices = {}
        }
        for (const [projectId, ref] of Object.entries(invoices)) {
          if (!active.has(projectId) || !ref || !ref.invoiceId || ref.paidAt) continue
          try {
            const updated = await qbRefreshInvoice(projectId)
            if (updated && updated.paidAt) addNotification(projectId, 'invoice-paid', ref.invoiceId)
          } catch {
            /* QuickBooks unreachable / not connected; skip */
          }
        }
        return withNotifNames(loadUnseenNotifications())
      }

      server.middlewares.use('/api/notifications/check', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async () => ({ notifications: await sweepStatusNotifications() }))
      })
      server.middlewares.use('/api/notifications/seen', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ notifications: withNotifNames(markNotificationSeen(b.id)) }))
      })
      server.middlewares.use('/api/notifications', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ notifications: withNotifNames(loadUnseenNotifications()) }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Claude drafting (headless Claude Code; reads voice/CLAUDE.md/recordings) ---
      server.middlewares.use('/api/claude/draft', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          try {
            return { draft: await claudeDraftEmail({ projectId: b.projectId, label: b.label, instruction: b.instruction }) }
          } catch (e) {
            return { error: String(e?.message || e) }
          }
        })
      })
      server.middlewares.use('/api/claude/complete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          try {
            return { draft: await claudeCompleteTemplate({ projectId: b.projectId, body: b.body }) }
          } catch (e) {
            return { error: String(e?.message || e) }
          }
        })
      })
      server.middlewares.use('/api/claude/reply', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          try {
            return { draft: await claudeDraftReply({ projectId: b.projectId, threadText: b.threadText }) }
          } catch (e) {
            return { error: String(e?.message || e) }
          }
        })
      })
      server.middlewares.use('/api/claude/chat', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          try {
            return { reply: await claudeChat({ projectId: b.projectId, message: b.message, history: b.history }) }
          } catch (e) {
            return { error: String(e?.message || e) }
          }
        })
      })
      server.middlewares.use('/api/claude', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ available: isClaudeAvailable(), configured: isClaudeConfigured() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
      // Current questionnaire state for a project (drives the card).
      server.middlewares.use('/api/questionnaire', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
          const projectId = url.searchParams.get('projectId') || ''
          const portal = loadPortal(projectId)
          const token = portal?.token || ''
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              questionnaire: loadQuestionnaire(projectId),
              blobConfigured: isBlobConfigured(),
              published: !!portal?.published,
              portalUrl: token ? `${PORTAL_BASE_URL}/p/${token}` : '',
            }),
          )
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- HoneyBook inquiry sync (reads the Notion Activity Log, auto-creates projects). ---
      server.middlewares.use('/api/inquiries/check', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async () => await importNewInquiries())
      })
      server.middlewares.use('/api/inquiries/dismiss', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => dismissInquiry(b.blockId))
      })
      server.middlewares.use('/api/inquiries', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ status: inquiriesStatus(), notifications: listInquiryNotifications() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- QuickBooks (OAuth connect + invoices). Specific paths before generic. ---
      server.middlewares.use('/api/quickbooks/auth', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.writeHead(302, { Location: qbAuthUrl() })
          res.end()
        } catch (e) {
          res.statusCode = 400
          res.end(String(e?.message || e))
        }
      })
      server.middlewares.use('/api/quickbooks/callback', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        qbHandleCallback({ code: url.searchParams.get('code'), realmId: url.searchParams.get('realmId') })
          .then(() => {
            res.writeHead(302, { Location: '/?qb=connected' })
            res.end()
          })
          .catch((e) => {
            res.setHeader('Content-Type', 'text/html')
            res.end(`<body style="font-family:sans-serif;padding:40px"><h2>QuickBooks connection failed</h2><p>${String(e?.message || e)}</p><p>Close this tab and try Connect again.</p></body>`)
          })
      })
      server.middlewares.use('/api/quickbooks/disconnect', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, () => qbDisconnect())
      })
      server.middlewares.use('/api/quickbooks/invoice/send', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ invoice: await qbSendInvoice(b.projectId, b.email) }))
      })
      server.middlewares.use('/api/quickbooks/invoice/pdf', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        const projectId = url.searchParams.get('projectId') || ''
        qbInvoicePdf(projectId)
          .then(({ buffer, docNumber }) => {
            res.setHeader('Content-Type', 'application/pdf')
            res.setHeader('Content-Disposition', `inline; filename="invoice-${docNumber}.pdf"`)
            res.end(buffer)
          })
          .catch((e) => {
            // Render a readable page in the new tab rather than raw JSON.
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/html')
            res.end(`<body style="font-family:sans-serif;padding:40px"><h2>Couldn't load the invoice preview</h2><p>${String(e?.message || e)}</p></body>`)
          })
      })
      server.middlewares.use('/api/quickbooks/invoice', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({
          invoice: await qbCreateInvoice(b.projectId, {
            amount: b.amount,
            dueDate: b.dueDate,
            processingFeePercent: b.processingFeePercent,
            customerName: b.customerName,
            email: b.email,
          }),
        }))
      })
      server.middlewares.use('/api/quickbooks', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ status: qbStatus(), invoices: qbLoadInvoices() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Contracts (generate a Performance Services Agreement PDF; versioned). ---
      server.middlewares.use('/api/contracts/draft', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => draftContract(b.projectId))
      })
      server.middlewares.use('/api/contracts/status', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ contract: setContractStatus(b.projectId, b.id, b.status) }))
      })
      server.middlewares.use('/api/contracts/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => deleteContract(b.projectId, b.id))
      })
      server.middlewares.use('/api/contracts/pdf', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        contractPdf(url.searchParams.get('projectId') || '', url.searchParams.get('id') || '')
          .then(({ buffer, fileName }) => {
            res.setHeader('Content-Type', 'application/pdf')
            res.setHeader('Content-Disposition', `inline; filename="${fileName}"`)
            res.end(buffer)
          })
          .catch((e) => {
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/html')
            res.end(`<body style="font-family:sans-serif;padding:40px"><h2>Couldn't load the contract</h2><p>${String(e?.message || e)}</p></body>`)
          })
      })
      server.middlewares.use('/api/contracts/send-signature', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ contract: await sendForSignature(b.projectId, b.id, { signerName: b.signerName, signerEmail: b.signerEmail }) }))
      })
      server.middlewares.use('/api/contracts/refresh-signature', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ contract: await refreshSignature(b.projectId, b.id) }))
      })
      // Send a contract by summoning a SignWell template (the current approach).
      server.middlewares.use('/api/contracts/send', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({
          contract: await sendContractFromTemplate(b.projectId, {
            templateId: b.templateId,
            templateLabel: b.templateLabel,
            signerName: b.signerName,
            signerEmail: b.signerEmail,
          }),
        }))
      })
      // The SignWell templates available to send (for the contract picker).
      server.middlewares.use('/api/contract-templates', (req, res, next) => {
        if (req.method !== 'GET') return next()
        esignListTemplates()
          .then((templates) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ templates }))
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          })
      })
      server.middlewares.use('/api/contracts/signed-pdf', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        signedContractPdf(url.searchParams.get('projectId') || '', url.searchParams.get('id') || '')
          .then(({ buffer, fileName }) => {
            res.setHeader('Content-Type', 'application/pdf')
            res.setHeader('Content-Disposition', `inline; filename="${fileName}"`)
            res.end(buffer)
          })
          .catch((e) => {
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/html')
            res.end(`<body style="font-family:sans-serif;padding:40px"><h2>Couldn't load the signed contract</h2><p>${String(e?.message || e)}</p></body>`)
          })
      })
      server.middlewares.use('/api/contract-template', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            const cfg = loadConfig()
            const custom = cfg.contractTemplate && String(cfg.contractTemplate).trim()
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                template: custom || defaultTemplateHtml(),
                isCustom: !!custom,
                brand: CONTRACT_BRAND,
                title: CONTRACT_TITLE,
                signatureLines: CONTRACT_SIGNATURE_LINES,
                fields: CONTRACT_FIELD_DEFS.map((d) => ({ key: d.key, label: d.label })),
              }),
            )
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
          return
        }
        if (req.method !== 'POST') return next()
        // Empty template resets to the built-in default.
        withbody(req, res, (b) => {
          saveConfig({ contractTemplate: b.template == null ? '' : String(b.template) })
          return { ok: true }
        })
      })
      server.middlewares.use('/api/esign', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ status: esignStatus() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
      server.middlewares.use('/api/contracts', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ contracts: loadContracts() }))
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          }
          return
        }
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ contract: createContract(b.projectId, { body: b.body, includeMedia: b.includeMedia }) }))
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
