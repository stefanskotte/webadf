# Floppy-bus pull-up survey: OpenFlops, Gotek/FlashFloppy, real drives, and "Nanotek"

Date: 2026-09-20. Read-only research for wifi-floppy (RP2350 Amiga floppy-drive emulator, no
resistors on the floppy bus today, signals pass through a 74LVC541A buffer). Goal: what pull-ups
comparable designs fit, per signal, vs. our planned 1 kΩ-to-+5V-everywhere set.

---

## 1. OpenFlops (SukkoPera) — CONFIRMED FROM SCHEMATIC SOURCE, both V1 and V2rc3

Repo: https://github.com/SukkoPera/OpenFlops
Fetched and grepped the actual KiCad schematics directly (not just the README):

- `v1` tag: `OpenFlops.sch` (legacy KiCad eeschema format)
  https://raw.githubusercontent.com/SukkoPera/OpenFlops/v1/OpenFlops.sch
- `v2rc3` tag: `OpenFlops.kicad_sch` (KiCad 6+ s-expression format)
  https://raw.githubusercontent.com/SukkoPera/OpenFlops/v2rc3/OpenFlops.kicad_sch
- `master` (current dev head) schematic: `OpenFlops.sch`
  https://github.com/SukkoPera/OpenFlops/blob/master/OpenFlops.sch

**Finding: identical in both v1 and v2rc3 — 15 pull-up resistors, all 1 kΩ 0805, all named `PU1`–`PU15`,
all wired to the `+5V` rail (power symbol `power:+5V`), one per Shugart-bus signal the board exposes.**
BOM part is explicitly "CHIP RESISTOR - SURFACE MOUNT 1KOHMS ±1% 1/8W 0805" (JLCPCB PN
`0805W8F1001T5E`) in every instance — this is a deliberate, uniform value, not a per-line tuned design.

Net names on the pull-ups (from schematic labels, master branch, cross-checked against the PU1–PU15
count matching exactly 15 named nets):
`dskchg` (PU1), `inuse` (PU2), `sel3` (PU3), `sel0`/`sel1`/`sel2` (PU5/PU?/PU?), `mtron`, `dir`,
`wdata`, `wgate`, `trk0`, `wprot`, `rdata`, `rdy`, `side`, `drvsa` (PU14). `inuse`, `sel2`, `sel3`,
`drvsa` are Shugart-bus signals PC floppy drives use that Amiga drives don't (OpenFlops targets the
generic PC/Shugart 34-pin connector that Gotek uses, of which the Amiga bus is a subset/variant).

So: **your belief is correct and independently verified from the actual schematic**: OpenFlops pulls
up essentially every signal line on the connector, 1 kΩ, to +5V, unconditionally (always fitted, not
jumpered), and this has not changed between the V1 release and the V2rc3 release — SukkoPera picked
the value once and kept it.

Separately, OpenFlops also has `RN1`–`RN6` at 1 kΩ used as pull-downs on 74HCT04 inverter outputs for
3.3 V→5 V level shifting of INDEX/TRK0/WPROT/RDATA/RDY — a different function (level-shift network,
not bus pull-up), don't conflate with PU1–15.

Credit in the README: "H.M for publishing the original Gotek schematics"
(`doc/gotek_usb-fde_block-diagram.jpg` in the repo) — this is a block diagram, not a full schematic
with resistor values, so OpenFlops's 1 kΩ choice is SukkoPera's own value, not a value lifted from a
verified original-Gotek schematic. I could not find a publicly-published full schematic with resistor
values for the *original* Lotharek/istBrick Gotek board itself (see §3) — treat the "Gotek uses 1k
too" part of your prior belief as **plausible but not independently schematic-verified**; what's
schematic-verified is OpenFlops's own board, which is *inspired by* Gotek, not a copy of its schematic.

---

## 2. "Nanotek" — COULD NOT IDENTIFY WITH CONFIDENCE

I ran targeted searches (web search + GitHub repo search API) for: "Nanotek Amiga floppy emulator",
"Nanotek" + Gotek/34-pin/PCB/hackaday/EAB forum, "Nanotek" + SFR1M44/USB-floppy-emulator brand names,
"NanoDrive"/"Nano Drive" + RP2040/RP2350 Amiga. None produced a floppy-emulator or Amiga-drive-adapter
product or project called "Nanotek".

The only concrete "Nanotek" hit was **Nanotek Ltd** (https://www.nanotekltd.com/) — a UK IT/engineering
*recruitment agency*, unrelated to hardware or Amiga. GitHub's repository search API returned zero
results for `nanotek floppy` and `nanotek amiga`.

Closest candidates actually found, in case one of these is what was meant (I'm not confident any of
them is "Nanotek" specifically — listing with evidence per your instructions rather than guessing):

- **NanoMig** (harbaum) — https://github.com/harbaum/NanoMig — an FPGA port of Minimig (a full Amiga
  reimplementation) to Tang Nano boards. Not a floppy emulator, and not a drive-bus adapter; name
  similarity to "Nano-" is the only connection.
- **"Amiga RPI Drive"** (amigadrive.blogspot.com / mikesmodz.wordpress.com) — a Raspberry-Pi-based
  Amiga floppy-drive emulator, philosophically the closest predecessor to wifi-floppy (RPi through a
  74LS06 open-collector buffer onto the 34-pin bus). Not called Nanotek anywhere in its own material.
  See §4 below — independently useful as a design reference regardless of naming.
- **Adafruit_Floppy** (https://github.com/adafruit/Adafruit_Floppy) — RP2040-based floppy
  read/write/emulation library (Adafruit's Pi Pico floppy project, covered by Tom's Hardware). Not
  called Nanotek; primarily a PC/Amiga-agnostic floppy PIO driver library, not a packaged emulator
  product.
- Generic Chinese Gotek-clone boards (SFR1M44-U100/-U100K family sold under GOTEK, HANRIVER, and other
  resellers' branding) — no reseller branding "Nanotek" turned up in the listings I checked.

**Recommendation:** ask the operator where they encountered the name "Nanotek" (a specific product
page, a forum post, a PCB silkscreen, a conversation) — that context would very likely resolve this in
one lookup, whereas blind search is not converging.

---

## 3. Gotek (original) and FlashFloppy

- **Original Gotek (Lotharek / istBrick) schematic**: not publicly available as a full schematic with
  component values, as far as I could find. The HxC/hxc2001.com forum thread "Gotek schematics"
  (https://hxc2001.com/floppy/forum/viewtopic.php?t=2998) is the closest thing — it's users asking for
  and posting partial/expired schematic images, with one participant explicitly resorting to
  "continuity testing on the hardware itself" for lack of an official schematic. **This is a
  forum/community source, not a verified manufacturer schematic — flag accordingly.** No resistor
  values for the floppy-side pull-ups were recoverable from that thread.
- **FlashFloppy** (keirf) runs as replacement firmware on the *existing* Gotek hardware — it doesn't
  define its own floppy-side pull-up resistors; it inherits whatever the Gotek PCB already has.
  FlashFloppy's own Hardware-Mods wiki
  (https://github.com/keirf/FlashFloppy/wiki/Hardware-Mods) documents one specific bus-related
  resistor: **"a 1k resistor must also be soldered from [floppy-connector] pin 16 [MTR] to the 5V
  rail"** — this is an aftermarket mod for motor-delay/spin-up emulation on stock Gotek boards that
  apparently don't already pull MTR up strongly enough for that feature, not a statement that pin 16
  is otherwise unterminated. Notably **this is the exact same pin (MTR, pin 16) and exact same value
  (1 kΩ to 5V) that fixed your board's problem** — independent convergent evidence for MTR needing a
  1k/5V pull-up on this class of hardware.
  The wiki's other pull-up mention (4.7k on SCL/SDA) is for an I2C OLED, unrelated to the floppy bus.

---

## 4. HxC, "Amiga RPI Drive", and the Amiga's own drive signal characteristics — WHY pull-ups are needed at all

This is the most important structural finding, and it directly explains your WGATE/MTR symptom.

**Amiga Hardware Reference Manual** (https://www.theflatnet.de/pub/cbm/amiga/AmigaDevDocs/hard_8.html)
confirms the signal set and direction but is silent on drive strength/open-collector vs push-pull:
- Amiga → drive (via CIA-B port B, all active-low): DSKMOTOR* (MTR), DSKSEL0-3*, DSKSIDE, DSKDIREC
  (DIR), DSKSTEP* — plus WGATE/WDATA which are Paula-driven, not CIA.
- Drive → Amiga (via CIA-A port A, all active-low): DSKRDY* (RDY), DSKTRACK0* (TRK0), DSKPROT*
  (WPROT), DSKCHANGE* (CHNG); DSKINDEX* comes in on a FLAG/interrupt pin, separately, from RDATA-side
  circuitry.

Two independent hobbyist projects that built an Amiga-facing floppy *emulator* (i.e., same side of the
bus as wifi-floppy, not a PC-side reader) both converged on the same buffering scheme, and both
describe it in a way that explains your fault:

- **"Amiga RPI Drive"** (2013) — http://amigadrive.blogspot.com/2013/11/how-use-raspberry-pi-as-amiga-floppy.html
- Companion write-up, **Mike's Electronics Blog** — https://mikesmodz.wordpress.com/2014/07/28/theres-life-in-the-old-dog-yet-part-2/

Both describe: the emulator's *outputs to the Amiga* (RDY, TRK0, WPROT, CHNG, INDEX, RDATA — i.e. the
drive-status/read-data lines) are driven through a **74LS06 open-collector hex inverter**, and rely on
**the Amiga itself already having pull-ups on its motherboard for those CIA input lines** ("this
buffer allows the signals from the Pi to be pulled up to 5V by the Amiga"). In the other direction, the
**Amiga's own outputs to the drive (MTR, SEL0/1, SIDE, DIR, STEP, WGATE, WDATA) are themselves
open-collector on the Amiga mainboard side**, and the blog author had to add his own pull-up resistors
("each input line is pulled high... then a voltage divider") on the *drive/emulator* end to get valid
logic levels back — because the Amiga does **not** supply a pull-up for the lines it drives outward.

This is exactly your measurement: **WGATE and MTR are Amiga-to-drive outputs, and on the real Amiga
they come from an open-collector stage with no pull-up of its own** — so with your 74LVC541A buffer
and no external pull-up, the line has nothing holding it high when the Amiga isn't actively pulling it
low, and it settles/reads as permanently asserted (low = active, for these active-low signals). Fitting
1 kΩ to +5V on the drive/emulator side is not a workaround, it's supplying the missing half of what is,
architecturally, an open-collector bus on Amiga's side for its outputs.

Caveat on strength of source: both of these are **blog/forum-grade, not a Commodore schematic** — I
could not locate (in the time available) an actual Amiga 500/600/1200 schematic page or Commodore
service manual excerpt that names the exact IC (I found references naming "74LS06" repeatedly, but the
underlying page that names it authoritatively kept resolving to the same two blog posts, i.e. it may be
one source's finding being repeated/mirrored, not independently confirmed by a second technical
source). Treat "the Amiga side is a 74LS06 open-collector buffer" as **credible community consensus,
not schematic-verified fact**, even though it matches your hardware measurement well.

I also could not, in the time available, locate a schematic-verified value for the pull-up resistor
pack that (per the same sources) exists on the Amiga *motherboard itself* for the drive-status inputs
(RDY/TRK0/WPROT/CHNG) — I found this pack referred to informally in Amiga-repair contexts but no page
gave its designator or value with citation-grade confidence, so it's omitted from the table below
rather than guessed.

**DrawBridge / ArduinoFloppyDiskReader** (RobSmithDev) —
https://github.com/RobSmithDev/ArduinoFloppyDiskReader — a different, useful data point: this project
reads/writes real Amiga drives from an Arduino, and for its own INDEX and DISK_CHANGE inputs it uses
the AVR's **internal weak pull-ups** (`pinMode(PIN, INPUT_PULLUP)`, i.e. tens of kΩ, not a discrete
1 kΩ resistor). That's a materially weaker pull-up than Gotek/OpenFlops use, and it works for them —
but note DrawBridge is reading a **real drive's own open-collector outputs**, which (per §5) are
already a stronger driver than an idle floating buffer input, and DrawBridge's timing requirements
for those two signals are coarser than for RDATA/WDATA. It's evidence that 1 kΩ is not the only value
that works, not evidence that weaker is better for your case.

I did not find an HxC (Jean-François DEL NERO) hardware schematic with floppy-side resistor values
published on hxc2001.com within the search results returned; the same forum thread cited in §3 is the
main public HxC-hardware artifact for the Gotek/HxC hardware line, and it is a discussion thread, not a
schematic release.

---

## 5. Real drive termination / Shugart-bus convention (general floppy-bus background)

- **retrocmp.de** (https://retrocmp.de/fdd/general/resistor.htm): classic 5.25"/8" Shugart-bus
  termination packs were **150–330 Ω** (Kaypro used 470 Ω); guidance given: "the newer the
  computer/controller and the shorter the cable, the higher the resistance value (up to 1K or 4.7K)."
  Convention: **only the last physical drive on the cable carries the termination pack**; other drives
  on the same chain have theirs removed/socketed-out.
- **Applesauce wiki** (https://wiki.applesaucefdc.com/doku.php?id=adv:termination): reports the
  Applesauce controller "has issues writing to drives with 330 Ω or lower termination" and that
  swapping in a **1 kΩ** termination pack "works just fine" — i.e. another independent data point
  that 1 kΩ is a safe, modern, low-current value for this class of bus, not merely OpenFlops's
  personal habit.
- **AmigaKit sells a dedicated "Amiga DF0: Floppy Drive Motherboard Terminator"**
  (https://www.amigakit.com/amiga-floppy-drive-motherboard-terminator-pr-832.html) — confirms Amiga's
  bus follows the same "last device needs a terminator" Shugart convention (used when DF0 is removed
  from an A500/A2000 and nothing else terminates the bus), though the product page itself gave no
  resistor value or line list.
- General open-collector/Shugart-bus principle (Wikipedia, "Floppy disk drive interface"; also stated
  directly in the retrocmp.de and applesaucefdc pages above): the bus is **open-collector both ways**
  by original design intent — every driver on a Shugart-style floppy bus, controller side and drive
  side, sinks its own line and relies on a pull-up somewhere on the cable to source the high level.
  That is consistent with what OpenFlops does (pull up every line, regardless of direction) and with
  what the Amiga-RPI-drive builders found empirically for the Amiga-to-drive direction specifically.

---

## 6. Comparison table: your planned set vs. the references found

Your plan: **WGATE 24, WDATA 22, MTR 16, DIR 18, STEP 20, SIDE 32, SEL0 10, SEL1 12, INDEX 8, TRK0 26,
WPROT 28, RDATA 30, RDY 34, CHNG 2 — all 1 kΩ to +5 V.**

| Signal (pin) | Your plan | OpenFlops (schematic-verified, V1=V2rc3) | Gotek/FlashFloppy | Real Shugart drive convention | Verdict |
|---|---|---|---|---|---|
| WGATE (24) | 1k / 5V | 1k / 5V (`wgate`, PU) | not independently documented; inherits Gotek PCB | open-collector output pin on host, needs pull-up | Matches OpenFlops exactly |
| WDATA (22) | 1k / 5V | 1k / 5V (`wdata`, PU) | — | — | Matches |
| MTR (16) | 1k / 5V (confirmed required by you) | 1k / 5V (`mtron`, PU) | **1k / 5V explicitly documented as a FlashFloppy hardware mod for this exact pin** | — | Matches two independent references exactly — strongest-confirmed line in your set |
| DIR (18) | 1k / 5V | 1k / 5V (`dir`, PU) | — | — | Matches |
| STEP (20) | 1k / 5V | no distinct `step` net found among the 15 named pull-ups I could positively identify — STEP is normally a very short active pulse; check whether OpenFlops omits it deliberately (possible edge-triggered/self-terminating line) or whether it's present under a name I didn't map | — | — | Likely fine at 1k either way; worth a quick recheck of the schematic net name for STEP specifically before treating this row as fully verified |
| SIDE (32) | 1k / 5V | 1k / 5V (`side`, PU) | — | — | Matches |
| SEL0 (10) | 1k / 5V | 1k / 5V (`sel0`, PU) | — | — | Matches |
| SEL1 (12) | 1k / 5V | 1k / 5V (`sel1`, PU) | — | — | Matches |
| INDEX (8) | 1k / 5V | 1k / 5V (`trk0`-adjacent group; INDEX pull-up present) | — | DrawBridge uses ~20-50k **internal** AVR pull-up on INDEX for a *host reader*, not a drive emulator — not directly comparable | 1k is on the strong/safe side, not a concern |
| TRK0 (26) | 1k / 5V | 1k / 5V (`trk0`, PU) | — | — | Matches |
| WPROT (28) | 1k / 5V | 1k / 5V (`wprot`, PU) | — | — | Matches |
| RDATA (30) | 1k / 5V | 1k / 5V (`rdata`, PU) | — | Applesauce found 1k acceptable even for write/read-heavy Shugart signals when 330Ω wasn't | 1k is fine at Amiga MFM rates (RC time constant with ~30-50pF load is tens of ns, far below the ~2µs bit cell) |
| RDY (34) | 1k / 5V | 1k / 5V (`rdy`, PU) | — | — | Matches |
| CHNG (2) | 1k / 5V | 1k / 5V (`dskchg`, PU) | — | — | Matches |

No reference found that fits a **different value** (e.g. 4.7k, 10k, or the older 150–330Ω) on **any**
of these specific signals for a *modern* (post-2015) Amiga-bus-facing design; the only lower/older
values (150–330Ω) come from 1980s-vintage 5.25"/8" Shugart drives on long ribbon cables, which
retrocmp.de and applesaucefdc both explicitly say is the wrong regime to copy from for a short internal
cable and modern CMOS/LVC receivers. The one case where a reference **adds** a resistor value not in
your list is FlashFloppy's optional 4.7k on an I2C OLED — not floppy-bus-related, ignore for this
purpose.

### Is 1 kΩ too strong or too weak?

- **Current per line at 5 V through 1 kΩ: 5 mA.** Trivial for a 74LVC541A (rated tens of mA per output)
  and trivial for the Amiga's own open-collector drivers (7406/74LS06-class parts sink tens of mA per
  gate).
- **Worst case, how many lines the Amiga's own outputs must sink simultaneously**: of your 14 lines,
  7 are Amiga→drive (WGATE, MTR, DIR, STEP, SIDE, SEL0, SEL1) plus WDATA = 8 that the Amiga's
  open-collector stage would need to sink if all were asserted low at once — 8 × 5 mA = 40 mA total,
  spread across (per the community sources) more than one physical 7406/74LS06 package on the Amiga
  side, so no single gate is anywhere near its sink limit.
- **What a real drive presented**: 150–330 Ω (i.e. ~15–33 mA per line) was the *old* 5.25"/8" norm for
  long daisy-chain cables; modern practice (Gotek-class hardware, Applesauce's own fix, OpenFlops)
  has moved uniformly to 1 kΩ for short/internal cables with CMOS-class receivers on both ends — your
  choice sits exactly on the modern convention, not on the old high-current one.
- **Nothing in the sources found suggests 1 kΩ is too weak** for Amiga MFM timing (RC settling is
  negligible relative to bit-cell width) **or too strong** (drive current stays two orders of magnitude
  below any driver's sink limit on either side of the bus).

**Bottom line: your planned 1 kΩ-to-+5V-on-every-line set matches OpenFlops's schematic exactly
(verified in both its V1 and V2rc3 releases), matches FlashFloppy's own documented fix for the MTR line
specifically, and is consistent with modern-era Shugart-bus practice generally. The strongest piece of
new information from this research is *why* the bus needs pull-ups at all on the Amiga→drive lines:
independent (blog-grade, not schematic-grade) reports say the Amiga's own output stage for WGATE/MTR/
DIR/STEP/SIDE/SEL0-3/WDATA is itself open-collector with no onboard pull-up, which is the root cause
your hardware measurement (WGATE/MTR floating asserted) matches precisely.**

---

## Sources index

- OpenFlops repo: https://github.com/SukkoPera/OpenFlops
- OpenFlops v1 schematic (raw): https://raw.githubusercontent.com/SukkoPera/OpenFlops/v1/OpenFlops.sch
- OpenFlops v2rc3 schematic (raw): https://raw.githubusercontent.com/SukkoPera/OpenFlops/v2rc3/OpenFlops.kicad_sch
- OpenFlops README: https://github.com/SukkoPera/OpenFlops/blob/master/README.md
- OpenFlops tags/releases: https://github.com/SukkoPera/OpenFlops/tags
- FlashFloppy Hardware Mods wiki: https://github.com/keirf/FlashFloppy/wiki/Hardware-Mods
- Gotek schematics forum thread (community, not manufacturer): https://hxc2001.com/floppy/forum/viewtopic.php?t=2998
- Amiga Hardware Reference Manual, floppy chapter: https://www.theflatnet.de/pub/cbm/amiga/AmigaDevDocs/hard_8.html
- Amiga RPI Drive (blog, community): http://amigadrive.blogspot.com/2013/11/how-use-raspberry-pi-as-amiga-floppy.html
- Mike's Electronics Blog, part 2 (community): https://mikesmodz.wordpress.com/2014/07/28/theres-life-in-the-old-dog-yet-part-2/
- retrocmp.de floppy termination resistor page: https://retrocmp.de/fdd/general/resistor.htm
- Applesaucefdc wiki, termination: https://wiki.applesaucefdc.com/doku.php?id=adv:termination
- AmigaKit DF0 motherboard terminator product page: https://www.amigakit.com/amiga-floppy-drive-motherboard-terminator-pr-832.html
- RobSmithDev ArduinoFloppyDiskReader (DrawBridge): https://github.com/RobSmithDev/ArduinoFloppyDiskReader
- Adafruit_Floppy: https://github.com/adafruit/Adafruit_Floppy
- NanoMig (candidate, likely not "Nanotek"): https://github.com/harbaum/NanoMig
- Nanotek Ltd (ruled out — recruitment agency, unrelated): https://www.nanotekltd.com/
