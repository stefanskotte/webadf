# HFE fixtures

Made by Greaseweazle from synthetic images (never a real disk — adfmfm spec §14).
Regenerate with `pnpm hfe:fixtures` (needs `gw` on PATH; ~/.local/bin/gw here).
Output is byte-for-byte reproducible (`gzip -n`).

| File | Made by | Header (measured 2026-09-24) |
|---|---|---|
| clean.hfe.gz | `gw convert --format amiga.amigados sparse.adf clean.hfe` | HXCPICFE, rev 0, 80 cyl, 2 sides, encoding 0xFF, 253 kbit/s, 12,668 bytes/side |
| v3.hfe.gz | `gw convert --format amiga.amigados sparse.adf 'v3.hfe::version=3'` | HXCHFEV3, rev **0** |
| pc.hfe.gz | `gw convert --format ibm.720 pc.img pc.hfe` | HXCPICFE, 80 cyl, 2 sides, 0xFF, 250 kbit/s, 12,500 bytes/side |

`sparse.adf` is `sparseAdf()` in `source.ts`; `pc.img` is 737,280 zero bytes.
Damaged, over-long, truncated and otherwise malformed inputs are derived from
these in the tests (`load.ts`), not committed.
