# webadf — Decision Log (plan 2, device plane)

Rulings taken while implementing
`docs/superpowers/plans/2026-08-29-webadf-device-plane.md`.
Preserved here because the SDD workspace is gitignored scratch.

- ### Rulings
- Ruling PF-1 (PLAN BUG I AUTHORED, verified by computation): ALPHABET =
- Ruling: REMOVE Q from the generating alphabet (keep the normalizer's Q->0
- Ruling PF-2 (interface gap I authored): T5's `claimNextJob(deviceId):
- Ruling: claimNextJob returns
- Ruling PF-3 (ordering conflict I authored): T6's second e2e POSTs
- Ruling: MOVE the mount endpoint from T10 into T5, which already owns
- Ruling PF-4 (plan-format defect I authored): T5's mount.test.ts shows six test
- test code" pattern the review rubric treats as a defect. Ruling: the six
- Ruling PF-1 applied: Q dropped from the generating alphabet; property test added
- Ruling T1-1 (SECOND PLAN BUG I AUTHORED, found by the implementer): my brief said
- Ruling T1-2: the invite code travels as a raw extra body property read via
- Ruling T1-3 (CRITICAL, ACCEPT — PLAN DEFECT I AUTHORED, #3 in this plan): invite
- Ruling T1-4 (Important, ACCEPT): the alphabet property test — the very test I
- Ruling A-1 (transport): operator chose TLS + bearer token on the firmware over a
- Ruling A-2 (resequencing plan 2): Tasks 6, 7 and 8 are built against a contract
- Ruling: continue with the PROTOCOL-AGNOSTIC remainder (Task 5 mount jobs, then

## Deferred minor findings (plan 2, tasks 1-4)

- Task 2: minor (deferred): my brief's snippet imported `boolean` but no column uses
- Task 3: minor (deferred): two of the seven tests are weaker than they look — the
- Task 3: minor (deferred): tokensMatch('','') returns true. Harmless while an empty
- Task 1: minor (deferred): user.create.before gates ANY user-creation path, not just
- Task 4: minor (deferred): pairing_codes has no column for the `name` the pair
- Task 4: minor (deferred): requireDevice throws DeviceAuthError, but the brief's prose
- Task 4: minor (deferred): pair route returns 500 if all 5 code-generation draws collide.

## Noted

- Task 4: NOTED: the implementer self-reported echoing a real test device's
