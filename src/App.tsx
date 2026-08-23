import { StoreProvider, useStore } from './lib/store'
import { Sidebar } from './components/Sidebar'
import { Conversation } from './components/Conversation'
import { DetailsPanel } from './components/DetailsPanel'
import './styles/app.css'
import './styles/conversation.css'

function Frame() {
  const { active, detailsOpen } = useStore()
  return (
    <div className="app-frame">
      <Sidebar />
      <main className="center">
        {active ? (
          <Conversation key={active.key} tab={active} />
        ) : (
          <EmptyCenter />
        )}
      </main>
      <div className="details" hidden={!detailsOpen} style={{ width: detailsOpen ? 300 : 0 }}>
        {detailsOpen && <DetailsPanel />}
      </div>
    </div>
  )
}

function EmptyCenter() {
  return (
    <>
      <div className="header">
        <div className="header__title">pi workbench</div>
      </div>
      <div className="conversation">
        <div className="hero">
          <div className="hero__mark">π</div>
          <div className="hero__title">Start a session</div>
          <div className="hero__subtitle">
            Pick a project from the sidebar or resume a recent session to begin working with your
            local pi coding agent.
          </div>
        </div>
      </div>
    </>
  )
}

export function App() {
  return (
    <StoreProvider>
      <Frame />
    </StoreProvider>
  )
}
