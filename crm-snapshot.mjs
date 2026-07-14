// Read-only snapshot of the CRM for the phone app. Bundles everything the mobile view needs into a
// single JSON blob: projects (curated fields), tasks, the pipeline structure (stage names), custom
// field definitions + values, a finance summary, and recent notifications. Generated on the Mac and
// synced to the cloud so the phone reads a static, read-only copy that works even when the Mac is
// asleep. No write paths here; this only ever reads.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAll, loadTasks, loadStructure } from './crm-data-core.mjs'
import { loadConfig, computeFinance } from './crm-finance.mjs'
import { loadAllCustomValues } from './crm-custom-fields.mjs'
import { loadUnseenNotifications } from './crm-notifications.mjs'

// The web-push VAPID PUBLIC key (safe to expose) so the phone app can subscribe to notifications.
function vapidPublicKey() {
  try {
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), 'push-vapid.json')
    return JSON.parse(fs.readFileSync(f, 'utf8')).publicKey || ''
  } catch {
    return ''
  }
}

const NOTIF_LABELS = {
  'invoice-paid': 'Invoice paid',
  'contract-viewed': 'Contract viewed',
  'contract-signed': 'Contract signed',
  'task-due': 'Task due',
  'new-inquiry': 'New inquiry',
}

// Curated per-project fields for the phone (drops nothing client-facing-sensitive beyond what the
// desktop shows; the snapshot as a whole is protected by the app's passcode). activityLog is capped
// so the blob stays small.
function trimProject(p) {
  return {
    id: p.id,
    client: p.client,
    bucket: p.bucket,
    stageId: p.stageId,
    status: p.status,
    eventType: p.eventType,
    eventDate: p.eventDate,
    eventStartTime: p.eventStartTime,
    showStartTime: p.showStartTime,
    eventLocation: p.eventLocation,
    venueType: p.venueType,
    indoorsOrOutdoors: p.indoorsOrOutdoors,
    numberOfGuests: p.numberOfGuests,
    ageOfGuests: p.ageOfGuests,
    performanceStyle: p.performanceStyle,
    totalFee: p.totalFee,
    tips: p.tips,
    mileage: p.mileage,
    vips: p.vips,
    av: p.av,
    bookingSource: p.bookingSource,
    eventSummary: p.eventSummary,
    eventDescription: p.eventDescription,
    projectNotes: p.projectNotes,
    contactNames: p.contactNames,
    contactEmails: p.contactEmails,
    contactPhones: p.contactPhones,
    flags: p.flags,
    archiveReason: p.archiveReason,
    completedDate: p.completedDate,
    activityLog: Array.isArray(p.activityLog) ? p.activityLog.slice(0, 25) : [],
  }
}

export function buildSnapshot() {
  const all = loadAll()
  const cfg = loadConfig()
  const byId = new Map(all.projects.map((p) => [p.id, p.client]))

  let finance = null
  try {
    const f = computeFinance()
    finance = {
      year: f.year,
      thisMonth: f.thisMonth,
      monthlyGoal: f.monthlyGoal,
      goals: f.goals,
      last12: f.last12,
      expectedRemaining: f.expectedRemaining,
    }
  } catch {
    finance = null
  }

  // task-due resolves to the task's real title (fallback to the generic label if the task is gone),
  // matching crm-data-plugin's withNotifNames so the phone shows the same alert text everywhere.
  const tasksById = new Map(loadTasks().map((t) => [String(t.id), t]))
  const notifications = loadUnseenNotifications().map((e) => {
    let label = NOTIF_LABELS[e.kind] || e.kind
    if (e.kind === 'task-due') {
      const t = tasksById.get(String(e.sourceId))
      if (t && t.title) label = String(t.title)
    }
    return {
      ...e,
      label,
      projectName: byId.get(e.projectId) || e.projectId,
    }
  })

  return {
    generatedAt: new Date().toISOString(),
    version: 1,
    // The phone is read-only and has no trash bin, so soft-deleted projects are omitted.
    projects: all.projects.filter((p) => p.bucket !== 'deleted').map(trimProject),
    tasks: loadTasks(),
    structure: loadStructure(),
    customFields: cfg.customFields || [],
    customValues: loadAllCustomValues(),
    eventFieldLabels: cfg.eventFieldLabels || {},
    eventFieldHidden: cfg.eventFieldHidden || [],
    eventFieldDeleted: cfg.eventFieldDeleted || [],
    finance,
    notifications,
    vapidPublicKey: vapidPublicKey(),
  }
}
