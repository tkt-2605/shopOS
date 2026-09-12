"""Writes the .dc.html artboards for the ShopOS design canvas.

Tokens, spacing, radii and type sizes are lifted verbatim from
apps/pos/src/ui/styles.css; the nav groups and titles from apps/pos/src/App.tsx;
the icon paths from apps/pos/src/ui/icons.tsx. Nothing here is invented.
"""
import io, os

TOKENS = """
  :root, .t-daylight {
    --ground: oklch(0.982 0.002 250); --surface: #fff;
    --surface-2: oklch(0.976 0.002 250); --sidebar: oklch(0.968 0.003 250);
    --sidebar-ink: oklch(0.45 0.012 250); --sidebar-active-bg: oklch(0.925 0.028 255);
    --sidebar-active-ink: oklch(0.4 0.13 258);
    --ink: oklch(0.28 0.014 252); --ink-2: oklch(0.55 0.012 250); --ink-3: oklch(0.66 0.012 250);
    --rule: oklch(0.925 0.004 250); --rule-soft: oklch(0.958 0.003 250);
    --rule-strong: oklch(0.9 0.005 250);
    --accent: oklch(0.55 0.15 255); --accent-hover: oklch(0.48 0.15 255);
    --accent-soft: oklch(0.945 0.022 255); --accent-ink: oklch(0.4 0.13 258);
    --ok: oklch(0.42 0.1 160); --ok-soft: oklch(0.945 0.03 160);
    --warn: oklch(0.5 0.13 60); --warn-soft: oklch(0.955 0.03 75);
    --danger: oklch(0.5 0.14 28); --danger-soft: oklch(0.958 0.022 28);
    --radius: 0; --radius-sm: 0;
    --shadow: 0 1px 2px rgb(20 32 31 / 6%), 0 10px 28px -20px rgb(20 32 31 / 28%);
  }
  .t-khata {
    --ground: oklch(0.972 0.012 85); --surface: oklch(0.99 0.008 85);
    --surface-2: oklch(0.958 0.014 84); --sidebar: oklch(0.945 0.016 82);
    --sidebar-ink: oklch(0.42 0.02 60); --sidebar-active-bg: oklch(0.9 0.04 40);
    --sidebar-active-ink: oklch(0.42 0.16 28);
    --ink: oklch(0.26 0.02 60); --ink-2: oklch(0.48 0.02 60); --ink-3: oklch(0.62 0.02 60);
    --rule: oklch(0.88 0.02 80); --rule-soft: oklch(0.92 0.016 82);
    --rule-strong: oklch(0.8 0.024 78);
    --accent: oklch(0.5 0.16 28); --accent-hover: oklch(0.42 0.16 28);
    --accent-soft: oklch(0.94 0.03 40); --accent-ink: oklch(0.42 0.16 28);
    --ok: oklch(0.42 0.09 150); --ok-soft: oklch(0.94 0.03 150);
    --warn: oklch(0.48 0.12 60); --warn-soft: oklch(0.95 0.035 75);
    --danger: oklch(0.46 0.16 28); --danger-soft: oklch(0.94 0.035 30);
    --radius: 0; --radius-sm: 0;
    --shadow: 0 1px 2px rgb(60 40 20 / 10%), 0 10px 28px -20px rgb(60 40 20 / 30%);
  }
  .t-night {
    --ground: oklch(0.17 0.014 255); --surface: oklch(0.22 0.014 255);
    --surface-2: oklch(0.25 0.014 255); --sidebar: oklch(0.14 0.014 255);
    --sidebar-ink: oklch(0.72 0.012 250); --sidebar-active-bg: oklch(0.3 0.05 255);
    --sidebar-active-ink: oklch(0.92 0.02 255);
    --ink: oklch(0.93 0.006 250); --ink-2: oklch(0.72 0.012 250); --ink-3: oklch(0.58 0.012 250);
    --rule: oklch(0.3 0.014 255); --rule-soft: oklch(0.26 0.014 255);
    --rule-strong: oklch(0.36 0.014 255);
    --accent: oklch(0.68 0.14 255); --accent-hover: oklch(0.75 0.14 255);
    --accent-soft: oklch(0.3 0.05 255); --accent-ink: oklch(0.82 0.1 255);
    --ok: oklch(0.78 0.12 160); --ok-soft: oklch(0.28 0.05 160);
    --warn: oklch(0.8 0.12 75); --warn-soft: oklch(0.3 0.05 70);
    --danger: oklch(0.74 0.13 28); --danger-soft: oklch(0.3 0.06 28);
    --radius: 0; --radius-sm: 0;
    --shadow: 0 1px 2px rgb(0 0 0 / 40%), 0 10px 28px -20px rgb(0 0 0 / 70%);
  }
  .d-compact { --row-py: 10px; --cell-px: 14px; }
  .d-comfortable { --row-py: 14px; --cell-px: 16px; }
  .d-dense { --row-py: 7px; --cell-px: 12px; }
"""

CHROME = """
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
         font-size: 13.5px; color: var(--ink); background: var(--ground);
         -webkit-font-smoothing: antialiased; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { color: var(--accent-hover); }
  .num { font-family: "Cascadia Mono", Consolas, ui-monospace, monospace;
         font-variant-numeric: tabular-nums; }

  .shell { display: grid; grid-template-columns: 196px minmax(0, 1fr); height: 100%; }
  .sidebar { display: flex; flex-direction: column; background: var(--sidebar);
             border-right: 1px solid var(--rule); }
  .brand { display: flex; align-items: center; gap: 9px; padding: 14px 14px 12px; }
  .brand-mark { display: grid; place-items: center; width: 28px; height: 28px; flex-shrink: 0;
                background: var(--accent); border-radius: var(--radius-sm); color: #fff; }
  .brand-name { font-size: 13px; font-weight: 600; letter-spacing: -0.01em; }
  .brand-sub { font-size: 11px; color: var(--ink-3); }
  .nav { flex: 1; display: flex; flex-direction: column; gap: 1px; padding: 6px 8px; }
  .nav-group { padding: 12px 9px 4px; font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
               text-transform: uppercase; color: var(--ink-3); }
  .nav-group.first { padding-top: 2px; }
  .nav .item { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 9px;
               border-radius: var(--radius-sm); color: var(--sidebar-ink); font-size: 13px; }
  .nav .item.on { background: var(--sidebar-active-bg); color: var(--sidebar-active-ink);
                  font-weight: 600; }
  .sidebar-foot { display: flex; align-items: center; gap: 9px; padding: 12px 14px;
                  border-top: 1px solid var(--rule); }
  .avatar { display: grid; place-items: center; width: 26px; height: 26px; flex-shrink: 0;
            background: var(--accent-soft); border-radius: 0; font-size: 10.5px;
            font-weight: 600; color: var(--accent-ink); }
  .who { font-size: 12px; font-weight: 500; }
  .role { font-size: 11px; color: var(--ink-3); }
  .link { color: var(--accent); font-size: 11.5px; }

  .main { display: flex; flex-direction: column; overflow: hidden; min-width: 0; }
  .topbar { display: flex; align-items: center; gap: 10px; height: 46px; padding: 0 20px;
            flex-shrink: 0; background: var(--surface); border-bottom: 1px solid var(--rule); }
  .topbar h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .meta { font-size: 12px; color: var(--ink-3); }
  .content { flex: 1 1 0; overflow: hidden; padding: 16px 18px; }
  .content.flush { padding: 0; }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
         padding: 7px 14px; white-space: nowrap; background: var(--surface); color: var(--ink);
         border: 1px solid var(--rule-strong); border-radius: var(--radius-sm); font-size: 13px; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn.ghost { background: none; border-color: transparent; }
  .btn.sm { padding: 4px 9px; font-size: 12.5px; }
  .btn.dim { opacity: 0.45; }
  .input, .select { width: 100%; padding: 7px 11px; background: var(--surface); color: var(--ink);
            border: 1px solid var(--rule-strong); border-radius: var(--radius-sm); }
  .field { display: flex; flex-direction: column; gap: 5px; }
  .field label { font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .field .hint { font-size: 11.5px; color: var(--ink-3); }

  .card { background: var(--surface); border: 1px solid var(--rule);
          border-radius: var(--radius); overflow: hidden; }
  .card-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px;
               border-bottom: 1px solid var(--rule-soft); }
  .card-head h2 { margin: 0; font-size: 13.5px; font-weight: 600; }
  .card-body { padding: 15px 16px; }
  .spacer { flex: 1; }

  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: var(--row-py) var(--cell-px);
           border-bottom: 1px solid var(--rule-soft); }
  th { padding-top: 9px; padding-bottom: 9px; background: var(--surface-2);
       border-bottom: 1px solid var(--rule); font-size: 10.5px; font-weight: 600;
       letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-3); }
  td.r, th.r { text-align: right; }
  tbody tr:last-child td { border-bottom: 0; }

  .badge { display: inline-block; padding: 2px 8px; font-size: 10.5px;
           font-weight: 600; }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.warn { background: var(--warn-soft); color: var(--warn); }
  .badge.bad { background: var(--danger-soft); color: var(--danger); }
  .badge.mute { background: var(--surface-2); color: var(--ink-3); }
  .alert { padding: 10px 13px; font-size: 13px; background: var(--danger-soft); color: var(--ink);
           border-left: 3px solid var(--danger); border-radius: var(--radius-sm); }
  .alert.warn { background: var(--warn-soft); border-left-color: var(--warn); }
  .alert.ok { background: var(--ok-soft); border-left-color: var(--ok); }

  .stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
  .stat { padding: 12px 15px; background: var(--surface); border: 1px solid var(--rule);
          border-radius: var(--radius); }
  .stat .label { font-size: 11.5px; color: var(--ink-3); }
  .stat .value { margin-top: 3px; font-size: 22px; font-weight: 500; letter-spacing: -0.02em; }
  .stat .sub { margin-top: 2px; font-size: 12px; color: var(--ink-3); }

  .segment { display: inline-flex; border: 1px solid var(--rule-strong);
             border-radius: var(--radius-sm); overflow: hidden; }
  .segment .seg { padding: 5px 13px; border-right: 1px solid var(--rule);
                  background: var(--surface); color: var(--ink-2); font-size: 12.5px; }
  .segment .seg:last-child { border-right: 0; }
  .segment .seg.on { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
  .bar { height: 5px; background: var(--accent); opacity: 0.7; }
"""

BILLING_CSS = """
  .billing { display: flex; height: 100%; gap: 14px; padding: 14px 16px; }
  .bill-left { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 12px; }
  .bill-right { flex: 0 0 306px; width: 306px; display: flex; flex-direction: column; gap: 12px; }
  .tab-strip { display: flex; align-items: flex-end; gap: 3px; flex-shrink: 0;
               border-bottom: 1px solid var(--rule-strong); padding: 0 2px; }
  .tab { display: flex; align-items: center; max-width: 230px; background: var(--surface-2);
         color: var(--ink-3); border: 1px solid var(--rule); border-bottom: 0;
          margin-bottom: -1px; }
  .tab.on { background: var(--surface); color: var(--ink); border-color: var(--rule-strong);
            box-shadow: inset 0 2px 0 var(--accent); }
  .tab .pick { display: flex; align-items: center; gap: 7px; min-width: 0;
               padding: 7px 4px 8px 8px; font-size: 12.5px; }
  .tab .n { display: grid; place-items: center; width: 16px; height: 16px; flex-shrink: 0;
            background: var(--rule); font-size: 10px; font-weight: 600; }
  .tab.on .n { background: var(--accent); color: #fff; }
  .tab .amt { font-variant-numeric: tabular-nums; font-weight: 500; }
  .tab .shut { padding: 7px 8px 8px 4px; color: var(--ink-3); font-size: 11px; }
  .tab-add { padding: 5px 11px 6px; margin: 0 0 2px 4px; border: 1px solid var(--rule);
             border-radius: var(--radius-sm); color: var(--ink-3); font-size: 15px; line-height: 1; }
  .scan-bar { display: flex; align-items: center; gap: 10px; padding: 8px 11px; flex-shrink: 0;
              background: var(--surface); border: 1px solid var(--rule); border-radius: var(--radius); }
  .scan-bar .ph { flex: 1; padding: 5px 2px; font-size: 15px; color: var(--ink-3); }
  .cart { flex: 1 1 0; min-height: 0; overflow: hidden; background: var(--surface);
          border: 1px solid var(--rule); border-radius: var(--radius); }
  .src { font-size: 10.5px; color: var(--ink-3); }
  .qty-input { display: inline-block; width: 72px; padding: 4px 8px; text-align: right;
               background: var(--surface); border: 1px solid var(--rule-strong); }
  .totals { padding: 14px 15px; background: var(--surface); border: 1px solid var(--rule);
            border-radius: var(--radius); }
  .total-line { display: flex; justify-content: space-between; align-items: center;
                padding: 3px 0; font-size: 12.5px; }
  .total-line > span:first-child { color: var(--ink-2); }
  .total-line.grand { align-items: baseline; margin-top: 10px; padding-top: 11px;
                      border-top: 1px solid var(--rule-strong); }
  .total-line.grand > span:first-child { color: var(--ink); font-size: 13px; font-weight: 600; }
  .total-line.grand .amount { font-size: 29px; font-weight: 500; letter-spacing: -0.02em; }
  .fkeys { display: flex; gap: 7px; flex-shrink: 0; }
  .pay-btn { display: flex; align-items: center; justify-content: center; gap: 9px; height: 50px;
             flex-shrink: 0; background: var(--accent); color: #fff; border-radius: var(--radius);
             font-size: 15.5px; font-weight: 600; }
  .pay-btn .k { font-size: 10.5px; opacity: 0.75; }
"""

ICONS = {
    'dashboard': '<path d="M3 12l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    'billing': '<path d="M4 3h16v18l-3-2-3 2-3-2-3 2z"/><path d="M8 9h8M8 13h5"/>',
    'bills': '<path d="M5 4h14v16H5z"/><path d="M9 9h6M9 13h6"/>',
    'inventory': '<path d="M4 7l8-4 8 4v10l-8 4-8-4z"/><path d="M4 7l8 4 8-4M12 11v10"/>',
    'stock_in': '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M4 19h16"/>',
    'suppliers': '<path d="M3 9l2-5h14l2 5"/><path d="M4 9h16v10H4z"/><path d="M9 13h6"/>',
    'customers': '<circle cx="12" cy="8" r="3.4"/><path d="M5 20c0-3.6 3.1-5.6 7-5.6s7 2 7 5.6"/>',
    'credit': '<path d="M3 7h18v10H3z"/><path d="M3 11h18"/>',
    'cash_counter': '<path d="M4 6h16v12H4z"/><circle cx="12" cy="12" r="2.4"/>',
    'pricing': '<path d="M12 3l9 9-9 9-9-9z"/><circle cx="12" cy="12" r="2"/>',
    'reports': '<path d="M5 20V10M12 20V4M19 20v-7"/>',
    'users': '<circle cx="9" cy="8" r="3.2"/><path d="M2 20c0-3.4 3-5.2 7-5.2s7 1.8 7 5.2"/><path d="M17 8h5M19.5 5.5v5"/>',
    'roles': '<path d="M12 3l8 3v6c0 4.4-3.2 7.8-8 9-4.8-1.2-8-4.6-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    'settings': '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
}

NAV = [
    ('Sell', [('billing', 'Billing'), ('bills', 'Bills'), ('customers', 'Customers')]),
    ('Stock', [('inventory', 'Inventory'), ('stock_in', 'Stock In'), ('suppliers', 'Suppliers')]),
    ('Money', [('credit', 'Credit'), ('cash_counter', 'Cash Counter')]),
    ('Review', [('dashboard', 'Dashboard'), ('reports', 'Reports')]),
    ('Setup', [('pricing', 'Counters'), ('users', 'Staff'),
               ('roles', 'Roles &amp; Permissions'), ('settings', 'Settings')]),
]


def icon(key):
    return (f'<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">{ICONS[key]}</svg>')


def sidebar(active):
    groups = []
    for i, (label, items) in enumerate(NAV):
        first = ' first' if i == 0 else ''
        rows = ''.join(
            f'<div class="item{" on" if key == active else ""}">{icon(key)}<span>{name}</span></div>'
            for key, name in items)
        groups.append(f'<div class="nav-group{first}">{label}</div>{rows}')
    return f'''<aside class="sidebar">
  <div class="brand">
    <div class="brand-mark"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3h16v18l-3-2-3 2-3-2-3 2z"/><path d="M8 8h8M8 12h8"/></svg></div>
    <div style="min-width: 0">
      <div class="brand-name">TRT Stationery</div>
      <div class="brand-sub">Main Register</div>
    </div>
  </div>
  <nav class="nav">{''.join(groups)}</nav>
  <div class="sidebar-foot">
    <div class="avatar">AD</div>
    <div style="min-width: 0">
      <div class="who">Administrator</div>
      <div class="role">Admin</div>
      <div class="link">Sign out</div>
    </div>
  </div>
</aside>'''


def page(name, title, active, body, topbar_meta='', flush=False, extra_css=''):
    meta = f'<span class="meta">{topbar_meta}</span>' if topbar_meta else ''
    return f'''<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>{TOKENS}{CHROME}{extra_css}
  .frame {{ height: 960px; overflow: hidden; }}
  </style>
</helmet>
<div class="frame t-{{{{theme}}}} d-{{{{density}}}}" style="background: var(--ground)">
  <div class="shell">
    {sidebar(active)}
    <main class="main">
      <div class="topbar">
        <h1>{title}</h1>
        {meta}
        <div class="spacer"></div>
      </div>
      <div class="content{' flush' if flush else ''}">{body}</div>
    </main>
  </div>
</div>
</x-dc>
<script data-dc-script data-props='{{"theme":{{"editor":"enum","options":["daylight","khata","night"],"default":"daylight","section":"Theme"}},"density":{{"editor":"enum","options":["compact","comfortable","dense"],"default":"compact","section":"Theme"}},"$preview":{{"width":1520,"height":960}}}}'>
class Component extends DCLogic {{
  renderVals() {{
    return {{
      theme: this.props.theme ?? 'daylight',
      density: this.props.density ?? 'compact',
    }};
  }}
}}
</script>
</body>
</html>
'''


def row(cells):
    return '<tr>' + ''.join(cells) + '</tr>'


def td(text, cls=''):
    c = f' class="{cls}"' if cls else ''
    return f'<td{c}>{text}</td>'


def th(text, cls='', width=None):
    c = f' class="{cls}"' if cls else ''
    w = f' style="width: {width}px"' if width else ''
    return f'<th{c}{w}>{text}</th>'


out = os.path.dirname(os.path.abspath(__file__))


def write(fname, content):
    io.open(os.path.join(out, fname), 'w', encoding='utf-8', newline='\n').write(content)
    print('wrote', fname, len(content), 'bytes')

# ── Billing ────────────────────────────────────────────────────────────────
CART = [
    ('A4 Copier Paper 500 sheets', 'Product base price', 'ream', '2', '340.00', '680.00'),
    ('Ball Pen Blue', "Customer's price list", 'piece', '12', '9.00', '108.00'),
    ('Calculator 12 digit', 'Entered by cashier', 'piece', '1', '640.00', '640.00'),
]

cart_rows = ''.join(row([
    td(f'<div>{n}</div><div class="src">{s}</div>'),
    td(f'<span class="select" style="display:inline-block;width:88px;padding:5px 9px">{u}</span>'),
    td(f'<span class="qty-input num">{q}</span>', 'r'),
    td(f'<span class="qty-input num">{r}</span>', 'r'),
    td(f'<span class="num">&#8377;{a}</span>', 'r'),
    td('<span class="btn ghost sm" style="color:var(--ink-3)">&#10005;</span>'),
]) for n, s, u, q, r, a in CART)

billing_body = f'''<div class="billing">
  <div class="bill-left">
    <div class="tab-strip">
      <div class="tab on"><div class="pick"><span class="n">1</span><span class="who">Walk-in</span></div><div class="shut">&#10005;</div></div>
      <div class="tab"><div class="pick"><span class="n">2</span><span class="who">Sri Vidya School</span></div><div class="shut">&#10005;</div></div>
      <div class="tab"><div class="pick"><span class="n">3</span><span class="who">New</span></div><div class="shut">&#10005;</div></div>
      <div class="tab-add">+</div>
    </div>

    <div class="scan-bar">
      <div class="ph">Scan a barcode or type to search&#8230;</div>
    </div>

    <div class="cart">
      <table>
        <thead><tr>
          {th('Item')}{th('Unit', width=100)}{th('Qty', 'r', 96)}{th('Rate', 'r', 110)}{th('Amount', 'r', 110)}{th('', width=40)}
        </tr></thead>
        <tbody>{cart_rows}</tbody>
      </table>
    </div>
  </div>

  <div class="bill-right">
    <div class="totals">
      <div class="field">
        <label>Customer</label>
        <div class="btn" style="width:100%;justify-content:space-between">
          <span>Walk-in</span><span style="color:var(--ink-3)">Change</span>
        </div>
      </div>
    </div>

    <div class="totals">
      <div class="total-line"><span>Subtotal</span><span class="num">&#8377;1,428.00</span></div>
      <div class="total-line"><span>Discount</span><span class="qty-input num">0.00</span></div>
      <div class="total-line" style="color:var(--ink-3)"><span>Tax included</span><span class="num">&#8377;152.98</span></div>
      <div class="total-line grand"><span>Total</span><span class="num amount">&#8377;1,428.00</span></div>
    </div>

    <div class="pay-btn"><span class="k">F12</span><span>Take payment</span></div>
  </div>
</div>'''

write('Main.dc.html', page('Main', 'Billing', 'billing', billing_body,
                          topbar_meta='Scan or type, then Enter to add',
                          flush=True, extra_css=BILLING_CSS))

# ── Bills ──────────────────────────────────────────────────────────────────
BILLS = [
    ('INV/MR/26-27/00024', '12 Sept 2026', 'Walk-in', '30.00', 'Submitted', 'ok'),
    ('INV/MR/26-27/00023', '12 Sept 2026', 'Sri Vidya School', '680.00', 'Submitted', 'ok'),
    ('INV/MR/26-27/00022', '12 Sept 2026', 'Ramesh Traders', '1,240.00', 'Submitted', 'ok'),
    ('INV/MR/26-27/00021', '11 Sept 2026', 'Walk-in', '96.00', 'Cancelled', 'bad'),
    ('INV/MR/26-27/00020', '11 Sept 2026', 'Lakshmi Stores', '2,150.00', 'Submitted', 'ok'),
    ('INV/MR/26-27/00019', '11 Sept 2026', 'Walk-in', '415.00', 'Submitted', 'ok'),
    ('INV/MR/26-27/00018', '10 Sept 2026', 'Anand Kumar', '760.00', 'Submitted', 'ok'),
]
bills_rows = ''.join(row([
    td(f'<span class="num">{d}</span>'), td(dt), td(c),
    td(f'<span class="num">&#8377;{a}</span>', 'r'),
    td(f'<span class="badge {cls}">{st}</span>'),
]) for d, dt, c, a, st, cls in BILLS)

bills_body = f'''<div style="display:flex;flex-direction:column;gap:12px">
  <div style="display:flex;gap:10px;align-items:center">
    <div class="input" style="max-width:320px;color:var(--ink-3)">Search a bill number or customer</div>
    <div class="segment">
      <div class="seg on">All</div><div class="seg">Submitted</div><div class="seg">Cancelled</div>
    </div>
    <div class="spacer"></div>
    <span class="meta">7 bills</span>
  </div>

  <div class="card">
    <table>
      <thead><tr>
        {th('Bill')}{th('Date')}{th('Customer')}{th('Total', 'r')}{th('Status')}
      </tr></thead>
      <tbody>{bills_rows}</tbody>
    </table>
  </div>
</div>'''

write('Bills.dc.html', page('Bills', 'Bills', 'bills', bills_body))

# ── Inventory ──────────────────────────────────────────────────────────────
STOCK = [
    ('A4 Copier Paper 500 sheets', 'JK', '8901234500017', '4802', '340.00', '18 ream', 'ok'),
    ('Ball Pen Blue', 'Reynolds', '8901234500024', '9608', '10.00', '420 piece', 'ok'),
    ('Ball Pen Black', 'Reynolds', '8901234500031', '9608', '10.00', '386 piece', 'ok'),
    ('Notebook 400 pages', 'Classmate', '8901234500048', '4820', '125.00', '64 piece', 'ok'),
    ('Calculator 12 digit', 'Casio', '8901234500055', '8470', '650.00', '6 piece', 'warn'),
    ('Geometry Box', 'Camlin', '8901234500062', '9017', '145.00', '3 piece', 'warn'),
    ('Glue Stick 15g', 'Fevistick', '8901234500079', '3506', '35.00', '0 piece', 'bad'),
]
stock_rows = ''.join(row([
    td(f'<div>{n}</div><div class="src">{b}</div>'),
    td(f'<span class="num">{bc}</span>'),
    td(f'<span class="num">{h}</span>'),
    td(f'<span class="num">&#8377;{r}</span>', 'r'),
    td(f'<span class="num">{q}</span>', 'r'),
    td(f'<span class="badge {cls}">{"in stock" if cls == "ok" else "low" if cls == "warn" else "out"}</span>'),
    td('<span class="btn ghost sm">Edit</span>', 'r'),
]) for n, b, bc, h, r, q, cls in STOCK)

inventory_body = f'''<div style="display:flex;flex-direction:column;gap:12px">
  <div style="display:flex;gap:10px;align-items:center">
    <div class="input" style="max-width:340px;color:var(--ink-3)">Search by name, brand or barcode</div>
    <div class="spacer"></div>
    <div class="btn">Check stock</div>
    <div class="btn primary">Add product</div>
  </div>

  <div class="card">
    <table>
      <thead><tr>
        {th('Item')}{th('Barcode')}{th('HSN')}{th('Rate', 'r')}{th('On hand', 'r')}{th('')}{th('', width=70)}
      </tr></thead>
      <tbody>{stock_rows}</tbody>
    </table>
  </div>
</div>'''

write('Inventory.dc.html', page('Inventory', 'Inventory', 'inventory', inventory_body))

# ── Reports ────────────────────────────────────────────────────────────────
def returns_cell(rt):
    if rt == '-':
        return '<span style="color: var(--ink-3)">&#8212;</span>'
    return '<span class="num">&#8377;' + rt + '</span>'


DAYS = [('10 Sept', '4', '297.39', '-', '2,085.00', 66),
        ('11 Sept', '4', '234.22', '-', '1,561.00', 49),
        ('12 Sept', '14', '446.16', '340.00', '3,182.00', 100)]
day_rows = ''.join(row([
    td(d), td(f'<span class="num">{b}</span>', 'r'),
    td(f'<span class="num">&#8377;{g}</span>', 'r'),
    td(returns_cell(rt), 'r'),
    td(f'<span class="num">&#8377;{n}</span>', 'r'),
    f'<td style="width:110px"><div class="bar" style="width:{w}%"></div></td>',
]) for d, b, g, rt, n, w in DAYS)

reports_body = f'''<div style="display:flex;flex-direction:column;gap:14px">
  <div style="display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap">
    <div class="segment">
      <div class="seg">Today</div><div class="seg">This week</div><div class="seg on">This month</div>
      <div class="seg">Last month</div><div class="seg">This year</div>
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-3)">
      From <span class="input num" style="width:140px">01&#8211;09&#8211;2026</span>
    </label>
    <label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-3)">
      to <span class="input num" style="width:140px">12&#8211;09&#8211;2026</span>
    </label>
    <div class="spacer"></div>
    <div class="btn sm">Export GST detail</div>
  </div>

  <div class="stat-row">
    <div class="stat"><div class="label">Net sales</div><div class="value num">&#8377;6,828.00</div><div class="sub">22 bills, &#8377;340.00 returned</div></div>
    <div class="stat"><div class="label">Average bill</div><div class="value num">&#8377;325.82</div><div class="sub">01 Sept &#8211; 12 Sept</div></div>
    <div class="stat"><div class="label">Gross profit</div><div class="value num">&#8377;2,104.55</div><div class="sub">30.8% of &#8377;6,828.00</div></div>
    <div class="stat"><div class="label">GST collected</div><div class="value num">&#8377;977.77</div><div class="sub">on &#8377;6,190.23 taxable</div></div>
    <div class="stat"><div class="label">Sold on credit</div><div class="value num">&#8377;1,585.00</div><div class="sub">&#8377;5,583.00 taken at the counter</div></div>
  </div>

  <div style="display:flex;align-items:center;gap:10px">
    <div class="segment">
      <div class="seg on">By day</div><div class="seg">Products</div><div class="seg">Profit</div>
      <div class="seg">GST</div><div class="seg">Payments</div><div class="seg">Staff</div>
    </div>
    <div class="spacer"></div>
    <div class="btn sm">Export this table</div>
  </div>

  <div class="card">
    <table>
      <thead><tr>
        {th('Date')}{th('Bills', 'r')}{th('GST', 'r')}{th('Returns', 'r')}{th('Net', 'r')}{th('', width=110)}
      </tr></thead>
      <tbody>{day_rows}</tbody>
    </table>
  </div>
</div>'''

write('Reports.dc.html', page('Reports', 'Reports', 'reports', reports_body))

# ── Roles & Permissions ────────────────────────────────────────────────────
RES = [
    ('Bills', 'Sales at the counter', [1, 1, 1, 0, 1, 0, 0]),
    ('Returns', 'Goods brought back', [1, 1, 0, 0, 0, 0, 0]),
    ('Payments', 'Money received against credit', [1, 1, 0, 0, 1, 0, 0]),
    ('Stock entries', 'Goods in and adjustments', [0, 0, 0, 0, 0, 0, 0]),
    ('Products', 'The catalogue', [1, 0, 0, 0, 0, 0, 0]),
    ('Customers', 'Names, phone, credit limit', [1, 1, 1, 0, 0, 0, 0]),
]
CAPS = ['View', 'Add', 'Edit', 'Delete', 'Submit', 'Cancel', 'Amend']


def box(on):
    if on:
        return ('<span style="display:inline-block;width:13px;height:13px;background:var(--accent);'
                'border-radius:3px;position:relative"><span style="position:absolute;left:3px;top:1px;'
                'color:#fff;font-size:9px;line-height:11px">&#10003;</span></span>')
    return ('<span style="display:inline-block;width:13px;height:13px;border:1px solid var(--rule-strong);'
            'border-radius:3px;background:var(--surface)"></span>')


grid_rows = ''.join(row(
    [td(f'<div style="font-size:12.5px">{n}</div><div class="src">{note}</div>')]
    + [f'<td style="text-align:center">{box(v)}</td>' for v in vals]
    + [td('<span class="btn ghost sm">All</span>', 'r')]
) for n, note, vals in RES)

PAGE_GROUPS = [
    ('Sell', [('Billing', 1), ('Bills', 1), ('Customers', 1)]),
    ('Stock', [('Inventory', 0), ('Stock In', 0), ('Suppliers', 0)]),
    ('Money', [('Credit', 0), ('Cash Counter', 1)]),
    ('Review', [('Dashboard', 0), ('Reports', 1)]),
    ('Setup', [('Counters', 0), ('Staff', 0), ('Roles &amp; Permissions', 0), ('Settings', 0)]),
]
page_blocks = ''.join(
    f'''<div>
      <div style="font-size:10.5px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-3);margin-bottom:5px">{label}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:4px 16px">
        {''.join(f'<label style="display:flex;align-items:center;gap:8px;padding:4px 2px;font-size:12.5px">{box(on)}{nm}</label>' for nm, on in items)}
      </div>
    </div>''' for label, items in PAGE_GROUPS)

roles_body = f'''<div style="display:flex;gap:14px;align-items:flex-start">
  <div style="flex:0 0 208px">
    <div class="card">
      <div class="card-head"><h2>Roles</h2><div class="spacer"></div><div class="btn sm">New</div></div>
      <div class="card-body">
        <div style="display:flex;flex-direction:column;gap:1px">
          <div style="padding:8px 11px;border-radius:var(--radius-sm);font-size:12.5px;color:var(--ink-2)">Admin <span style="font-size:11px;color:var(--ink-3)">&#183; 1</span></div>
          <div style="padding:8px 11px;border-radius:var(--radius-sm);font-size:12.5px;background:var(--accent-soft);color:var(--accent-ink);font-weight:600">Cashier <span style="font-size:11px;font-weight:400;color:var(--ink-3)">&#183; 2</span></div>
          <div style="padding:8px 11px;border-radius:var(--radius-sm);font-size:12.5px;color:var(--ink-2)">Manager <span style="font-size:11px;color:var(--ink-3)">&#183; 0</span></div>
          <div style="padding:8px 11px;border-radius:var(--radius-sm);font-size:12.5px;color:var(--ink-2)">Stockist <span style="font-size:11px;color:var(--ink-3)">&#183; 1</span></div>
        </div>
      </div>
    </div>
  </div>

  <div style="flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:12px">
    <div class="card">
      <div class="card-head">
        <h2>Cashier &#8212; pages</h2><div class="spacer"></div>
        <span class="meta">2 people</span>
        <div class="btn ghost sm">Rename</div>
        <div class="btn primary sm">Save changes</div>
      </div>
      <div class="card-body">
        <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:12px">A page that is off is missing from the sidebar and cannot be reached any other way.</div>
        <div style="display:flex;flex-direction:column;gap:12px">{page_blocks}</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><h2>Cashier &#8212; what they may do</h2></div>
      <div class="card-body">
        <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:12px">Submit turns a draft into a real document. Cancel reverses one that was already submitted, and Amend reopens it as a corrected copy &#8212; a cashier usually has the first without the other two.</div>
        <div class="card">
          <table>
            <thead><tr>{th('Area')}{''.join(f'<th style="width:62px;text-align:center;font-weight:500">{c}</th>' for c in CAPS)}{th('', width=54)}</tr></thead>
            <tbody>{grid_rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>'''

write('Roles.dc.html', page('Roles', 'Roles &amp; Permissions', 'roles', roles_body))

# ── Staff ──────────────────────────────────────────────────────────────────
STAFF = [
    ('admin', 'Administrator', 'Admin', 'Today, 09:12 am', 'active', 'ok', True),
    ('meena', 'Meena R', 'Cashier', 'Today, 08:55 am', 'active', 'ok', False),
    ('karthik', 'Karthik S', 'Cashier', 'Yesterday', 'locked', 'warn', False),
    ('suresh', 'Suresh M', 'Stockist', '3 days ago', 'active', 'ok', False),
    ('old.staff', '&#8212;', 'Cashier', 'Never', 'off', 'mute', False),
]
staff_rows = ''.join(row([
    td(f'<span class="num">{u}</span>' + (' <span class="badge mute" style="margin-left:7px">you</span>' if me else '')),
    td(n), td(r),
    td(f'<span style="color:var(--ink-3)">{last}</span>'),
    td(f'<span class="badge {cls}">{st}</span>'),
    td('<span class="btn ghost sm">Edit</span> <span class="btn ghost sm">Reset password</span> '
       '<span class="btn ghost sm">Switch off</span>', 'r'),
]) for u, n, r, last, st, cls, me in STAFF)

staff_body = f'''<div style="display:flex;flex-direction:column;gap:12px;max-width:980px">
  <div class="card">
    <div class="card-head"><h2>Staff</h2><div class="spacer"></div><div class="btn primary sm">Add someone</div></div>
    <div class="card-body">
      <div style="font-size:12.5px;color:var(--ink-3);margin-bottom:13px">
        What each person can see and do comes from their role, not from this screen.
        An account is switched off rather than deleted, so the bills they raised keep their name.
      </div>
      <div class="card">
        <table>
          <thead><tr>{th('Username')}{th('Name')}{th('Role')}{th('Last signed in')}{th('Status')}{th('')}</tr></thead>
          <tbody>{staff_rows}</tbody>
        </table>
      </div>
    </div>
  </div>
</div>'''

write('Staff.dc.html', page('Staff', 'Staff', 'users', staff_body))
