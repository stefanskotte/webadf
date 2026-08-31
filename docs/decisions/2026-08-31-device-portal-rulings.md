# Plan 4b rulings — device provisioning portal

Decisions taken during implementation, preserved here because the SDD ledger lives in
gitignored `.superpowers/` and does not survive the session. Same purpose as
`2026-08-24-foundation-rulings.md`, `2026-08-29-device-plane-rulings.md`,
`2026-08-30-device-ui-rulings.md` and `2026-08-30-device-firmware-rulings.md`.

Plan: `docs/superpowers/plans/2026-08-30-device-provisioning-portal.md`. Spec:
`docs/superpowers/specs/2026-08-30-device-provisioning-portal-design.md`. Branch
`feat/device-portal`, forked from `master` at `00c956b`. Predecessor: plan 4a, merged to
`master` at `0df8c6e` (321 host checks, 242 vitest).

Delivered: 8 tasks, commits `00c956b`..`a1fcae4`, 442 host checks across 13 binaries, 242
vitest, clean ARM cross-build. A final whole-branch review then added one fix wave on top
(506 host checks, same 13 binaries): a distinct confirmation page for a successful submit, a
bounded `portal_run()` wait so `PROV_PORTAL` is no longer a one-way door, a DNS QTYPE check,
and four documentation corrections. Figures quoted below are as of `a1fcae4` and are left
alone — they record what each ruling was taken against.

## Rulings

**Ruling 1 (pre-flight).** `PORTAL_IP_0..3` stays in `dns_server.h`, where Task 3 puts it,
rather than moving to a shared `portal_ip.h`. It is really an AP-wide constant used by DNS,
DHCP and the HTTP redirect, so a dedicated header would be tidier, but with three consumers
and one definition the plan's task order made moving it later pure churn touching three
files for no behavioural gain.
Costs if wrong: a slightly odd include (`dhcp_server.c` including `dns_server.h`), visible
to any reader. Never flagged as a problem in review.

**Ruling 2 (pre-flight).** Task 6's implementation steps were written as prose plus named
APIs, not prescribed code blocks — the one task in this plan that departs from the plan's
own house rule. `portal_net.c` is lwIP/cyw43 callback glue whose exact API shapes had to be
verified against the SDK on disk; plan 4a's record is that prescribing SDK code from memory
produced defects the implementer then had to work around (`image_parse_buffer`'s
whole-buffer API being the clearest case). Prose plus specific API names plus "read
`transport_tls.c`'s locking first" was judged the more honest instruction.
Costs if wrong: the implementer had more latitude in T6 than elsewhere, so its review was
dispatched to run on **opus** rather than sonnet to compensate — see Task 6 below.

**Ruling 3 (pre-flight).** Task 7 carries the `dc_register` bool → `dc_register_result_t`
signature change and all of its call-site updates together, rather than splitting the enum
change from its usage. Splitting would leave the tree non-compiling between tasks. Verified
by grep before the split decision was made: `main.c:229` is the sole production caller, and
`test_device_client.c` had four assertion sites treating the return as a bool — all five
moved in the same task.
Costs if wrong: T7 is larger than its neighbours. Accepted — it is the integration task.

**Ruling 4 (Task 2).** Task 2 (the pure provisioning state machine) was implemented inline
by the controller rather than dispatched to a fresh implementer, under a standing
authorization to do so for tasks that are pure logic with no SDK/lwIP/flash/network
dependency, whose tests are given verbatim in the plan, and whose only dependency is
already complete and reviewed. It still received a full independent task review with the
same gate as every other task, plus an explicit note to the reviewer that the author had
also written the plan.
Costs if wrong: controller context spent on implementation rather than coordination.
Bounded — this was the smallest task in the plan.

**Ruling 5 (Task 4).** Overrode the implementer's deliberate refuse-don't-evict design for
DHCP pool exhaustion in favour of LRU eviction. Against a stable MAC, refusing an unknown
MAC once both of the 2-slot pool's leases are taken is fine — but iOS and Android default to
per-network randomized MACs, so a phone whose association attempt sleeps or is cancelled and
retries presents a *different* MAC each time. Two abandoned attempts fill both slots under
two pseudo-MACs, and the user is locked out of their own portal until a power cycle, with
nothing telling them to do that. `find_lease` still runs first, so a returning known MAC
keeps its slot; only an *unknown* MAC on a full pool evicts, and it evicts the actual least-
recently-used slot, not always slot 0 (a real gap the mutation-proof discipline caught: the
first fix round's two tests both happened to make slot 0 the LRU slot by arrival order, so an
"always evict slot 0" mutant passed the whole suite undetected).
Also explicitly rejected: raising `DHCP_POOL_SIZE`, which delays the problem rather than
fixing it.
Costs if wrong: a genuinely concurrent second client could have its lease reclaimed while
still using it. Accepted — this AP exists to configure one board from one phone, and the
alternative failure mode locks the operator out entirely.

**Ruling 6 (Task 4).** Round 2's re-review of the LRU fix's single added test was folded
into the whole-branch review rather than run as its own scoped pass. The round added one
test and no source change, and the reviewer who requested it had already written that exact
test, run it against both the real implementation and the slot-0 mutant, and reported the
precise failure values that the implementer's own run then reproduced byte for byte.
Costs if wrong: a single test landed without an independent second pair of eyes. Judged low
risk — its discriminating power was demonstrated before it was written.

**Ruling 7 (Task 6).** Accepted the reviewer's recommendation to source
`PORTAL_AP_PASSWORD` from the environment (with a build-time fatal-error guard on empty)
rather than the literal `"***REMOVED-CREDENTIAL***"` the implementer had shipped. A hardcoded PSK
satisfies the spec's "fixed compile-time password" on paper but puts a real WPA2 credential
into git history the moment the file is committed; the implementer's own code comment
already said it should not be there. Unlike `WIFI_PASS`/`WEBADF_PAIRING_CODE` in plan 4a
(which safely degrade to an unusable-but-harmless empty string if unset), an empty WPA2 PSK
is invalid outright and `cyw43_arch_enable_ap_mode()` has no way to report that back at
runtime on a board with no console — so the build refuses outright instead of shipping a
broken AP.
Costs if wrong: the build now requires an extra environment variable that every build
command and every doc must mention. **This is exactly the gap Task 8 (this document's own
task) exists to close** — see the "documentation gap" note below.

**Ruling 8, and its correction — see its own section below.**

## Ruling 8 and its correction — the most instructive decision in this plan

**The ruling, as made in Task 7.** `main.c`'s `DC_HALTED` state is a permanent,
unrecoverable strand: `while (true)` never breaks, so a revoked token or a deleted device
row (server responses `401`, or `404` on `/api/device/poll`) parks the board at the backoff
cap forever. A power cycle does not help — config and token both survive in flash,
`token_store_load` succeeds, registration is skipped, and the board 401s again on its very
next poll. Recovery required physically reflashing the board, triggered by an operator doing
something entirely routine in their own web UI (deleting a device).

The reviewer ruled decisively for fixing this inside Task 7 rather than deferring it, and
the controller agreed, reasoning: Task 8 is docs-only, so "defer" would have meant "never";
the trigger (an operator deleting a device) is routine, not exotic; and the fix was ~5 lines
reusing primitives Task 7 had already added — `token_store_erase()` plus a `break` out of
the halt loop, after which the single-use pairing code being gone naturally yields
`DC_REG_BAD_CODE`, which `prov_on_pairing_code_rejected` already routes back to the portal.
The fix was implemented, verified with a throwaway harness compiled against the real
`config_store`/`token_store`/`provisioning`/`device_client`/`psram_image` replaying the full
provision → register → mount → halt → eject → erase → stale-code register → portal →
simulated-reboot sequence, and landed on `401` **and** on a bare `404` from
`/api/device/poll` — without inspecting the response body.

**The correction, found one round later by the same reviewer re-reviewing the fix.**
Landing the erase on *any* `404` from that endpoint, without checking what the body actually
says, is wider than the ruling's own justification. The server does send a body —
`{"error":"device_not_found"}` — that distinguishes "this device row is really gone" from
any other reason the endpoint might 404 (a bad deploy, a renamed route, a proxy misroute).
Before Ruling 8, an infrastructure 404 was recoverable on its own: the token survived in
flash and every board resumed polling once the server came back healthy. After Ruling 8
shipped as first implemented, the **first** infrastructure 404 any board received would
erase that board's token — and because the condition is a bare status code, not tied to any
particular device, the same bad deploy would do this to **every board in the fleet
simultaneously**, each then needing a human to walk up to it and type in a fresh pairing
code. Ruling 8's own reasoning — "401 and 404 are not transient conditions in this
protocol" — was correct about `401` and wrong about `404`, because a `404` can originate
from infrastructure that has nothing to do with the device's registration state, in a way a
`401` cannot.

**The fix to the fix.** `dc_step`'s 404 handling now requires `!body.truncated &&
json_str(body, "error") == "device_not_found"` before halting; every other 404 — including
a truncated one, an empty one, an HTML proxy error page, or one with a different `error`
value — now routes to `dc_enter_backoff` and retries, exactly as it did before Ruling 8
existed. `401` handling is untouched; the re-reviewer confirmed transport/framing failures,
5xx responses, `400`/`422`, and image-fetch `404`s all still route to `dc_enter_backoff` and
that nothing but a real `401` or a body-confirmed `404` reaches `DC_HALTED`. The
discrimination itself was checked against adversarial inputs, not just the happy path: an
empty body, an HTML page that *contains the literal substring* `device_not_found` inside
markup, and a JSON body with a different `error` value were all constructed specifically to
try to fool a naive substring match, and all three correctly stayed retryable — because
`json_str`/`find_value` is a strict field read (a quoted string followed by `:`), not a
substring scan.

**Why this is worth its own section.** It is the clearest instance in this plan of a
pattern worth carrying into every future ruling: a fix motivated by a real, well-reasoned
product bug can still ship a blast radius its own justification never considered, and the
way to catch that is the same re-review discipline that caught the original bug — not
trusting that "the reasoning was sound" means "the implementation matches the reasoning's
actual scope." The ruling was right to fix `DC_HALTED`. It was wrong to fix it by
pattern-matching on a bare status code instead of the specific condition the reasoning
described.

## Documentation gap this plan left for Task 8

`PORTAL_AP_PASSWORD` became a hard build prerequisite in Task 6 (Ruling 7), but no doc
showed it in an actual build command by the time Task 7 closed:
`docs/superpowers/plans/2026-08-30-device-firmware-protocol.md:105` still showed
`WIFI_SSID=x WIFI_PASS=y pnpm firmware:build` (a command plan 4b's own CMakeLists.txt no
longer accepts — those two variables do nothing now), and `HANDOFF.md` did not mention the
new variable at all. Both were corrected as part of this document's own task (Task 8); see
`HANDOFF.md`'s "Plan 4b" section and the corrected line in the plan file above.

## Hardware-only — carried forward to plan 5 verbatim

Nothing in plan 4a or plan 4b has ever run on hardware; boards are in transit. These were
identified during review as specifically requiring real silicon to answer, and none of them
can be closed by a host test or the cross-build:

1. Whether `netif_default` is really restored to STA (not left NULL) after AP teardown, and
   that TLS to webadf actually succeeds afterward — the entire point of Task 6's Critical
   fix, traced through SDK source (`cyw43_lwip.c`, `netif.c`, `cyw43_ctrl.c`) but never
   executed.
2. Whether the confirmation page physically leaves the radio before the AP tears down.
3. STA DHCP lease acquisition and renewal after the AP netif has been removed.
4. Real phone captive-portal behaviour against the 3-slot lease pool — including whether
   MAC-randomization retry storms behave as the host-tested scenario predicts, and whether
   the ~30 s idle reclaim is long enough in practice.
5. Whether the iOS (`captive.apple.com/hotspot-detect.html`) and Android (`/generate_204`)
   captive-portal probe URLs actually trigger the sign-in sheet on real devices — the
   parsing, routing and redirect logic are host-tested; whether the OS reacts to them the
   way iOS/Android documentation implies is untested by construction.
6. Whether `cyw43_wifi_ap_set_up(false)` on a never-raised AP is benign on silicon.

## Deferred minor findings

None of these block plan 5. Carried verbatim in substance from the SDD ledger
(`.superpowers/sdd/2026-08-30-device-provisioning-portal/progress.md`), by task:

- **Task 1 (`config_store`).** No test isolates the record version check specifically.
  Honestly disclosed by the implementer rather than papered over: the field exists for a
  future format migration and there is only one version today, so no reachable device state
  exercises it. Worth a test when a second format version is introduced — that is when the
  check starts doing load-bearing work.
- **Task 2 (`provisioning`).** `prov_on_assoc_result(p, true)` returns `p->state`
  unchanged rather than forcing `PROV_RUNNING`, and `prov_on_verified_submit`'s failure path
  leaves `state` untouched. Both are correct only because Task 7's caller invokes them from
  the documented state; neither function enforces its own precondition. The invariant became
  real, load-bearing code in Task 7, where main.c's call ordering is exactly what makes it
  safe — see Task 7's own deferred finding below for the flip side of that same fact.
- **Task 3 (`dns_server`).** `qdcount` is validated only as `>= 1`; a query with
  `qdcount > 1` gets a reply that answers the first question but still echoes the original
  question count, so QDCOUNT overstates the question section actually present. Real DNS
  clients always send exactly 1 question, so there is no practical exposure today. Worth a
  note if Task 6 (or anything later) ever routes untrusted multi-question packets to this
  responder.
- **Task 6 (`portal_net`), first minor.** `http_recv_cb`'s req-overflow branch calls
  `start_response` without checking `c->handled`, so a client pipelining enough bytes could
  still reset `resp_len`/`resp_sent` mid-send. It cannot re-run `portal_request` or
  re-publish credentials — the real hazard the code comment is guarding against is already
  closed — but the comment overstates what it actually covers.
- **Task 6 (`portal_net`), second minor.**
  `netif_set_default(&cyw43_state.netif[CYW43_ITF_STA])` is unconditional; if the documented
  STA-mode precondition were ever violated, it would install a zeroed netif as the default
  route, which is worse than leaving it NULL. Satisfied today by `main.c`'s call ordering and
  documented in `portal_net.h`, but the precondition itself is unchecked at the call site.
- **Task 7 (`main.c`).** `main.c` has no host tests, so the eject-before-erase ordering in
  the `DC_HALTED` fix (see Ruling 8 above) and the `break` itself are structurally
  unprotected: swapping those two lines, or deleting the `break` entirely, still compiles and
  passes all 442 host checks plus 242 vitest. The *specific* invariant that ordering depends
  on — that `token_store_erase()` is a silent no-op while a disk is mounted — is protected by
  `test_token_store.c`. Accepted given the project's standing convention that `main.c` is
  device-only glue outside the host-testable seam, and the ordering carries an explicit
  code comment naming the failure it avoids.

## Two "green suite proved nothing" incidents worth remembering as a class

Continuing the pattern named in the 4a rulings file — a gate needs its own proof that it is
*capable* of failing, not just evidence that it currently passes:

- **Task 1.** `config_store.c` compiled cleanly but was linked out of the ELF entirely by
  `--gc-sections`, because nothing yet called it — `nm build/wifi_floppy.elf | grep
  config_store` returned nothing despite the implementer's report claiming the build
  "links wifi_floppy.elf with config_store.c included." This is the **second** occurrence of
  this exact defect class across the two plans (4a task 9 shipped a green build with the
  entire TLS stack silently absent). Fixed with the same `-Wl,-u` force-link technique, and
  the fix was proven load-bearing by removing the flags and watching the symbols vanish, then
  restoring them and watching them return.
- **Task 6.** `portal_stop()` was absent from the ELF entirely — no `-u` entry, no caller —
  so the Critical bug found in it (leaving `netif_default` NULL after AP teardown) existed in
  code that had never been linked, let alone run. Fixed in the same round as the Critical
  itself, once `portal_stop` gained a real caller in the fix.
