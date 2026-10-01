#!/usr/bin/env python3
"""Read-only survey of Amiga disk images for copy-protection and crack fingerprints.

usage: python scan_protect.py [--detail] PATH [PATH ...]
  PATH may be a directory (scanned non-recursively), an .adf, or a .zip (its
  .adf members are read in memory; nothing is extracted to disk).

What an ADF CAN show: decoded sector data only.  It cannot show sync words,
long tracks or bit timing, so "key track lost" is inferred from an all-zero
track on a trackloader disk, never measured.

Columns: name | protection code | key track lost? | crack/patch signs | verdict
"""
import os, re, sys, zipfile, struct

ADF_DD = 901120
ADF_HD = 1802240

# ---- fingerprints -------------------------------------------------------
# Rob Northen Copylock prologue: pea x(pc) / move.l (sp)+,$10 / illegal
COPYLOCK = [
    (re.compile(rb'\x48\x7a..\x23\xdf\x00\x00\x00\x10\x4a\xfc', re.S), 'Copylock prologue (pea/move.l (sp)+,$10/illegal)'),
    (re.compile(rb'\x4a\xfc\x48\xe7\xff\xff\x48\x7a', re.S), 'Copylock stage-2 (illegal/movem.l all,-(sp)/pea)'),
]
# trace-vector + self-decrypt idiom: move.l a7,$24.l ; ori.w #$a71f,sr
TRACE_DECRYPT = re.compile(rb'\x23\xcf\x00\x00\x00\x24\x00\x7c\xa7\x1f')
# DSKSYNC writes with a non-standard sync word (absolute or via (An))
SYNC_ABS = re.compile(rb'\x33\xfc(..)\x00\xdf\xf0\x7e', re.S)
SYNC_IND = re.compile(rb'[\x31\x33\x35\x37\x39\x3b\x3d\x3f]\x7c(..)\x00\x7e', re.S)

CRACK_TEXT = re.compile(
    rb'(cracked\s+by|crack(?:ed|ing)?\s+(?:&|and)|trained\s+by|trainer|\+\d\s*trainer|fixed\s+by|'
    rb'unlimited\s+lives|infinite\s+lives|'
    rb'skid\s*row|quartex|fairlight|paradox|hoodlum|prestige|defjam|razor\s*1911|'
    rb'crystal(?=\W)|nemesis|vision\s*factory|supplex|red\s*sector|tristar|hysteria|'
    rb'angels|classic\s+(?:crack|intro)|dual\s*crew|the\s+band|bamiga\s*sector\s*one|'
    rb'zenith|replicants|elite\s+(?:crack|presents)|scoopex|rebels|delight)', re.I)

TOSEC_FLAG = re.compile(r'\[(cr|t|f|h|m|a|o|b|p|tr|!)(\d*)([^\]]*)\]')
FLAG_MEANING = {'cr': 'cracked', 't': 'trainer', 'f': 'fixed', 'h': 'hacked', 'm': 'modified',
                'a': 'alternate', 'o': 'overdump', 'b': 'bad dump', 'p': 'pirate', 'tr': 'translation',
                '!': 'verified good dump'}

def bootblock(d):
    if d[:3] != b'DOS':
        return 'no DOS bootblock'
    s = 0
    for i in range(0, 1024, 4):
        if i == 4: continue
        s += struct.unpack('>I', d[i:i+4])[0]
        if s > 0xffffffff: s = (s + 1) & 0xffffffff
    ok = (~s & 0xffffffff) == struct.unpack('>I', d[4:8])[0]
    return 'DOS%d bootblock, %s' % (d[3] & 7, 'bootable' if ok else 'not bootable (checksum invalid)')

def has_filesystem(d, nblocks):
    root = nblocks // 2
    b = d[root*512:(root+1)*512]
    if len(b) < 512: return False
    t, = struct.unpack('>I', b[0:4]); st, = struct.unpack('>i', b[508:512])
    return t == 2 and st == 1

def zero_tracks(d, spt):
    n = len(d) // (spt * 512)
    z = []
    for t in range(n):
        blk = d[t*spt*512:(t+1)*spt*512]
        if not blk.strip(b'\x00'):
            z.append(t)
    return z, n

def analyse(name, d):
    r = {'name': name}
    if len(d) not in (ADF_DD, ADF_HD):
        r.update(prot='-', keytrack='-', crack='-', verdict='unknown (not a plain ADF: %d bytes)' % len(d))
        return r
    spt = 11 if len(d) == ADF_DD else 22
    nblocks = len(d) // 512
    bb = bootblock(d)
    fs = has_filesystem(d, nblocks)
    zt, ntr = zero_tracks(d, spt)
    # interior zero tracks = zero tracks followed later by data (not the empty tail of a disk)
    last_data = max([t for t in range(ntr) if t not in zt] or [0])
    interior = [t for t in zt if t < last_data]

    prot = []
    for rx, label in COPYLOCK:
        hits = [m.start() for m in rx.finditer(d)]
        if hits:
            prot.append('%s @%s' % (label, ','.join('0x%x(trk %d)' % (h, h // (spt*512)) for h in hits[:3])))
    if TRACE_DECRYPT.search(d):
        prot.append('trace-vector self-decrypt idiom')
    syncs = set()
    for rx in (SYNC_ABS, SYNC_IND):
        for m in rx.finditer(d):
            v = struct.unpack('>H', m.group(1))[0]
            if v != 0x4489 and (v & 0xff00) in (0x8900, 0x8a00, 0x4400, 0x4800, 0x9200, 0x5200, 0xa200, 0x2200):
                syncs.add(v)
    if syncs and not fs:  # on AmigaDOS disks these byte patterns are mostly false positives
        prot.append('non-4489 DSKSYNC constant(s) ' + ','.join('$%04x' % s for s in sorted(syncs)))

    flags = TOSEC_FLAG.findall(name)
    cracks = []
    for f, n, rest in flags:
        if f in ('cr', 't', 'f', 'h', 'm', 'a', 'p'):
            cracks.append('TOSEC [%s%s%s]=%s' % (f, n, rest, FLAG_MEANING[f]))
    texts = {}
    for m in CRACK_TEXT.finditer(d):
        k = m.group(0).decode('latin1').lower()
        texts.setdefault(k, m.start())
    for k, off in list(texts.items())[:5]:
        cracks.append('text "%s" @0x%x' % (k, off))

    copylock = any('Copylock' in p for p in prot)
    trackloader = not fs
    # key track lost: Copylock present and an interior all-zero track exists on a trackloader disk
    if copylock and interior:
        keytrack = 'likely (zero trk %s)' % ','.join(map(str, interior[:6]))
    elif copylock:
        keytrack = 'unknown (no zero track)'
    elif trackloader and interior:
        keytrack = 'possible (zero trk %s)' % ','.join(map(str, interior[:6]))
    else:
        keytrack = 'no'

    tosec_crack = any(f in ('cr', 't') for f, _, _ in flags)
    tosec_mod = any(f in ('f', 'h', 'm', 'a', 'p') for f, _, _ in flags)
    if tosec_crack or any(t for t in texts if 'crack' in t or 'train' in t):
        verdict = 'cracked'
    elif tosec_mod:
        verdict = 'patched/modified (per TOSEC flag)'
    elif copylock and interior:
        verdict = 'original-protected (key track lost; see note)'
    elif copylock:
        verdict = 'original-protected? (unknown)'
    elif texts:
        verdict = 'unknown (group/trainer text found)'
    elif fs:
        verdict = 'unprotected (AmigaDOS, no fingerprint)'
    else:
        verdict = 'unknown (trackloader, no fingerprint)'

    r.update(prot='; '.join(prot) or 'none found', keytrack=keytrack,
             crack='; '.join(cracks) or 'none found', verdict=verdict,
             boot=bb, fs='AmigaDOS' if fs else 'no filesystem (trackloader)', zero=zt)
    return r

def iter_inputs(paths):
    for p in paths:
        if os.path.isdir(p):
            for f in sorted(os.listdir(p), key=str.lower):
                if f.startswith('.'): continue
                yield from iter_inputs([os.path.join(p, f)])
        elif p.lower().endswith('.zip'):
            try:
                with zipfile.ZipFile(p) as z:
                    members = [i for i in z.namelist() if i.lower().endswith('.adf')]
                    if not members:
                        yield os.path.basename(p), None, 'zip with no .adf members'
                    for i in members:
                        yield '%s!%s' % (os.path.basename(p), i), z.read(i), None
            except Exception as e:
                yield os.path.basename(p), None, 'unreadable zip: %s' % e
        else:
            low = p.lower()
            if low.endswith(('.adf',)):
                yield os.path.basename(p), open(p, 'rb').read(), None
            else:
                ext = os.path.splitext(p)[1] or '(none)'
                yield os.path.basename(p), None, 'not scanned (%s is not an ADF)' % ext

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    detail = '--detail' in sys.argv
    print('filename | protection code present? | likely key track lost? | signs of crack or patch | verdict')
    for name, data, why in iter_inputs(args):
        if data is None:
            print('%s | - | - | - | unknown (%s)' % (name, why)); continue
        r = analyse(name, data)
        print('%s | %s | %s | %s | %s' % (r['name'], r['prot'], r['keytrack'], r['crack'], r['verdict']))
        if detail and 'boot' in r:
            print('    %s; %s; zero tracks: %s' % (r['boot'], r['fs'], r['zero'] if len(r['zero']) < 30 else '%d tracks' % len(r['zero'])))

if __name__ == '__main__':
    main()
