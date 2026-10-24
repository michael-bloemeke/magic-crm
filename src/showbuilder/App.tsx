import { useState } from 'react'
import { HomeScreen } from './HomeScreen'
import { ShowCanvas } from './ShowCanvas'
import { TricksLibrary } from './tricks/TricksLibrary'
import { TricksProvider } from './tricks/TricksContext'
import { MusicProvider } from './music/MusicContext'
import { MusicLibrary } from './music/MusicLibrary'
import { OthersProvider } from './others/OthersContext'
import { OtherLibrary } from './others/OtherLibrary'
import 'reactflow/dist/style.css'
import './styles.css'

type View =
  | { name: 'home' }
  | { name: 'show'; showId: string }
  | { name: 'tricks' }
  | { name: 'music' }
  | { name: 'others' }

// THE SHOW BUILDER PAGE (2026-10-24). This is the standalone Show Builder app's own App.tsx, moved
// into the CRM as a page: same home screen, canvas, libraries and sidebars. The only changes are the
// name, the .sbx wrapper that scopes its stylesheet, and its data, which now lives in Supabase (see
// sbApi.ts) so the phone can open the same shows.
export function ShowBuilderApp() {
  const [view, setView] = useState<View>({ name: 'home' })

  return (
    <div className="sbx">
    <TricksProvider>
      <MusicProvider>
        <OthersProvider>
          {view.name === 'home' && (
            <HomeScreen
              onOpenShow={(showId) => setView({ name: 'show', showId })}
              onOpenTricks={() => setView({ name: 'tricks' })}
              onOpenMusic={() => setView({ name: 'music' })}
              onOpenOthers={() => setView({ name: 'others' })}
            />
          )}
          {view.name === 'show' && (
            <ShowCanvas
              showId={view.showId}
              onBack={() => setView({ name: 'home' })}
            />
          )}
          {view.name === 'tricks' && (
            <TricksLibrary onBack={() => setView({ name: 'home' })} />
          )}
          {view.name === 'music' && (
            <MusicLibrary onBack={() => setView({ name: 'home' })} />
          )}
          {view.name === 'others' && (
            <OtherLibrary onBack={() => setView({ name: 'home' })} />
          )}
        </OthersProvider>
      </MusicProvider>
    </TricksProvider>
    </div>
  )
}
