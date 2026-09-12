import io

p = 'build.py'
s = io.open(p, encoding='utf-8').read()

bad_start = s.index("    td(f'<span class=\"num\">{\"&#8377;\" + rt")
bad_end = s.index("\n", bad_start)
s = s[:bad_start] + "    td(returns_cell(rt), 'r')," + s[bad_end:]

helper = (
    "def returns_cell(rt):\n"
    "    if rt == '-':\n"
    "        return '<span style=\"color: var(--ink-3)\">&#8212;</span>'\n"
    "    return '<span class=\"num\">&#8377;' + rt + '</span>'\n"
    "\n\n"
)
s = s.replace("DAYS = [('10 Sept'", helper + "DAYS = [('10 Sept'", 1)
s = s.replace("'297.39', '—'", "'297.39', '-'")
s = s.replace("'234.22', '—'", "'234.22', '-'")

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('fixed')
