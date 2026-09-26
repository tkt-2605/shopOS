import { MAX_TABS, type BillTabs, type Cart } from '../../core/useBillTabs'
import { Alert } from '../../ui/components'

/** The bills open at once, one tab each, and the notice a tab raises. */
export function TabStrip({ tabs, activeId, onClose }: {
  tabs: BillTabs
  activeId: string
  onClose: (cart: Cart) => void
}) {
  return (
    <>
    <div className="tab-strip">
      {tabs.tabs.map((cart, i) => (
        <div key={cart.tabId} className="tab" aria-current={cart.tabId === activeId}>
          <button className="pick" onClick={() => tabs.select(cart.tabId)}>
            <span className="n">{i + 1}</span>
            <span className="who">
              {cart.customer?.name ?? (cart.lines.length === 0 ? 'New' : 'Walk-in')}
            </span>
          </button>
          {tabs.tabs.length > 1 && (
            <button className="shut" aria-label="Cancel this bill" onClick={() => onClose(cart)}>
              ✕
            </button>
          )}
        </div>
      ))}
      {tabs.tabs.length < MAX_TABS && (
        <button className="tab-add" onClick={tabs.open} title="Another bill (Ctrl+T)">+</button>
      )}
    </div>

    {tabs.notice && (
      <div style={{ padding: '0 0 10px' }}>
        <Alert kind="ok">
          {tabs.notice}
          <button
            className="btn ghost sm"
            style={{ marginLeft: 10 }}
            onClick={tabs.dismissNotice}
          >Dismiss</button>
        </Alert>
      </div>
    )}
    </>
  )
}
