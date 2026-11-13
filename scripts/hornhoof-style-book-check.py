#!/usr/bin/env python3
"""Usage: hornhoof-style-book-check.py [BOOK.md [THEME.css [REPO [REF]]]].
Compares every token name and value in the book with the Light and Cyberpunk skins of apps/web/src/skins/registry.ts,
the book's own rules, and the classes it names with theme.css.
With a repository it also checks that every source file the book names exists. Exit 1 on any mismatch."""
import json, os, re, subprocess, sys

args = sys.argv[1:] or ['docs/style-book.md', 'apps/web/src/theme.css', '.', 'HEAD']
book = open(args[0], encoding='utf8').read()
theme = re.sub(r'/\*.*?\*/', '', open(args[1], encoding='utf8').read(), flags=re.S)
problems = []


def skin_tokens(registry):
    """The tokens each built-in skin sets on the page, read from the registry the app takes them from."""
    code = ("const [r, s] = await Promise.all([import(process.argv[1]), import(process.argv[1].replace('registry.ts', 'roles.ts'))]);"
            "console.log(JSON.stringify(Object.fromEntries(r.BUILTIN_SKINS.map(k => [k.id, Object.fromEntries(s.declarations(k))]))));")
    out = subprocess.run(['node', '--no-warnings', '--input-type=module', '-e', code, os.path.abspath(registry)], capture_output=True, text=True, check=True).stdout
    return {skin: {name: value for name, value in tokens.items() if name.startswith('--')} for skin, tokens in json.loads(out).items()}


skins = skin_tokens(os.path.join(args[2] if len(args) > 2 else '.', 'apps/web/src/skins/registry.ts'))
light = skins['light']
dark = {name: value for name, value in skins['cyberpunk'].items() if name in light and not name.startswith('--f-') and name != '--cut-k'}

section = book[book.index('## 1. Colours'):book.index('### Contrast of text')]
book_colours = {m[0]: (m[1], m[2]) for m in re.findall(r'^\| `(--[\w-]+)` \| `([^`]+)` \| `([^`]+)` \|', section, flags=re.M)}
type_part = book[book.index('## 2. Type'):book.index('Fonts are imported')]
book_fonts = {m[0]: m[1] for m in re.findall(r'^\| `(--[\w-]+)` \| `([^`]+)` \|', type_part, flags=re.M)}

expected_colours = {name: (light[name], dark[name]) for name in dark}
expected_fonts = {name: value for name, value in light.items() if name not in dark}
for name in expected_colours.keys() - book_colours.keys():
    problems.append(f'missing from the book: {name}')
for name in book_colours.keys() - expected_colours.keys():
    problems.append(f'not in the skins: {name}')
for name in expected_colours.keys() & book_colours.keys():
    if expected_colours[name] != book_colours[name]:
        problems.append(f'value differs: {name} book {book_colours[name]} theme {expected_colours[name]}')
for name in expected_fonts.keys() - book_fonts.keys():
    problems.append(f'missing from the book: {name}')
for name in book_fonts.keys() - expected_fonts.keys():
    problems.append(f'not in the skins: {name}')
for name in expected_fonts.keys() & book_fonts.keys():
    if expected_fonts[name] != book_fonts[name]:
        problems.append(f'value differs: {name} book {book_fonts[name]} theme {expected_fonts[name]}')
print(f'tokens: theme {len(light)} (colours {len(expected_colours)}, fonts {len(expected_fonts)}); book colours {len(book_colours)}, fonts {len(book_fonts)}')

# Contrast is recomputed from the theme, not trusted from the text.
def luminance(value):
    h = value.lstrip('#')
    channels = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return sum(w * (c / 12.92 if c <= .03928 else ((c + .055) / 1.055) ** 2.4) for w, c in zip((.2126, .7152, .0722), channels))


def ratio(a, b):
    x, y = luminance(a), luminance(b)
    return (max(x, y) + .05) / (min(x, y) + .05)


contrast = book[book.index('### Contrast of text'):book.index('Fixed pairs:')]
rows = re.findall(r'^\| `(--[\w-]+)` \| (.+) \|$', contrast, flags=re.M)
checked = 0
for name, cells in rows:
    numbers = [c.strip() for c in cells.split('|')]
    for i, (theme_tokens, bg) in enumerate([(light, b) for b in ('--bg', '--surface', '--surface2')] + [(dark, b) for b in ('--bg', '--surface', '--surface2')]):
        value = ratio(theme_tokens[name], theme_tokens[bg])
        shown = numbers[i].strip('*')
        bold = numbers[i].startswith('**')
        checked += 1
        if f'{value:.2f}' != shown:
            problems.append(f'contrast differs: {name} on {bg} book {shown} real {value:.2f}')
        if bold != (value < 4.5):
            problems.append(f'contrast mark wrong: {name} on {bg}')
print(f'contrast cells recomputed: {checked}')

# The book's own rules: base recorded, repository writing rules, nothing private.
for needle in ('a354cc276d6f92792e4e602627d7300dfc04f251', '6efe8ccd9c9d420114e212c0cbf6c99d4a1ac97771b8ceebb00c1f8549a412ec'):
    if needle not in book[:800]:
        problems.append(f'base not at the start of the book: {needle[:12]}')
if '—' in book:
    problems.append(f'em dashes: {book.count(chr(0x2014))}')
if re.search('[ёЁ]', book):
    problems.append('Russian letter with two dots')
for pattern in (r'[\w.+-]+@[\w-]+\.[\w.-]+', r'\b(?:sk|ghp|gho|xox[bp])[-_][A-Za-z0-9_-]{16,}', r'(?i)\b(?:password|api[_ ]?key)\s*[:=]\s*\S+'):
    found = re.findall(pattern, book)
    if found:
        problems.append(f'looks private: {found[:3]}')
needed = ['## 1. Colours', '## 2. Type', '## 3. Spacing and sizes', '## 4. Components', '## 5. Languages', '## 6. Text wrap and action groups', '## 7. Site and marketing', '## 8. Using and changing this book']
for heading in needed:
    if heading not in book:
        problems.append(f'section missing: {heading}')

# Every class in section 4 exists in the theme; every source named exists at the ref.
classes = set(re.findall(r'`\.([a-zA-Z][\w-]*)', book[book.index('## 4. Components'):book.index('## 5. Languages')]))
missing_classes = [c for c in sorted(classes) if not re.search(r'\.' + re.escape(c) + r'(?![\w-])', theme)]
print(f'classes of section 4 found in theme.css: {len(classes) - len(missing_classes)} of {len(classes)}')
for c in missing_classes:
    if c == 'error':  # recorded in the book as a class with no rule
        print('  .error has no rule in theme.css, as the book says')
        continue
    problems.append(f'class not in theme.css: .{c}')

if len(args) > 2:
    repo, ref = args[2], args[3] if len(args) > 3 else 'HEAD'
    tree = set(subprocess.run(['git', '-C', repo, 'ls-tree', '-r', '--name-only', ref], capture_output=True, text=True).stdout.splitlines())
    named = set()
    for path in re.findall(r'`((?:ui|screens)/[\w./-]+\.tsx?)`', book):
        named.add('apps/web/src/' + path)
    for path in re.findall(r'`((?:apps|templates|guide|\.github)/[\w./-]+\.\w+)`', book):
        named.add(path)
    for path in re.findall(r'`([A-Z_]+\.md)`', book):
        named.add(path)
    absent = sorted(p for p in named if p not in tree)
    print(f'source files named: {len(named)}, found at {ref}: {len(named) - len(absent)}')
    problems += [f'source not found: {p}' for p in absent]

    # Each row of section 4: at least one named file really uses the row's main class.
    part = book[book.index('## 4. Components'):book.index('## 5. Languages')]
    cache = {}
    def source(path):
        if path not in cache:
            cache[path] = subprocess.run(['git', '-C', repo, 'show', f'{ref}:apps/web/src/{path}'], capture_output=True, text=True).stdout
        return cache[path]
    rows_checked = 0
    for line in part.splitlines():
        if not line.startswith('| ') or line.startswith('|---'):
            continue
        cells = [x.strip() for x in line.strip('|').split('|')]
        files = re.findall(r'`((?:ui|screens)/[\w./-]+\.tsx?)`', cells[-1])
        marks = re.findall(r'`\.([a-zA-Z][\w-]*)', cells[0])
        if not files or not marks:
            continue
        for mark in marks:
            rows_checked += 1
            if not any(re.search(r'(?<![\w-])' + re.escape(mark) + r'(?![\w-])', source(f)) for f in files):
                problems.append(f'class not in its named sources: .{mark} in {files}')
    print(f'class and source pairs of section 4 checked: {rows_checked}')

print('PROBLEMS', len(problems))
for line in problems:
    print(' ', line)
sys.exit(1 if problems else 0)
