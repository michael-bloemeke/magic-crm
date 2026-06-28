// Read-only snapshot of the CRM for the phone app. Bundles everything the mobile view needs into a
// single JSON blob: projects (curated fields), tasks, the pipeline structure (stage names), custom
// field definitions + values, a finance summary, and recent notifications. Generated on the Mac and
// synced to the cloud so the phone reads a static, read-only copy that works even when the Mac is
// asleep. No write paths here; this only ever reads.

import { loadAll, loadTasks, loadStructure } from './crm-data-core.mjs'
import { loadConfig, computeFinance } from './crm-finance.mjs'
import { loadAllCustomValues } from './crm-custom-fields.mjs'
import { loadUnseenNotifications } from './crm-notifications.mjs'

const NOTIF_LABELS = {
  'invoice-paid': 'Invoice paid',
  'contract-viewed': 'Contract viewed',
  'contract-signed': 'Contract signed',
  'task-due': 'Task due',
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

  const notifications = loadUnseenNotifications().map((e) => ({
    ...e,
    label: NOTIF_LABELS[e.kind] || e.kind,
    projectName: byId.get(e.projectId) || e.projectId,
  }))

  return {
    generatedAt: new Date().toISOString(),
    version: 1,
    projects: all.projects.map(trimProject),
    tasks: loadTasks(),
    structure: loadStructure(),
    customFields: cfg.customFields || [],
    customValues: loadAllCustomValues(),
    eventFieldLabels: cfg.eventFieldLabels || {},
    eventFieldHidden: cfg.eventFieldHidden || [],
    eventFieldDeleted: cfg.eventFieldDeleted || [],
    finance,
    notifications,
  }
}
