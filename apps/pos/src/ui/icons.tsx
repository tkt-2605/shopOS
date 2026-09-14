import type { ReactNode } from 'react'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const ICONS: Record<string, ReactNode> = {
  dashboard: <Icon><path d="M3 12l9-8 9 8" /><path d="M5 10v10h14V10" /></Icon>,
  billing: <Icon><path d="M4 3h16v18l-3-2-3 2-3-2-3 2z" /><path d="M8 9h8M8 13h5" /></Icon>,
  bills: <Icon><path d="M5 4h14v16H5z" /><path d="M9 9h6M9 13h6" /></Icon>,
  inventory: <Icon><path d="M4 7l8-4 8 4v10l-8 4-8-4z" /><path d="M4 7l8 4 8-4M12 11v10" /></Icon>,
  stock_in: <Icon><path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 19h16" /></Icon>,
  suppliers: <Icon><path d="M3 9l2-5h14l2 5" /><path d="M4 9h16v10H4z" /><path d="M9 13h6" /></Icon>,
  customers: <Icon><circle cx="12" cy="8" r="3.4" /><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6" /></Icon>,
  credit: <Icon><path d="M3 7h18v10H3z" /><path d="M3 11h18" /></Icon>,
  cash_counter: <Icon><path d="M4 6h16v12H4z" /><circle cx="12" cy="12" r="2.4" /></Icon>,
  pricing: <Icon><path d="M12 3l9 9-9 9-9-9z" /><circle cx="12" cy="12" r="2" /></Icon>,
  reports: <Icon><path d="M5 20V10M12 20V4M19 20v-7" /></Icon>,
  formats: <Icon><path d="M5 3h14v18H5z" /><path d="M8 7h8M8 11h8M8 15h4" /></Icon>,
  orders: <Icon><path d="M6 3h12v18l-6-3-6 3z" /><path d="M9 8h6" /></Icon>,
  purchase_orders: <Icon><path d="M6 3h12v18l-6-3-6 3z" /><path d="M12 8v6M9 11h6" /></Icon>,
  stock_count: <Icon><path d="M4 5h16v14H4z" /><path d="M8 9l2 2 4-4" /><path d="M8 15h8" /></Icon>,
  reorder: <Icon><path d="M20 8a8 8 0 1 0-1.5 7" /><path d="M20 3v5h-5" /></Icon>,
  registers: <Icon><path d="M4 8h16v11H4z" /><path d="M8 8V5h8v3" /><path d="M10 13h4" /></Icon>,
  audit: <Icon><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></Icon>,
  users: <Icon><circle cx="9" cy="8" r="3.2" /><path d="M2 20c0-3.4 3-5.2 7-5.2s7 1.8 7 5.2" /><path d="M17 8h5M19.5 5.5v5" /></Icon>,
  roles: <Icon><path d="M12 3l8 3v6c0 4.4-3.2 7.8-8 9-4.8-1.2-8-4.6-8-9V6z" /><path d="M9 12l2 2 4-4" /></Icon>,
  settings: <Icon><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" /></Icon>,
}

/**
 * The mark in the corner of the sidebar: a ledger with a notch in its foot.
 *
 * The same drawing lives at `src-tauri/icons/icon.svg`, which is what the
 * installer, the taskbar and the favicon are generated from — filled rather
 * than stroked there, because an outline this thin disappears at 16px. Nothing
 * in the build checks that the two agree, so changing one means changing both.
 */
export function BrandMark() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 3h16v18l-3-2-3 2-3-2-3 2z" />
      <path d="M8 8h8M8 12h8" />
    </svg>
  )
}
