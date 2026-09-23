"""Minimal S-expression reader/writer for KiCad files (used by generate_schematic.py)."""
import re

_TOKEN = re.compile(r'\s*(?:(\()|(\))|("(?:[^"\\]|\\.)*")|([^\s()"]+))', re.S)


class Str(str):
    """A quoted string atom (kept distinct from bare symbols)."""


def parse(text):
    stack = [[]]
    pos = 0
    n = len(text)
    while pos < n:
        m = _TOKEN.match(text, pos)
        if not m:
            if text[pos:].strip() == "":
                break
            raise ValueError("parse error at %d: %r" % (pos, text[pos:pos + 40]))
        pos = m.end()
        if m.group(1):
            stack.append([])
        elif m.group(2):
            done = stack.pop()
            stack[-1].append(done)
        elif m.group(3) is not None:
            raw = m.group(3)[1:-1]
            stack[-1].append(Str(re.sub(r'\\(.)', lambda mm: {'n': '\n', 't': '\t'}.get(mm.group(1), mm.group(1)), raw)))
        else:
            stack[-1].append(m.group(4))
    return stack[0]


def quote(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"'


def dump(node, indent=0):
    tab = '\t' * indent
    if not isinstance(node, list):
        return quote(node) if isinstance(node, Str) else str(node)
    simple = all(not isinstance(c, list) for c in node)
    if simple:
        return tab + '(' + ' '.join(dump(c) for c in node) + ')'
    out = tab + '(' + ' '.join(dump(c) for c in node if not isinstance(c, list)) + '\n'
    # keep leading atoms on the first line, children indented
    for c in node:
        if isinstance(c, list):
            out += dump(c, indent + 1) + '\n'
    return out + tab + ')'


def find(node, head):
    for c in node:
        if isinstance(c, list) and c and c[0] == head:
            return c
    return None


def findall(node, head):
    return [c for c in node if isinstance(c, list) and c and c[0] == head]
