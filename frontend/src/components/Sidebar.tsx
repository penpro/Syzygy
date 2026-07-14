import { useStore } from '../store'
import { DownloadIndicator } from './DownloadIndicator'
import { TipRotator } from './TipRotator'
import { useConfirm } from './ConfirmDialog'
import { UI_ICONS } from '../uiIcons'
import { cx, timeAgo } from '../util'

export function Sidebar({
  collapsed,
  onOpenSettings,
  onOpenTutorial,
  onOpenWelcome,
}: {
  collapsed?: boolean
  onOpenSettings: () => void
  onOpenTutorial: () => void
  onOpenWelcome: () => void
}) {
  const confirm = useConfirm()
  const asks = useStore((s) => s.asks)
  const activeAskId = useStore((s) => s.activeAskId)
  const createAsk = useStore((s) => s.createAsk)
  const openAsk = useStore((s) => s.openAsk)
  const deleteAsk = useStore((s) => s.deleteAsk)

  const sortedAsks = [...asks].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside className={cx('sidebar', collapsed && 'is-docked')}>
      <div className="side-section grow">
        <div className="side-head">
          <span>Asks</span>
          <button className="icon-btn" title="New ask" onClick={() => createAsk()}>
            ＋
          </button>
        </div>
        <div className="chat-list">
          {sortedAsks.length === 0 && <div className="muted sm pad">No asks yet.</div>}
          {sortedAsks.map((a) => (
            <div key={a.id} className={cx('chat-row', a.id === activeAskId && 'active')} onClick={() => openAsk(a.id)}>
              <div className="msg-avatar sm" style={{ background: '#7c5cff' }}>
                🪄
              </div>
              <div className="chat-row-main">
                <div className="chat-row-title">{a.title?.trim() ? a.title.trim().slice(0, 44) : a.messages?.[0]?.content?.trim().slice(0, 44) || 'New ask'}</div>
                <div className="muted xs">{timeAgo(a.updatedAt)}</div>
              </div>
              <button
                className="icon-btn sm row-action"
                title="Delete"
                onClick={async (e) => {
                  e.stopPropagation()
                  if (await confirm({ title: 'Delete thread?', message: 'This Ask thread will be permanently deleted.', confirmLabel: 'Delete' }))
                    deleteAsk(a.id)
                }}
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      </div>

      <TipRotator />

      <div className="side-foot">
        <DownloadIndicator />
        <div className="foot-row">
          <button className="foot-icon" title="Quick tour — replay the feature tour" onClick={onOpenWelcome}>
            <img src={UI_ICONS.how} alt="" aria-hidden="true" />
            <span>Tour</span>
          </button>
          <button className="foot-icon" title="How it works — the architecture, in plain terms" onClick={onOpenTutorial}>
            <img src={UI_ICONS.how} alt="" aria-hidden="true" />
            <span>How</span>
          </button>
          <button className="foot-icon" title="Settings" onClick={onOpenSettings}>
            <img src={UI_ICONS.settings} alt="" aria-hidden="true" />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </aside>
  )
}
