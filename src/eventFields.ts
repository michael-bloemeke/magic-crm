// The event-detail fields shown on a project (id + default label). The Settings page lets Michael
// rename these labels and hide ones he does not use; the Event details section reads the overrides.
// Defaults here MUST match the EditableField labels in ProjectDetailsBody.
export const EVENT_FIELDS: { id: string; label: string }[] = [
  { id: 'eventSummary', label: 'Description' },
  { id: 'eventDate', label: 'Event date' },
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
