import io

p = 'build.py'
s = io.open(p, encoding='utf-8').read()

# Square corners, to match the app.
s = s.replace('--radius: 9px; --radius-sm: 7px;', '--radius: 0; --radius-sm: 0;')
s = s.replace('--radius: 3px; --radius-sm: 2px;', '--radius: 0; --radius-sm: 0;')
s = s.replace('border-radius: 999px;', 'border-radius: 0;')
s = s.replace('border-radius: 4px; font-size: 10.5px;', 'font-size: 10.5px;')
s = s.replace('.bar { height: 5px; border-radius: 3px;', '.bar { height: 5px;')
s = s.replace('background: var(--rule); border-radius: 3px; font-size: 10px;',
              'background: var(--rule); font-size: 10px;')
s = s.replace('border-radius: var(--radius-sm) var(--radius-sm) 0 0;', '')
s = s.replace('border: 1px solid var(--rule-strong); border-radius: 6px; }',
              'border: 1px solid var(--rule-strong); }')

# The tab carries the name, not the figure.
s = s.replace(
    '''      <div class="tab on"><div class="pick"><span class="n">1</span><span class="amt num">1,428.00</span></div><div class="shut">&#10005;</div></div>
      <div class="tab"><div class="pick"><span class="n">2</span><span class="who">Sri Vidya School</span><span class="amt num">3,180.00</span></div><div class="shut">&#10005;</div></div>
      <div class="tab"><div class="pick"><span class="n">3</span><span class="who">New</span></div><div class="shut">&#10005;</div></div>''',
    '''      <div class="tab on"><div class="pick"><span class="n">1</span><span class="who">Walk-in</span></div><div class="shut">&#10005;</div></div>
      <div class="tab"><div class="pick"><span class="n">2</span><span class="who">Sri Vidya School</span></div><div class="shut">&#10005;</div></div>
      <div class="tab"><div class="pick"><span class="n">3</span><span class="who">New</span></div><div class="shut">&#10005;</div></div>''')

# The tab's cross cancels a bill; the button was a second way to do one thing.
s = s.replace('''    <div class="fkeys"><div class="btn">Cancel bill</div></div>
''', '')

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched build.py')
