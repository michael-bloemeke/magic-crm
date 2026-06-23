// Bridge exposed by electron/preload.cjs when the CRM runs inside the packaged Mac app.
// Absent in a plain browser tab, so always call through optional chaining.
export {}

declare global {
  interface Window {
    crm?: {
      isElectron?: boolean
      setBadge?: (count: number) => void
    }
  }
}
