// Bridge exposed by electron/preload.cjs when the CRM runs inside the packaged Mac app.
// Absent in a plain browser tab, so always call through optional chaining.
export {}

declare global {
  interface Window {
    crm?: {
      isElectron?: boolean
      setBadge?: (count: number) => void
      // A link from outside the app, e.g. the "Open in Bloom CRM" link in a calendar event. Returns a
      // function that stops listening.
      onOpenLink?: (cb: (link: { what: string; id: string; sub: string }) => void) => () => void
    }
  }
}
