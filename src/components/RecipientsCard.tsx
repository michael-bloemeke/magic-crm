import { useEffect, useState } from 'react'
import { type Project } from '../pipeline'
import { type Contact, type DocRecipient } from '../api'

// The Booking-section "Recipients" card. Sets who the project's documents go to: the contract
// SIGNER and the invoice BILL-TO, plus an editable billing name so an invoice can be addressed to a
// company. Defaults to the project's first contact when unset. The Contract and Invoice cards read
// these choices. `contacts` is the project's linked contacts; changes save per project via onChange.

type Props = {
  project: Project
  contacts: Contact[]
  recipient: DocRecipient | null
  onChange: (patch: Partial<DocRecipient>) => void
}

function contactLabel(c: Contact) {
  const email = c.emails?.[0]
  return email ? `${c.name} (${email})` : c.name
}

const fieldCls =
  'mt-1 w-full rounded-lg border border-line bg-surface-2/40 px-2.5 py-1.5 text-[12px] text-parchment outline-none focus:border-brass-dim'

export function RecipientsCard({ project, contacts, recipient, onChange }: Props) {
  const signerId = recipient?.signerId || contacts[0]?.id || ''
  const billToId = recipient?.billToId || contacts[0]?.id || ''
  const billToContact = contacts.find((c) => c.id === billToId) || null
  const namePlaceholder = billToContact?.name || project.client

  // Local state for the free-text billing name so it saves on blur, not every keystroke.
  const [billName, setBillName] = useState(recipient?.billToName || '')
  useEffect(() => {
    setBillName(recipient?.billToName || '')
  }, [recipient?.billToName, project.id])

  if (contacts.length === 0) {
    return (
      <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
        <p className="text-[13px] font-medium text-parchment">Recipients</p>
        <p className="mt-1 text-[11.5px] leading-relaxed text-faint">
          Add a contact to this project to choose who signs the contract and who the invoice is billed to.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2/30 px-4 py-3">
      <p className="text-[13px] font-medium text-parchment">Recipients</p>
      <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
        Who the contract and invoice go to. The person you spoke to is not always the one who signs or pays.
      </p>

      <div className="mt-2.5 space-y-2.5">
        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Contract signer</span>
          <select value={signerId} onChange={(e) => onChange({ signerId: e.target.value })} className={fieldCls}>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {contactLabel(c)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Invoice bill to</span>
          <select value={billToId} onChange={(e) => onChange({ billToId: e.target.value })} className={fieldCls}>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {contactLabel(c)}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Billing name</span>
          <input
            value={billName}
            onChange={(e) => setBillName(e.target.value)}
            onBlur={() => {
              if ((recipient?.billToName || '') !== billName) onChange({ billToName: billName })
            }}
            placeholder={namePlaceholder}
            className={fieldCls}
          />
          <span className="mt-1 block text-[10.5px] leading-relaxed text-faint">
            How the invoice is addressed. Leave blank to use the bill-to contact's name, or set a company name to bill a
            business.
          </span>
        </label>
      </div>
    </div>
  )
}
