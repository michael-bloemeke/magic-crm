// Vite dev-server plugin: serves the CRM data layer over HTTP so the React app
// can read the live project records and persist stage changes.
//
//   GET  /api/projects        -> { projects: [...] } (live from the JSON files)
//   POST /api/stage           -> body { id, stageId }; persists to crm-pipeline.json
//
// Dev-only. When this becomes an Electron app, the renderer will call the same
// crm-data-core functions over IPC instead.

import { exec } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRM_STORE, initStore, checkDataVersion } from './crm-store.mjs'
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
  purgeProject,
  loadStructure,
  saveStructure,
  reassignStage,
  appendActivityLog,
} from './crm-data-core.mjs'
import { loadThreads, draftReply, sendEmail, loadInbox, markRead, starThread, starMessage } from './crm-comms.mjs'
import { loadEmails, saveProjectEmail, sendProjectEmail, deleteProjectEmail } from './crm-emails.mjs'
import { loadTextMarkers, saveTextMarker } from './crm-text-markers.mjs'
import { bookingFormLink, pullSubmission, submissionSummary, invoiceTarget, draftBookingEmail, liveProgress } from './crm-booking-form.mjs'
import { sendAgreement, publishAgreement, autoInvoice, refreshPaidInvoices, publishContractTemplates, contractVariants, resetBooking } from './crm-booking-agreement.mjs'
import {
  syncProject,
  syncTask,
  removeProjectEvent,
  removeTaskEvent,
  syncAll as syncCalendarAll,
  calendarStatus,
  sendCalendarInvite,
  listGigsEvents,
} from './crm-calendar.mjs'
import { loadRecipient, saveRecipient } from './crm-recipients.mjs'
import { loadCustomValues, setCustomValue } from './crm-custom-fields.mjs'
import { importNewInquiries, listNotifications as listInquiryNotifications, dismissNotification as dismissInquiry, status as inquiriesStatus, inquiryFormForProject } from './crm-inquiries.mjs'
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
  bookingAgreementPdf,
} from './crm-contracts.mjs'
import { loadUnseenNotifications, addNotification, markNotificationSeen } from './crm-notifications.mjs'
import { getPushConfig, setPushConfig, sendPush, subscribeUrl } from './crm-push.mjs'
import { loadAnalytics } from './crm-analytics.mjs'
import { buildSnapshot } from './crm-snapshot.mjs'
import {
  isClaudeAvailable,
  isClaudeConfigured,
  draftEmail as claudeDraftEmail,
  completeDraft as claudeCompleteDraft,
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
import { getAuthUrl, exchangeCode, isConnected, credentialsPresent, unreadByProject, createDraft as gmailCreateDraft } from './crm-gmail.mjs'
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
    async configureServer(server) {
      // Under CRM_STORE=supabase every synchronous read funnel (loadAll/loadContacts/loadLinks/
      // loadStructure) serves from the in-memory cache, so prime it ONCE before handling requests.
      // Under files this is a no-op. If it throws (bad creds/network), fail loudly at startup.
      let cacheRefreshTimer = null
      if (CRM_STORE === 'supabase') {
        await initStore()
        console.log('[crm-data] Supabase store initialized (CRM_STORE=supabase).')
        // Supabase is the shared source of truth (phone, Cowork, Claude Code all write to it), but the
        // sync read funnels serve from the in-memory cache primed above. Re-prime it on a timer so edits
        // made elsewhere show up here without restarting the app. Non-overlapping (a slow refresh skips
        // the next tick rather than stacking) and best-effort (a failed refresh just logs and the next
        // tick retries; it never crashes the server). Keeps the cache at most ~15s stale.
        // Egress guard: poll the ~30-byte data_version sentinel every 15s and only run the full
        // 21-table reload (~1.35 MB) when something actually wrote to the database. The old
        // unconditional reload burned ~7.6 GB/day against a 5 GB/month Supabase allowance.
        // Same 15s freshness for cross-device edits, at roughly 0.1% of the traffic.
        let refreshing = false
        cacheRefreshTimer = setInterval(async () => {
          if (refreshing) return
          refreshing = true
          try {
            const { changed } = await checkDataVersion()
            if (changed) await initStore({ force: true })
          } catch (e) {
            console.error('[crm-data] cache refresh failed (will retry next tick):', e?.message || e)
          } finally {
            refreshing = false
          }
        }, 15 * 1000)
      }
      // Push the contract wording (every variant, fields unfilled) up to Supabase so the CLOUD can
      // build a booking agreement. Without this the phone cannot issue a booking form at all, because
      // the template needs JSDOM and only exists here. Cheap and idempotent; runs once per boot, so
      // editing the template and relaunching is all it takes to update it everywhere.
      publishContractTemplates()
        .then((r) => { if (r?.ok) console.log(`[crm-data] contract templates published: ${r.variants.join(', ')}`) })
        .catch((e) => console.error('[crm-data] could not publish contract templates:', e?.message || e))

      // Back up shortly after the app starts, then every 4 hours it stays running.
      const t1 = setTimeout(runBackup, 90_000)
      const t2 = setInterval(runBackup, 4 * 60 * 60 * 1000)
      // (The phone app reads Supabase directly now, so the old Vercel Blob snapshot upload was
      // removed 2026-08-03 along with everything else on Vercel.)
      // Keep the Gigs calendar in step with EVERY active/completed dated project, including
      // website inquiries (edge function) and HoneyBook imports (SQL) that never go through the
      // app's per-action sync. syncAll is idempotent (upsert by stored event id), so re-running is
      // safe; it also carries the "Inquiry: " prefix for anything not yet booked. Skips fast if the
      // calendar isn't connected.
      const syncCal = () => { syncCalendarAll().catch(() => {}) }
      const t5 = setTimeout(syncCal, 20_000)
      const t6 = setInterval(syncCal, 5 * 60 * 1000)
      // Watch for returned booking forms and mail the agreement out on its own. Every 2 minutes:
      // fast enough that a client submitting the form has their contract within a couple of minutes,
      // slow enough to be nothing traffic-wise. Costs ZERO database calls when no project is waiting
      // on an agreement, which is almost always. Non-overlapping, so a slow PDF render or a hung
      // Gmail call skips the next tick instead of stacking sends on top of each other.
      //
      // This only runs while the Mac is up. The PDF is rendered by pdfmake using macOS system fonts,
      // so it cannot move to an edge function without rewriting the renderer. If a client books while
      // Michael is out, their agreement goes the next time the CRM is running.
      // NOTE: sending the signed agreement and raising the invoice NO LONGER HAPPEN HERE. They moved
      // to the `booking-complete` edge function on 2026-08-03, driven by pg_cron every minute, so a
      // client who signs at 2am is finished with by 2:01am whether or not this Mac is switched on.
      //
      // Deliberately NOT left running as a local backstop. Both would work (every step is claimed
      // with a conditional update, so they could not double-send), but they render the PDF with
      // different engines, and a client receiving a different-looking document depending on whether
      // a laptop happened to be open is worse than having no backstop.
      //
      // What stays here is the QuickBooks paid check, because the thing it feeds (the Google
      // Calendar sync that drops the "Inquiry: " prefix) is itself still Mac-bound.
      let autoSending = false
      const sweepBooking = async () => {
        if (autoSending) return
        autoSending = true
        try {
          const { paid } = await refreshPaidInvoices()
          // A newly paid invoice changes what the calendar should call the gig (isProjectBooked
          // reads the invoice), so push the change out now instead of waiting for the 5-minute tick.
          if (paid > 0) syncCalendarAll().catch(() => {})
        } catch (e) {
          console.error('[crm-data] paid-invoice check failed:', e?.message || e)
        } finally {
          autoSending = false
        }
      }
      const t7 = setTimeout(sweepBooking, 30_000)
      const t8 = setInterval(sweepBooking, 2 * 60 * 1000)
      server.httpServer?.on('close', () => {
        clearTimeout(t1)
        clearInterval(t2)
        clearTimeout(t5)
        clearInterval(t6)
        clearTimeout(t7)
        clearInterval(t8)
        if (cacheRefreshTimer) clearInterval(cacheRefreshTimer)
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
        req.on('end', async () => {
          try {
            const { id, stageId } = JSON.parse(body || '{}')
            const result = await setStage(id, stageId)
            void syncProject(id) // a stage change can flip Inquiry <-> booked; keep the calendar in step
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
          withbody(req, res, async (b) => ({ structure: await saveStructure(b.structure) }))
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
          req.on('end', async () => {
            try {
              const layout = JSON.parse(body || '{}')
              await saveLayout(layout)
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
        withbody(req, res, async (b) => {
          const task = await addTask(b)
          void syncTask(task.id)
          return { task }
        })
      })
      server.middlewares.use('/api/tasks/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const task = await updateTask(b)
          void syncTask(task.id) // date/time/done change -> upsert or remove the Work-calendar event
          return { task }
        })
      })
      server.middlewares.use('/api/tasks/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          void removeTaskEvent(b.id)
          return await deleteTask(b.id)
        })
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
      // Star / unstar. A messageId stars that one message; otherwise the whole thread.
      server.middlewares.use('/api/comms/star', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => (b.messageId ? starMessage(b) : starThread(b)))
      })
      server.middlewares.use('/api/comms', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => loadThreads(b.projectId))
      })

      server.middlewares.use('/api/project/field', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const r = await updateProjectField(b)
          void syncProject(b.id) // location/times/name/date edits flow to the gig's calendar event
          return r
        })
      })

      server.middlewares.use('/api/project/log-call', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => logCall(b))
      })

      server.middlewares.use('/api/project/create', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const project = await createProject(b)
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
              match || (await addContact({ name: name || emails[0], emails, phones, type: 'client', relationship: 'active' }))
            await setProjectContacts(project.id, [contact.id])
          } else {
            await setProjectContacts(project.id, []) // explicit empty entry -> never auto-seeded
          }
          void syncProject(project.id) // a new dated project appears on the Gigs calendar
          return { project }
        })
      })

      // Archive / complete / restore: move a project between canonical buckets.
      server.middlewares.use('/api/project/archive', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const r = await archiveProject(b)
          void syncProject(b.id) // no longer active -> its gig event is removed
          return r
        })
      })
      server.middlewares.use('/api/project/complete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const r = await completeProject(b)
          void syncProject(b.id) // no longer active -> its gig event is removed
          return r
        })
      })
      server.middlewares.use('/api/project/restore', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const r = await restoreProject(b)
          void syncProject(b.id) // active again -> its gig event comes back
          return r
        })
      })
      // Soft delete: move the project to the 30-day trash (the Deleted page). Nothing is
      // destroyed. Payments, mileage, tasks, links, and inquiries all survive so a restore
      // is lossless. The only side effect is pulling the gig's calendar event (restore
      // re-adds it via syncProject) so a trashed gig isn't left on the calendar.
      server.middlewares.use('/api/project/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const result = await deleteProject(b)
          void removeProjectEvent(b.id)
          return result
        })
      })
      // Permanent delete (full cascade, NO undo): removes the project row AND every
      // per-project record across all tables, plus its calendar events. Used by the
      // "Delete permanently" action; the 30-day sweep calls the same purgeProject path.
      server.middlewares.use('/api/project/purge', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          // Capture task ids BEFORE the purge clears them, so their calendar events go too.
          const taskIds = loadTasks()
            .filter((t) => t.projectId === b.id)
            .map((t) => t.id)
          const result = await purgeProject(b)
          // Belt-and-braces for the files path (under supabase these already cascaded).
          await deletePaymentsForProject(b.id)
          await deleteTripsForProject(b.id)
          await deleteProjectLinks(b.id)
          void removeProjectEvent(b.id)
          for (const tid of taskIds) void removeTaskEvent(tid)
          return result
        })
      })

      // --- Contacts (specific paths before the generic GET) ---
      server.middlewares.use('/api/contacts/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ contact: await addContact(b) }))
      })
      server.middlewares.use('/api/contacts/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ contact: await updateContact(b) }))
      })
      server.middlewares.use('/api/contacts/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        // Deleting a contact also strips it from every project it was on, so it
        // stays gone (no resurrection) and no project keeps a dangling link.
        withbody(req, res, async (b) => {
          const result = await deleteContact(b.id)
          await purgeContact(b.id)
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
        withbody(req, res, async (b) => ({ links: await linkContact(b.projectId, b.contactId) }))
      })
      server.middlewares.use('/api/links/remove', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ links: await unlinkContact(b.projectId, b.contactId) }))
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

      // (The /api/templates routes were removed 2026-07-31 with the email-template library.)

      // --- Composed per-project emails (thank-you, etc.) ---
      server.middlewares.use('/api/emails/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ email: await saveProjectEmail(b) }))
      })
      server.middlewares.use('/api/emails/send', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => sendProjectEmail(b))
      })
      server.middlewares.use('/api/emails/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await deleteProjectEmail(b.id))
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

      // --- "Text sent" markers (manual SMS flags per email slot, no message content) ---
      server.middlewares.use('/api/text-markers/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ marker: await saveTextMarker(b) }))
      })
      server.middlewares.use('/api/text-markers', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ markers: loadTextMarkers() }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      server.middlewares.use('/api/recipients/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ recipient: await saveRecipient(b.projectId, b) }))
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

      // --- Status-change notifications (invoice paid, contract viewed, contract signed, task due,
      // new inquiry) ---
      const NOTIF_LABELS = {
        'invoice-paid': 'Invoice paid',
        'contract-viewed': 'Contract viewed',
        'contract-signed': 'Contract signed',
        'task-due': 'Task due',
        'new-inquiry': 'New inquiry',
      }
      const withNotifNames = (events) => {
        const byId = new Map(loadAll().projects.map((p) => [p.id, p.client]))
        // For task-due, resolve the source_id to the actual task so the bell shows the task's title
        // instead of the generic "Task due". Falls back to the generic label if the task is gone.
        let tasksById = new Map()
        try {
          tasksById = new Map(loadTasks().map((t) => [String(t.id), t]))
        } catch {
          tasksById = new Map()
        }
        return events.map((e) => {
          let label = NOTIF_LABELS[e.kind] || e.kind
          if (e.kind === 'task-due') {
            const t = tasksById.get(String(e.sourceId))
            if (t && t.title) label = String(t.title)
          }
          return { ...e, projectName: byId.get(e.projectId) || e.projectId, label }
        })
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
              if (!had.viewed && ne.viewedAt) await addNotification(projectId, 'contract-viewed', v.id)
              if (!had.signed && ne.signedAt) await addNotification(projectId, 'contract-signed', v.id)
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
            if (updated && updated.paidAt) await addNotification(projectId, 'invoice-paid', ref.invoiceId)
          } catch {
            /* QuickBooks unreachable / not connected; skip */
          }
        }
        // Tasks that have come due (or are overdue) and aren't done: fire once each (deduped by id).
        // Time-based, so this catches a task the moment a sweep runs on/after its due date.
        try {
          const now = new Date()
          const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
          for (const t of loadTasks()) {
            if (t.done || !t.dueDate) continue
            if (t.dueDate <= today && active.has(t.projectId)) await addNotification(t.projectId, 'task-due', t.id)
          }
        } catch {
          /* tasks unreadable; skip */
        }
        return withNotifNames(loadUnseenNotifications())
      }

      server.middlewares.use('/api/notifications/check', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async () => ({ notifications: await sweepStatusNotifications() }))
      })
      server.middlewares.use('/api/notifications/seen', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ notifications: withNotifNames(await markNotificationSeen(b.id)) }))
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

      // --- Phone push (ntfy) config + test ---
      const pushPublic = (c) => ({ enabled: !!c.enabled, topic: c.topic, server: c.server, subscribeUrl: subscribeUrl(c) })
      server.middlewares.use('/api/push/save', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, (b) => ({ push: pushPublic(setPushConfig(b)) }))
      })
      server.middlewares.use('/api/push/test', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async () => ({
          result: await sendPush({ title: 'Magic CRM', message: 'Test alert. Notifications are working.', tags: ['sparkles'] }, { force: true }),
        }))
      })
      server.middlewares.use('/api/push', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ push: pushPublic(getPushConfig()) }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- The saved website inquiry form for a project (for the Inquiry section) ---
      server.middlewares.use('/api/inquiry', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ inquiry: inquiryFormForProject(url.searchParams.get('projectId') || '') }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Read-only snapshot for the phone app (served locally for dev; synced to cloud later) ---
      server.middlewares.use('/api/snapshot', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(buildSnapshot()))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })

      // --- Local preview of the mobile PWA at /m/ (the real phone app deploys to the cloud later) ---
      const MOBILE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mobile')
      const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' }
      server.middlewares.use('/m', (req, res, next) => {
        if (req.method !== 'GET') return next()
        try {
          const u = new URL(req.originalUrl || req.url, 'http://localhost:5199')
          let rel = u.pathname.replace(/^\/m\/?/, '').replace(/\.\.+/g, '')
          if (!rel) rel = 'index.html'
          const file = path.join(MOBILE_DIR, rel)
          if (!file.startsWith(MOBILE_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.statusCode = 404
            res.end('Not found')
            return
          }
          res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream')
          res.end(fs.readFileSync(file))
        } catch (e) {
          res.statusCode = 500
          res.end(String(e?.message || e))
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
            return { draft: await claudeCompleteDraft({ projectId: b.projectId, body: b.body }) }
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

      // --- HoneyBook inquiry sync (reads the Notion Activity Log, auto-creates projects). ---
      server.middlewares.use('/api/inquiries/check', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async () => await importNewInquiries())
      })
      server.middlewares.use('/api/inquiries/dismiss', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await dismissInquiry(b.blockId))
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

      // --- Live website analytics (proxies + caches the website-analytics edge function). ---
      server.middlewares.use('/api/analytics', (req, res, next) => {
        if (req.method !== 'GET') return next()
        loadAnalytics()
          .then((data) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(data))
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          })
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
        withbody(req, res, async (b) => ({ contract: await setContractStatus(b.projectId, b.id, b.status) }))
      })
      server.middlewares.use('/api/contracts/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await deleteContract(b.projectId, b.id))
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
      // --- Booking agreement (booking-form route) ---
      // Built fresh on every request from the project + the client's form submission, so it can
      // never drift from what the CRM holds. Nothing is versioned: there is one current agreement.
      server.middlewares.use('/api/booking/agreement-pdf', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        const download = url.searchParams.get('download') === '1'
        bookingAgreementPdf(url.searchParams.get('projectId') || '')
          .then(({ buffer, fileName }) => {
            res.setHeader('Content-Type', 'application/pdf')
            res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${fileName}"`)
            res.end(buffer)
          })
          .catch((e) => {
            res.statusCode = 500
            res.setHeader('Content-Type', 'text/html')
            res.end(`<body style="font-family:sans-serif;padding:40px"><h2>Couldn't build the agreement</h2><p>${String(e?.message || e)}</p></body>`)
          })
      })
      // "Ready to book": issue the link, PUBLISH the agreement to the website, and leave a
      // ready-to-send draft in Gmail. Never sends the email itself.
      //
      // Order matters. draftBookingEmail runs the gates (performance style + quote) and throws
      // before anything is written, so a project that isn't ready produces no half-finished state.
      // Publishing then happens before Michael can possibly send the draft, which means the client
      // can never reach the signing step and find no agreement waiting for them.
      server.middlewares.use('/api/booking/ready', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const project = loadAll().projects.find((p) => p.id === b.projectId)
          if (!project) throw new Error('Project not found.')
          const variant = String(b.variant || 'standard')
          // RESEND wipes the previous attempt first: its timestamps, its signature, and the CRM's
          // record of the invoice. Otherwise the timeline would still show them having signed the
          // version being replaced, and the claim stamps would block the corrected copy going out.
          if (b.resend) await resetBooking(b.projectId)
          const draft = await draftBookingEmail(b.projectId, { createDraft: gmailCreateDraft, project })
          await publishAgreement(b.projectId, { variant })
          return { ...draft, variant, reset: !!b.resend }
        })
      })
      // Re-publish the agreement after changing a detail on the project, for a client who has the
      // link but hasn't signed yet. Without this they'd sign the version from before the edit.
      server.middlewares.use('/api/booking/republish', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await publishAgreement(b.projectId, { variant: String(b.variant || 'standard') }))
      })
      // Which contract versions Michael can choose between when sending a booking form.
      server.middlewares.use('/api/booking/variants', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ variants: contractVariants() }))
      })
      // Issue (or reuse) this project's booking-form link.
      server.middlewares.use('/api/booking/link', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => bookingFormLink(b.projectId))
      })
      // Poll for the client's answers AND their signature, and apply both to the project.
      //
      // The 2-minute sweep would pick this up on its own, but Michael pressing "Check" means he is
      // sitting there waiting, so do the whole thing now. A failure to SEND is reported without
      // failing the pull: the answers and the signature landed either way, and the sweep retries.
      server.middlewares.use('/api/booking/pull', (req, res, next) => {
        if (req.method !== 'POST') return next()
        // READ ONLY as of 2026-08-03. This used to send the signed agreement and raise the invoice
        // itself. It must not any more: `booking-complete` owns both now, and this path renders the
        // PDF with a different engine, so letting it fire would mean a client's copy looking
        // different depending on which one got there first. It pulls state and nothing else.
        withbody(req, res, async (b) => await pullSubmission(b.projectId))
      })
      // Re-send the signed copy, for a client who says it never arrived. The only path that sends a
      // second copy; the automatic one never does.
      server.middlewares.use('/api/booking/resend-agreement', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await sendAgreement(b.projectId, { force: true }))
      })
      // Current state of the booking form for a project. Carries a LIVE progress read (not viewed /
      // viewed / submitted / signed) so the card's status bar moves on its own; there is no longer a
      // button for Michael to press to find out.
      server.middlewares.use('/api/booking/status', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        const pid = url.searchParams.get('projectId') || ''
        Promise.resolve()
          .then(async () => {
            const base = { ...bookingFormLink(pid), summary: submissionSummary(pid), invoiceTo: invoiceTarget(pid) }
            return { ...base, progress: await liveProgress(pid) }
          })
          .then((out) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(out))
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
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
        withbody(req, res, async (b) => {
          await saveConfig({ contractTemplate: b.template == null ? '' : String(b.template) })
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
        withbody(req, res, async (b) => ({ contract: await createContract(b.projectId, { body: b.body, includeMedia: b.includeMedia }) }))
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
          withbody(req, res, async (b) => await saveConfig(b))
          return
        }
        next()
      })

      // --- Finance (specific paths before the generic GET) ---
      server.middlewares.use('/api/finance/payments/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ payment: await addPayment(b) }))
      })
      server.middlewares.use('/api/finance/payments/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ payment: await updatePayment(b) }))
      })
      server.middlewares.use('/api/finance/payments/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await deletePayment(b.id))
      })
      server.middlewares.use('/api/finance/payments', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ payments: loadPayments() }))
      })
      server.middlewares.use('/api/finance/expenses/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ expense: await addExpense(b) }))
      })
      server.middlewares.use('/api/finance/expenses/update', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ expense: await updateExpense(b) }))
      })
      server.middlewares.use('/api/finance/expenses/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await deleteExpense(b.id))
      })
      server.middlewares.use('/api/finance/expenses', (req, res, next) => {
        if (req.method !== 'GET') return next()
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ expenses: loadExpenses() }))
      })
      server.middlewares.use('/api/finance/mileage/add', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => ({ trip: await addTrip(b) }))
      })
      server.middlewares.use('/api/finance/mileage/delete', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await deleteTrip(b.id))
      })
      server.middlewares.use('/api/finance/mileage/rate', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => await setMileageRate(b.rate))
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

      // --- Google Calendar (shares the Google connection above) ---
      server.middlewares.use('/api/calendar/sync', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, () => syncCalendarAll())
      })
      server.middlewares.use('/api/calendar/gigs', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const url = new URL(req.originalUrl || req.url, 'http://localhost:5199')
        listGigsEvents(url.searchParams.get('from') || '', url.searchParams.get('to') || '')
          .then((r) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(r))
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(JSON.stringify({ ok: false, events: [], error: String(e?.message || e) }))
          })
      })
      server.middlewares.use('/api/calendar/invite', (req, res, next) => {
        if (req.method !== 'POST') return next()
        withbody(req, res, async (b) => {
          const result = await sendCalendarInvite({
            summary: b.summary,
            dateISO: b.date,
            startTime: b.startTime,
            durationMin: b.durationMin,
            attendees: Array.isArray(b.attendees) ? b.attendees : [],
            location: b.location,
            description: b.description,
            allDay: b.allDay,
          })
          // Log the send on the project so it shows in the activity timeline.
          if (result.ok && b.projectId) {
            const who = (result.attendees || []).join(', ')
            const when = `${b.date}${b.startTime ? ' ' + b.startTime : ''}`
            await appendActivityLog(b.projectId, `Sent calendar invite "${result.summary}" (${when})${who ? ' to ' + who : ''}.`)
          }
          return result
        })
      })
      server.middlewares.use('/api/calendar', (req, res, next) => {
        if (req.method !== 'GET') return next()
        calendarStatus()
          .then((status) => {
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(status))
          })
          .catch((e) => {
            res.statusCode = 500
            res.end(JSON.stringify({ error: String(e?.message || e) }))
          })
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
