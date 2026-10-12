// BARK: reads the email Michael's Zapier Zap sends him for every lead he PURCHASES on Bark.
// Set up 2026-10-12. Bark has no new-lead email worth reading (its "has been sent your details"
// email masks the phone and email), so the Zap "New Purchased Bark" -> Gmail "Send Email" mails
// michael@michaelbloemeke.com to itself:
//   Subject: "Bark purchased lead: <buyer name>"
//   Body:    Zapier's "Step Output", which is the whole Bark record as JSON:
//            { bark: { id, buyer: { name, short_name, email, telephone }, location: { name, ... },
//                      display: { text: "Question\nAnswer\n\nQuestion\nAnswer..." }, ... }, ... }
// Only purchased leads reach this, by design (Michael: only the Bark leads he responds to belong
// in the CRM). Kept in its own file so it can be checked with plain node before deploying.

export interface BarkLead {
  barkId: string;
  fullName: string;
  firstName: string;
  email: string;
  phone: string;
  city: string; // "Jacksonville, NC" (postcode dropped)
  eventType: string;
  eventDate: string; // YYYY-MM-DD, or "" when the buyer gave no date
  time: string; // "Evening, 3 hours"
  ages: string;
  guests: string;
  qa: Array<[string, string]>; // every question and answer, duplicates removed
  link: string; // https://www.bark.com/sellers/my-barks/?prx=<id>
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

// "Monday December 21st, 2026" / "December 21, 2026" / "21st December 2026" -> "2026-12-21".
export function barkDate(s: string): string {
  const t = String(s || "");
  let m = t.match(/([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  let mon = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  let day = m ? +m[2] : 0, yr = m ? +m[3] : 0;
  if (mon < 0) {
    m = t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})/);
    mon = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
    day = m ? +m[1] : 0; yr = m ? +m[3] : 0;
  }
  if (mon < 0 || day < 1 || day > 31) return "";
  return `${yr}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Bark's "display.text": blocks separated by a blank line, question on the first line, answer after.
function questions(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const block of String(text || "").replace(/\r\n/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const q = lines[0].replace(/:$/, "");
    const a = lines.slice(1).join(" ");
    // Bark repeats "Additional details" as "Additional Details:" with the same text.
    const key = q.toLowerCase() + "|" + a.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([q, a]);
  }
  return out;
}

function pick(qa: Array<[string, string]>, re: RegExp): string {
  const hit = qa.find(([q]) => re.test(q));
  return hit ? hit[1] : "";
}

// The email body is the JSON (sometimes wrapped as "Object.to_json(...)" in Zapier's preview), so
// take everything from the first "{" to the last "}".
export function parseBark(subject: string, body: string): BarkLead | null {
  if (!/Bark purchased lead/i.test(subject)) return null;
  const a = body.indexOf("{"), b = body.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  // deno-lint-ignore no-explicit-any
  let rec: any;
  try { rec = JSON.parse(body.slice(a, b + 1)); } catch { return null; }
  const bark = rec?.bark ?? rec;
  const buyer = bark?.buyer ?? {};
  const id = String(bark?.id ?? "").trim();
  const fullName = String(buyer.name ?? "").trim();
  if (!id || !fullName) return null;

  const qa = questions(bark?.display?.text ?? "");
  const when = pick(qa, /what date|event date|date of (the )?event/i);
  const timeOfDay = pick(qa, /what time/i);
  const length = pick(qa, /how long/i);
  const loc = String(bark?.location?.name ?? "").replace(/,\s*\d{5}(-\d{4})?\s*$/, "").trim();

  return {
    barkId: id,
    fullName: fullName.slice(0, 120),
    firstName: String(buyer.short_name ?? "").trim() || fullName.split(/\s+/)[0],
    email: String(buyer.email ?? "").trim(),
    phone: String(buyer.telephone ?? "").trim(),
    city: loc.slice(0, 120),
    eventType: pick(qa, /type of event|kind of event|what event/i).slice(0, 80),
    eventDate: barkDate(when),
    time: [timeOfDay, length].filter(Boolean).join(", ").slice(0, 80),
    ages: pick(qa, /\bage/i).slice(0, 80),
    guests: pick(qa, /how many (guests|people)|number of (guests|people)|guest count/i).slice(0, 80),
    qa,
    link: `https://www.bark.com/sellers/my-barks/?prx=${encodeURIComponent(id)}`,
  };
}
