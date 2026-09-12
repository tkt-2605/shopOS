from build import *  # noqa: F401,F403

# ── Suppliers ──────────────────────────────────────────────────────────────
DASH = '&#8212;'
SUPP = [
    ('Sakthi Agencies', '9047112233', '33ALNPJ1906G1ZC', '14', '11 Sept 2026', '48,260.00'),
    ('Perambalur Paper Mart', '9047556677', '33AABCP1234K1Z9', '9', '08 Sept 2026', '31,540.00'),
    ('Anand Distributors', '9047889900', DASH, '6', '02 Sept 2026', '12,880.00'),
    ('Camlin Depot', '9047334455', '33AACCC5678M1Z4', '3', '24 Aug 2026', '7,420.00'),
    ('Typo Vendor', DASH, DASH, '0', 'Never', DASH),
]


def money_or_dash(v):
    return v if v == DASH else '&#8377;' + v


supp_rows = ''.join(row([
    td(n),
    td('<span class="num">' + ph + '</span>'),
    td('<span class="num">' + g + '</span>'),
    td('<span class="num">' + d + '</span>', 'r'),
    td('<span style="color: var(--ink-3)">' + last + '</span>'),
    td('<span class="num">' + money_or_dash(amt) + '</span>', 'r'),
    td('<span class="btn ghost sm">Edit</span>'
       + (' <span class="btn ghost sm">Delete</span>' if d == '0' else ''), 'r'),
]) for n, ph, g, d, last, amt in SUPP)

supp_body = (
    '<div style="display:flex;flex-direction:column;gap:12px;max-width:980px">'
    '<div class="card">'
    '<div class="card-head"><h2>Suppliers</h2><div class="spacer"></div>'
    '<div class="btn primary sm">Add supplier</div></div>'
    '<div class="card-body">'
    '<div style="font-size:12.5px;color:var(--ink-3);margin-bottom:13px">'
    'Stock In records goods against one of these, so purchase history and cost add up per '
    'vendor instead of scattering across three spellings of the same name.</div>'
    '<div class="card"><table><thead><tr>'
    + th('Supplier') + th('Phone') + th('GSTIN') + th('Deliveries', 'r')
    + th('Last') + th('Bought', 'r') + th('')
    + '</tr></thead><tbody>' + supp_rows + '</tbody></table></div>'
    '</div></div></div>'
)

write('Suppliers.dc.html', page('Suppliers', 'Suppliers', 'suppliers', supp_body))

# ── Settings ───────────────────────────────────────────────────────────────
THEMES = [
    ('Daylight', 'Light and soft. Default.', '#f7f8fa', '#eef1f6', '#3b6fd4', True),
    ('Khata', 'Warm paper, red ink.', '#f7f2e8', '#efe6d6', '#a8452c', False),
    ('Night counter', 'Dark, for late hours.', '#1c2430', '#2a3442', '#6f9fe8', False),
]
theme_cards = ''.join(
    '<div style="overflow:hidden;background:var(--surface);border-radius:var(--radius-sm);border:'
    + ('2px solid var(--accent)' if on else '1px solid var(--rule-strong)') + '">'
    + '<div style="display:flex;height:46px">'
    + '<div style="width:26px;background:' + b + '"></div>'
    + '<div style="flex:1;background:' + a + '"></div>'
    + '<div style="width:30px;background:' + c + '"></div></div>'
    + '<div style="padding:8px 11px;border-top:1px solid var(--rule)">'
    + '<div style="font-size:12.5px;font-weight:600">' + n + '</div>'
    + '<div style="font-size:11px;color:var(--ink-3)">' + note + '</div></div></div>'
    for n, note, a, b, c, on in THEMES)

BACKUPS = [('2026-09-12', '581 KB', True), ('2026-09-11', '578 KB', False),
           ('2026-09-10', '574 KB', False)]
backup_rows = ''.join(row([
    td('<span class="num">' + d + '</span>'
       + (' <span class="badge ok" style="margin-left:7px">latest</span>' if latest else '')),
    td('<span class="num">' + sz + '</span>', 'r'),
    td('<span class="btn ghost sm">Restore</span> <span class="btn ghost sm">Copy out</span>'
       + ('' if latest else ' <span class="btn ghost sm">Delete</span>'), 'r'),
]) for d, sz, latest in BACKUPS)

settings_body = (
    '<div style="display:flex;flex-direction:column;gap:14px;max-width:860px">'

    '<div class="card"><div class="card-head"><h2>Appearance</h2></div><div class="card-body">'
    '<div style="font-size:12.5px;color:var(--ink-3);margin-bottom:13px">'
    'Changes how the counter looks. The layout stays the same.</div>'
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:11px">'
    + theme_cards + '</div>'
    '<div style="display:flex;align-items:center;gap:14px;margin-top:15px;padding-top:14px;'
    'border-top:1px solid var(--rule-soft)">'
    '<span style="font-size:12.5px;font-weight:500;width:150px">Row density</span>'
    '<div class="segment"><div class="seg">Comfortable</div><div class="seg on">Compact</div>'
    '<div class="seg">Very compact</div></div></div>'
    '</div></div>'

    '<div class="card"><div class="card-head"><h2>Loyalty program</h2><div class="spacer"></div>'
    '<div class="btn primary sm">Save</div></div><div class="card-body">'
    '<div style="font-size:12.5px;color:var(--ink-3);margin-bottom:13px">'
    'Points are earned per bill and spent soonest-to-expire first.</div>'
    '<label style="display:flex;align-items:center;gap:9px;font-size:13px;margin-bottom:14px">'
    + box(True) + '<span style="font-weight:500">Run a loyalty program</span></label>'
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px 24px">'
    '<div class="field"><label>One point is worth</label><div class="input num">1.00</div></div>'
    '<div class="field"><label>Points expire after</label><div class="input num">365</div>'
    '<span class="hint">Days. Leave blank for never.</span></div>'
    '<div class="field"><label>Minimum bill to earn</label><div class="input num">100.00</div></div>'
    '<div class="field"><label>Points may pay at most</label><div class="input num">20</div>'
    '<span class="hint">Per cent of the bill.</span></div>'
    '</div></div></div>'

    '<div class="card"><div class="card-head"><h2>Receipt printer</h2></div><div class="card-body">'
    '<div style="font-size:12.5px;color:var(--ink-3);margin-bottom:13px">'
    'Receipts are sent as raw ESC/POS, so the driver cannot reinterpret them.</div>'
    '<div class="field"><label>Thermal printer</label>'
    '<div class="select">TVS RP 3200 Star</div>'
    '<span class="hint">Windows default is TVS RP 3200 Star.</span></div>'
    '</div></div>'

    '<div class="card"><div class="card-head"><h2>Backups</h2><div class="spacer"></div>'
    '<div class="btn primary sm">Back up now</div></div><div class="card-body">'
    '<div style="font-size:12.5px;color:var(--ink-3);margin-bottom:13px">'
    'One backup is taken automatically each day the shop opens, and the last 14 are kept. '
    'They live on this machine &#8212; copy one somewhere else for it to survive the machine.</div>'
    '<div class="card" style="margin-bottom:14px"><table><thead><tr>'
    + th('Backup') + th('Size', 'r') + th('')
    + '</tr></thead><tbody>' + backup_rows + '</tbody></table></div>'
    '<div class="field"><label>Copy backups to</label>'
    '<div style="display:flex;gap:6px">'
    '<div class="input num" style="flex:1">D:/ShopOS backups</div>'
    '<div class="btn">Choose&#8230;</div></div>'
    '<span class="hint">A USB stick, or a folder your Drive or OneDrive app syncs &#8212; '
    'that is an offsite copy without ShopOS ever going online.</span></div>'
    '</div></div>'

    '</div>'
)

write('Settings.dc.html', page('Settings', 'Settings', 'settings', settings_body))
