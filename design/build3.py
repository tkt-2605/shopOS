"""Three artboards answering comments on the canvas: the payment dialog with
loyalty redemption, the Items & Pricing screen the plan calls for, and a
side-by-side of type pairings."""
from build import *  # noqa: F401,F403

# ── Payment, with loyalty redemption ───────────────────────────────────────
PAY_CSS = """
  .backdrop { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px;
              background: rgb(20 32 31 / 42%); }
  .modal { width: 100%; max-width: 460px; background: var(--surface);
           box-shadow: var(--shadow); }
  .modal-head { padding: 14px 18px; border-bottom: 1px solid var(--rule-soft); font-weight: 600; }
  .modal-body { display: flex; flex-direction: column; gap: 14px; padding: 18px; }
  .modal-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 14px 18px;
                border-top: 1px solid var(--rule-soft); }
  .btn.lg { padding: 13px 20px; font-size: 15px; }
  .redeem { padding: 11px 13px; background: var(--ok-soft); }
  .qty-input { display: inline-block; width: 72px; padding: 4px 8px; text-align: right;
               background: var(--surface); border: 1px solid var(--rule-strong); }
"""

pay_body = (
    '<div style="position:relative;height:100%">'
    '<div style="padding:16px 18px;color:var(--ink-3);font-size:13px">'
    'The bill sits behind this — the dialog is what the cashier sees after F12.</div>'

    '<div class="backdrop"><div class="modal">'
    '<div class="modal-head">Take payment &#8212; &#8377;334.00</div>'
    '<div class="modal-body">'

    '<div class="redeem">'
    '<div style="display:flex;align-items:center;gap:10px">'
    '<span style="font-size:12.5px;flex:1">Anand Kumar has <strong>6 points</strong>. '
    'Up to 6 can go against this bill.</span>'
    '<span class="qty-input num">6</span>'
    '<span class="btn sm">All</span></div>'
    '<div style="margin-top:7px;font-size:12.5px;color:var(--ink-2)">'
    '6 points pay &#8377;6.00 &#8212; &#8377;334.00 left.</div>'
    '</div>'

    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">'
    '<div class="btn primary lg">Cash</div><div class="btn lg">UPI</div>'
    '<div class="btn lg">Card</div><div class="btn lg">Credit</div>'
    '</div>'

    '</div>'
    '<div class="modal-foot"><div class="btn">Cancel</div></div>'
    '</div></div></div>'
)

write('Payment.dc.html', page('Payment', 'Billing', 'billing', pay_body,
                             flush=True, extra_css=PAY_CSS))

# ── Items & Pricing ────────────────────────────────────────────────────────
LISTS = [('Retail', 'Default', '312 items', True),
         ('Wholesale', '15% under retail', '96 items', False),
         ('School supply', 'Session rates', '48 items', False)]
list_rows = ''.join(row([
    td(n + ('<span class="badge ok" style="margin-left:7px">default</span>' if d == 'Default' else '')),
    td('<span style="color: var(--ink-3)">' + note + '</span>'),
    td('<span class="num">' + cnt + '</span>', 'r'),
    td('<span class="btn ghost sm">Open</span>', 'r'),
]) for n, d, note, cnt, in [(a, ('Default' if c else ''), b, cc) for a, b, cc, c in LISTS])

TIERS = [('1 +', '340.00'), ('10 +', '325.00'), ('50 +', '310.00')]
tier_rows = ''.join(row([
    td('<span class="num">' + q + '</span>'),
    td('<span class="num">&#8377;' + r + '</span>', 'r'),
    td('<span class="btn ghost sm">&#10005;</span>', 'r'),
]) for q, r in TIERS)

RULES = [
    ('Diwali &#8212; gift items', 'Category: Gift', '01 Oct &#8211; 05 Nov', '10% off', '2', 'ok', 'running'),
    ('School season &#8212; buy 10 get 1', 'Category: Notebooks', '01 Apr &#8211; 30 Jun', '1 free per 10', '3', 'mute', 'ended'),
    ('Wholesale customers', 'Group: Wholesale', 'No end date', '8% off', '5', 'ok', 'running'),
    ('Camlin pencil box', 'Item: Camlin Pencil Box', 'till 30 Sept', 'Set &#8377;85.00', '9', 'ok', 'running'),
]
rule_rows = ''.join(row([
    td('<div>' + n + '</div><div class="src">' + scope + '</div>'),
    td('<span style="color: var(--ink-3)">' + when + '</span>'),
    td(action),
    td('<span class="num">' + pri + '</span>', 'r'),
    td('<span class="badge ' + cls + '">' + st + '</span>'),
    td('<span class="btn ghost sm">Edit</span>', 'r'),
]) for n, scope, when, action, pri, cls, st in RULES)

pricing_body = (
    '<div style="display:flex;flex-direction:column;gap:12px">'

    '<div style="display:flex;gap:12px;align-items:flex-start">'
    '<div class="card" style="flex:1 1 0">'
    '<div class="card-head"><h2>Price lists</h2><div class="spacer"></div>'
    '<div class="btn sm">New list</div></div>'
    '<table><thead><tr>' + th('List') + th('') + th('Items', 'r') + th('', width=70)
    + '</tr></thead><tbody>' + list_rows + '</tbody></table></div>'

    '<div class="card" style="flex:1 1 0">'
    '<div class="card-head"><h2>A4 Copier Paper &#8212; Retail</h2><div class="spacer"></div>'
    '<div class="btn sm">Add tier</div></div>'
    '<table><thead><tr>' + th('Quantity') + th('Rate', 'r') + th('', width=54)
    + '</tr></thead><tbody>' + tier_rows + '</tbody></table>'
    '<div style="padding:10px 16px;font-size:12px;color:var(--ink-3);'
    'border-top:1px solid var(--rule-soft)">'
    'The highest tier the quantity reaches applies, inclusive at the break.</div></div>'
    '</div>'

    '<div class="card">'
    '<div class="card-head"><h2>Pricing rules</h2><div class="spacer"></div>'
    '<span class="meta">Highest priority wins; stackable rules layer</span>'
    '<div class="btn primary sm">New rule</div></div>'
    '<table><thead><tr>'
    + th('Rule') + th('When') + th('Does') + th('Priority', 'r') + th('') + th('', width=60)
    + '</tr></thead><tbody>' + rule_rows + '</tbody></table>'
    '<div style="padding:10px 16px;font-size:12px;color:var(--ink-3);'
    'border-top:1px solid var(--rule-soft)">'
    'A rule sets, discounts or adds a free line. It never rewrites a price list &#8212; '
    'the bill records which rule set the rate, so a price can always be explained.</div>'
    '</div>'

    '</div>'
)

write('ItemsPricing.dc.html', page('ItemsPricing', 'Items &amp; Pricing', 'pricing', pricing_body))

# ── Type pairings ──────────────────────────────────────────────────────────
FONTS = [
    ('Now &#8212; Segoe UI', '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
     '"Cascadia Mono", Consolas, monospace',
     'Windows’ own face. Invisible, which is the point at a counter, but it is also '
     'what every other Windows program looks like.'),
    ('Corbel', 'Corbel, "Segoe UI", sans-serif', 'Consolas, monospace',
     'Humanist, a little warmer, and its figures have real character. Ships with Windows, '
     'so it still works with the line down.'),
    ('Constantia', 'Constantia, Georgia, serif', 'Consolas, monospace',
     'A ledger face. Reads as a book of accounts rather than software — suits the '
     'Khata theme, and is the boldest of the three.'),
]
font_cols = ''.join(
    '<div style="flex:1 1 0;min-width:0;border:1px solid var(--rule);background:var(--surface)">'
    '<div style="padding:12px 16px;border-bottom:1px solid var(--rule-soft)">'
    '<div style="font-family:' + body + ';font-size:13.5px;font-weight:600">' + name + '</div>'
    '<div style="font-size:11.5px;color:var(--ink-3);margin-top:3px">' + note + '</div></div>'
    '<div style="padding:14px 16px;font-family:' + body + '">'
    '<div style="font-size:14px;font-weight:600;letter-spacing:-0.01em">Billing</div>'
    '<div style="font-size:12.5px;color:var(--ink-3);margin-top:2px">'
    'Scan or type, then Enter to add</div>'
    '<div style="margin-top:14px;font-size:13.5px">A4 Copier Paper 500 sheets</div>'
    '<div style="font-size:10.5px;color:var(--ink-3)">Product base price</div>'
    '<div style="display:flex;justify-content:space-between;margin-top:12px;'
    'padding-top:11px;border-top:1px solid var(--rule-strong);align-items:baseline">'
    '<span style="font-size:13px;font-weight:600">Total</span>'
    '<span style="font-family:' + mono + ';font-size:29px;font-weight:500;'
    'letter-spacing:-0.02em">&#8377;1,428.00</span></div>'
    '<div style="margin-top:12px;font-family:' + mono + ';font-size:12.5px;color:var(--ink-2)">'
    'INV/MR/26-27/00024<br>9,047,112,233 &#183; 0123456789</div>'
    '</div></div>'
    for name, body, mono, note in FONTS)

fonts_body = (
    '<div style="display:flex;flex-direction:column;gap:14px">'
    '<div style="font-size:12.5px;color:var(--ink-3);max-width:760px">'
    'Three pairings, all using faces Windows already has &#8212; the counter has to work '
    'with the line down, so a downloaded font is not an option. Figures stay monospaced in '
    'every one, because a column of amounts that does not line up is worse than any font choice.'
    '</div>'
    '<div style="display:flex;gap:14px">' + font_cols + '</div>'
    '</div>'
)

write('Fonts.dc.html', page('Fonts', 'Type', 'settings', fonts_body))
