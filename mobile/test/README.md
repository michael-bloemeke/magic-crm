# Phone UI tests

Runs the REAL `mobile/app.js` inside jsdom against a stubbed data layer, with the REAL
`mobile/index.html` supplying the DOM and the CSS class names. A render that targets an element
which does not exist fails here the same way it would on the phone.

```
/Users/michaelbloemeke/.local/node22/bin/node test/run.mjs
```

(Node 22 because jsdom needs it; the system Node is 20.12.)

- `harness.mjs` builds a runnable copy of app.js: the `./supabase-data.js` and `./config.js` imports
  are rewritten to pull from `stub.mjs`, the `DOMContentLoaded` bootstrap is removed, and a
  `__app` export is appended so the tests can drive the render functions and set module state.
- `stub.mjs` is the fake data layer. Every read returns fixtures; every write is recorded in
  `CALLS` and resolves. Nothing touches the network or the database.
- `run.mjs` is the suite.

## What it is for

The things that are expensive to get wrong and invisible in a screenshot:

- **The view-count invariant.** Every proposal link opened from inside the CRM carries `preview=1`,
  non-live ones also carry the admin key, the key is never rendered as text, and Copy hands over
  the clean URL on every card. Michael's view counts are real data about whether clients read his
  proposals; his own checking must never appear in them.
- **Mail semantics.** Opening a thread does not mark it read; replying does. Send disables itself
  so a double tap cannot send twice. The per-project query is parenthesised so Gmail's OR binds to
  every address rather than only the last.
- **Blanks are shown, not hidden.** A missing date, address or time is called out rather than
  quietly omitted, because on the morning of a gig the field you did not fill is the one you most
  need to see.
- **Real-data shapes.** Time fields that hold prose instead of a clock time; a venue type that
  already contains the indoors/outdoors answer. Both were found by running the built app against
  the live database, and both now have regression tests here.

## What it is NOT for

It does not prove anything about the native shell, about RLS, or about the Edge Functions. Those
are checked by running the built app in the simulator and by the round-trip scripts that talk to
the real database.
