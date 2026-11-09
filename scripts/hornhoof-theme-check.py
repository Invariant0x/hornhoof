#!/usr/bin/env python3
"""Checks every theme sheet in hornhoof-themes.md: no empty slot, and contrast by section 6.
Usage: hornhoof-theme-check.py [THEMES.md [theme.css]]
With theme.css, also compares the active theme's colours with the code. Exit 1 on any problem.
Pairs that fail in the active theme are listed in KNOWN: each one is a GAP in the style book or in the file itself."""
import re, sys
args = sys.argv[1:] or ['docs/hornhoof-themes.md', 'apps/web/src/theme.css']
ROLES = 'bg surface surface2 line line2 ink muted accent accent_ink warning warning_ink attention attention_ink success danger on_danger idle dot glow button on_button hud shadow provider_claude provider_kimi provider_glm provider_antigravity on_attention scrim scrollbar_thumb scrollbar_track color_scheme'.split()
TOP = 'id name version status owner character modes default_mode colors fonts shape decor motion terminal mark'.split()
CUT = 'compact_button button secondary_button chip frame panel window'.split()
TOKEN = dict(bg='--bg', surface='--surface', surface2='--surface2', line='--line', line2='--line2', ink='--ink', muted='--muted', accent='--cyan', accent_ink='--cyan-ink', warning='--amber', warning_ink='--amber-ink', attention='--pink', attention_ink='--pink-ink', success='--ok', danger='--red', on_danger='--on-red', idle='--idle', dot='--dot', glow='--glow', button='--btn', on_button='--on-btn', hud='--hud', shadow='--shadow', provider_claude='--p-claude', provider_kimi='--p-kimi', provider_glm='--p-glm', provider_antigravity='--p-antigravity')
KNOWN = {
 'cyberpunk light accent_ink on bg', 'cyberpunk light success on bg', 'cyberpunk light success on surface', 'cyberpunk light success on surface2',
 'cyberpunk light danger on bg', 'cyberpunk light danger on surface2', 'cyberpunk light line2 on surface', 'cyberpunk light line2 on surface2',
 'cyberpunk dark line2 on surface', 'cyberpunk dark line2 on surface2', 'cyberpunk light on_attention on attention', 'cyberpunk dark on_attention on attention',
 'cyberpunk terminal red on bg', 'cyberpunk terminal blue on bg', 'cyberpunk terminal magenta on bg', 'cyberpunk terminal bright black on bg',
}
def strip(line):
    out, q = '', None
    for c in line:
        if q:
            if c == q: q = None
        elif c in '\'"': q = c
        elif c == '#' and (not out or out[-1] in ' \t'): break
        out += c
    return out.rstrip()
def split(text):
    parts, depth, q, cur = [], 0, None, ''
    for c in text:
        if q:
            if c == q: q = None
        elif c in '\'"': q = c
        elif c in '{[': depth += 1
        elif c in '}]': depth -= 1
        elif c == ',' and depth == 0:
            parts.append(cur); cur = ''; continue
        cur += c
    if cur.strip(): parts.append(cur)
    return [x.strip() for x in parts]
def value(text):
    text = text.strip()
    if text.startswith('{'):
        d = {}
        for part in split(text[1:-1]):
            k, _, v = part.partition(':')
            d[k.strip()] = value(v)
        return d
    if text.startswith('['):
        return [value(x) for x in split(text[1:-1])]
    if text[:1] in '\'"':
        return text[1:-1]
    return text
def parse(block):
    root = {}
    stack = [(-1, root)]
    for raw in block.split('\n'):
        line = strip(raw)
        if not line.strip(): continue
        ind = len(line) - len(line.lstrip())
        key, _, rest = line.strip().partition(':')
        while stack[-1][0] >= ind: stack.pop()
        if rest.strip():
            stack[-1][1][key] = value(rest)
        else:
            stack[-1][1][key] = {}
            stack.append((ind, stack[-1][1][key]))
    return root
def lum(h):
    h = h.lstrip('#')
    r = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    r = [c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4 for c in r]
    return .2126 * r[0] + .7152 * r[1] + .0722 * r[2]
def ratio(a, b):
    x, y = lum(a), lum(b)
    return (max(x, y) + .05) / (min(x, y) + .05)
md = open(args[0], encoding='utf-8').read()
sheets = [parse(b) for b in re.findall(r'```yaml\n(.*?)```', md, re.S) if re.match(r'\s*id:', b)]
problems, gaps, pairs = [], [], 0
def check(theme, label, a, b, limit):
    global pairs
    pairs += 1
    r = ratio(a, b)
    if r + 1e-9 < limit:
        name = f'{theme} {label}'
        (gaps if name in KNOWN else problems).append(f'{name}: {r:.2f} under {limit}')
for t in sheets:
    i = t.get('id', '?')
    for k in TOP:
        if t.get(k) in (None, '', {}, []): problems.append(f'{i}: empty slot {k}')
    modes = t.get('modes') or []
    if t.get('default_mode') not in modes + ['system']: problems.append(f'{i}: default_mode {t.get("default_mode")}')
    for m in modes:
        c = (t.get('colors') or {}).get(m) or {}
        for r in ROLES:
            v = c.get(r)
            ok = v in ('light', 'dark') if r == 'color_scheme' else bool(v) and bool(re.fullmatch(r'#[0-9A-Fa-f]{6}|rgba\([^)]*\)', v))
            if not ok: problems.append(f'{i}: {m}: bad or empty role {r}: {v}')
        unknown = set(c) - set(ROLES)
        if unknown: problems.append(f'{i}: {m}: unknown roles {sorted(unknown)}')
        if any(r not in c or not str(c[r]).startswith('#') for r in ('bg', 'surface', 'surface2', 'ink')): continue
        for text in ('ink', 'muted', 'accent_ink', 'warning_ink', 'attention_ink', 'success', 'danger'):
            for on in ('bg', 'surface', 'surface2'):
                check(i, f'{m} {text} on {on}', c[text], c[on], 4.5)
        for fg, bgc, lim in (('on_button', 'button', 4.5), ('on_danger', 'danger', 4.5), ('on_attention', 'attention', 4.5), ('accent_ink', 'surface', 3), ('accent_ink', 'bg', 3), ('line2', 'surface', 3), ('line2', 'surface2', 3)):
            check(i, f'{m} {fg} on {bgc}', c[fg], c[bgc], lim)
    f = t.get('fonts') or {}
    for k in ('display', 'body', 'mono'):
        d = f.get(k) or {}
        for s in ('stack', 'faces', 'package', 'license', 'scripts'):
            if not d.get(s): problems.append(f'{i}: empty font slot {k}.{s}')
        if d.get('package') != 'none' and not {'Latin', 'Cyrillic'} <= set(d.get('scripts') or []):
            problems.append(f'{i}: font {k} lacks Latin or Cyrillic')
    sh = t.get('shape') or {}
    for k in ('cut', 'cut_where', 'corner_mark', 'control_radius', 'radii'):
        if not sh.get(k): problems.append(f'{i}: empty shape slot {k}')
    for k in CUT:
        if k not in (sh.get('cut') or {}): problems.append(f'{i}: empty cut step {k}')
    de = t.get('decor') or {}
    for k in ('grid', 'halo', 'glass', 'map_hub', 'map_lines', 'extra_layer'):
        if not de.get(k): problems.append(f'{i}: empty decor slot {k}')
    if (de.get('extra_layer') or {}).get('kind') is None: problems.append(f'{i}: extra_layer has no kind')
    mo = t.get('motion') or {}
    if not mo.get('reduced_motion'): problems.append(f'{i}: no reduced_motion')
    for k, v in mo.items():
        if k != 'reduced_motion' and not (isinstance(v, dict) and v.get('time') and v.get('kind')):
            problems.append(f'{i}: motion {k} needs time and kind')
    term = (t.get('terminal') or {}).get('all_modes') or {}
    for k in ('bg', 'ink', 'cursor', 'cursor_accent', 'selection', 'selection_ink', 'idle', 'scheme', 'colors', 'bright', 'font'):
        if not term.get(k): problems.append(f'{i}: empty terminal slot {k}')
    names = 'black red green yellow blue magenta cyan white'.split()
    if term.get('colors') and term.get('bright') and term.get('bg'):
        for n in names:
            if n not in term['colors'] or n not in term['bright']: problems.append(f'{i}: terminal lacks {n}'); continue
            if n != 'black': check(i, f'terminal {n} on bg', term['colors'][n], term['bg'], 4.5)
            check(i, f'terminal bright {n} on bg', term['bright'][n], term['bg'], 4.5)
        for n in ('green', 'yellow', 'cyan', 'white'):
            check(i, f'terminal black on {n}', term['colors']['black'], term['colors'][n], 4.5)
        check(i, 'terminal ink on bg', term['ink'], term['bg'], 4.5)
    ma = t.get('mark') or {}
    for k in ('shape', 'dome', 'base', 'dot', 'logo_dome', 'favicon'):
        if not ma.get(k): problems.append(f'{i}: empty mark slot {k}')
checked = 0
if len(args) > 1:
    css = open(args[1], encoding='utf-8').read()
    def block(pat):
        return dict(re.findall(r'(--[a-z0-9-]+):\s*([^;]+);', re.search(pat + r'\s*\{(.*?)\}', css, re.S).group(1)))
    code = {'light': block(r'(?m)^:root'), 'dark': block(r':root\[data-theme="dark"\]')}
    active = [t for t in sheets if t.get('status') == 'active']
    if len(active) != 1: problems.append(f'active themes: {len(active)}')
    for t in active:
        for m in t['modes']:
            for role, tok in TOKEN.items():
                checked += 1
                if t['colors'][m][role].lower() != code[m][tok].strip().lower():
                    problems.append(f'{t["id"]} {m} {role}: sheet {t["colors"][m][role]}, code {code[m][tok]}')
print('sheets', [t.get('id') for t in sheets], 'contrast pairs', pairs, 'compared with code', checked)
print('GAP, known and written down', len(gaps))
for g in gaps: print('  ' + g)
print('PROBLEMS', len(problems))
for p in problems: print('  ' + p)
sys.exit(1 if problems else 0)
