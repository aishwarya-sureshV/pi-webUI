import { useStore } from '../lib/store'

export function DetailsPanel() {
  const { active } = useStore()
  const state = active?.timeline.state
  const items = active?.timeline.items ?? []
  const tools = items.filter((i) => i.kind === 'tool')
  const user = items.filter((i) => i.kind === 'user')

  return (
    <>
      <div className="details__head">Session</div>
      <div className="details__body">
        <div className="details__row"><span>project</span><span title={active?.cwd}>{active?.cwd.replace(/^\/Users\/[^/]+/, '~')}</span></div>
        <div className="details__row"><span>backend</span><span>{active?.backend === 'claude' ? 'Claude Code' : 'pi'}</span></div>
        <div className="details__row"><span>model</span><span>{state?.model?.name ?? state?.model?.id ?? '—'}</span></div>
        <div className="details__row"><span>thinking</span><span>{state?.thinkingLevel ?? 'off'}</span></div>
        <div className="details__row"><span>messages</span><span>{state?.messageCount ?? user.length}</span></div>
        <div className="details__row"><span>tool calls</span><span>{tools.length}</span></div>
        <div className="details__row details__row--path"><span>session file</span><code title={state?.sessionFile}>{state?.sessionFile ?? '—'}</code></div>
      </div>
    </>
  )
}
