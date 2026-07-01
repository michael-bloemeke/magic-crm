// The event-detail fields shown on a project (id + default label). The Settings page lets Michael
// rename these labels and hide ones he does not use; the Event details section reads the overrides.
// Defaults here MUST match the EditableField labels in ProjectDetailsBody.
export const EVENT_FIELDS: { id: string; label: string }[] = [
  { id: 'eventSummary', label: 'Description' },
  { id: 'eventDate', label: 'Event date' },
  { id: 'arrivalTime', label: 'Arrival time' },
  { id: 'eventStartTime', label: 'Event start' },
  { id: 'showStartTime', label: 'Show start' },
  { id: 'totalFee', label: 'Quote' },
  { id: 'numberOfGuests', label: 'Guest Count' },
  { id: 'ageOfGuests', label: 'Guest ages' },
  { id: 'eventLocation', label: 'Location' },
  { id: 'venueType', label: 'Venue type' },
  { id: 'indoorsOrOutdoors', label: 'Indoors / Outdoors' },
  { id: 'performanceStyle', label: 'Performance' },
  { id: 'av', label: 'AV' },
  { id: 'vips', label: 'VIPs' },
  { id: 'bookingSource', label: 'Booking source' },
]

// Fields a questionnaire answer can auto-fill: the event fields plus the day-of contact details.
export const MAPPABLE_FIELDS: { id: string; label: string }[] = [
  ...EVENT_FIELDS,
  { id: 'contactNames', label: 'Contact name' },
  { id: 'contactPhones', label: 'Contact phone' },
  { id: 'contactEmails', label: 'Contact email' },
]

// Built-in fields that other features read by key (contracts, email/contract templates, the
// HoneyBook inquiry import). These can be renamed or hidden but NOT deleted, so those features
// never silently lose a value. The remaining built-ins (Description, AV, VIPs, Booking source) are
// display-only and may be deleted from Settings. Custom fields are always deletable.
export const ESSENTIAL_FIELD_IDS = new Set<string>([
  'eventDate',
  'eventStartTime',
  'showStartTime',
  'totalFee',
  'numberOfGuests',
  'ageOfGuests',
  'eventLocation',
  'venueType',
  'indoorsOrOutdoors',
  'performanceStyle',
])

// A user-defined custom event field (definition; its per-project value lives server-side).
export type CustomField = { id: string; label: string }
export const makeCustomFieldId = () => 'custom_' + Math.random().toString(36).slice(2, 9)
