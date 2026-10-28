# Library sharing (Remote libraries) — design

Date: 2026-10-28. Status: approved in conversation (parts 1-3), awaiting review of this written spec.

## 1. Goal

Plex-style sharing of a library between WebFloppy users, hosted or self-hosted, in any combination. The owner makes
a link for one person, scoped to chosen collections; the recipient pastes it into their own WebFloppy and browses the
library under a new **Remote** menu, mounts its disks on their own boards and sends them over PaulaNET. The owner sees
who has access and revokes it per person. No email: the owner hands the URL over themselves.

## 2. Decisions (operator, 2026-10-28)

| # | Decision |
|---|---|
| D1 | A recipient may browse, download, mount in DF0:/DF1: on their own boards and send over PaulaNET. No "add to my library" and no writes to the owner's disks. |
| D2 | When the Amiga writes to a mounted remote disk, the recipient's copy becomes a **local** disk in their library, under Uncategorized. It is theirs from then on and survives a revoke. |
| D3 | One link per person, claimed once: the claim swaps the one-time code for a long-lived token only the claiming instance holds. Revoke per person. |
| D4 | The owner's instance must be reachable by the recipient's server (public address, reverse proxy, Tailscale Funnel, Cloudflare Tunnel...). No relay. A help topic explains the setup. |
| D5 | A share covers one or more chosen collections, or Everything. Live: changes to those collections show up for the recipient; the owner can change a share's collections later. |
| D6 | Server to server (approach A): the recipient's server holds the token and calls the owner's share API; the browser talks only to its own instance. No same-instance shortcut: two users of one instance share over the same HTTP API. |
| D7 | Copyright is left to the users; no terms text is added. |

## 3. Owner side

### 3.1 Data

`library_shares`

| column | notes |
|---|---|
| id | text pk |
| org_id | the owner's team |
| label | the person ("Rob"), required, 1-60 chars |
| everything | bool: all collections, present and future |
| claim_code_hash | sha256 of the one-time code; null once claimed |
| claim_expires_at | created + 7 days; an unclaimed share past it shows "expired" and cannot be claimed |
| token_hash | sha256 of the long-lived token; null until claimed |
| claimed_at, claimed_by_url, claimed_by_name | what the claiming instance reported (its address, its library/team name) |
| last_used_at | updated at most once a minute |
| revoked_at | set by Revoke; every request with the token then fails 401 `revoked` |
| created_at, created_by | |

`library_share_collections (share_id, collection_id)`: pk on both; FK cascade on both (deleting a collection or a
share removes the row). A share that is not `everything` and has no collections left still exists and shows nothing.

Codes and tokens are 32 random bytes, base64url. Only hashes are stored; the code is shown once, at creation.

### 3.2 Share API (`/api/share/v1/...`, owner's instance)

Every route except claim needs `Authorization: Bearer <token>`; the token must exist, be claimed and not revoked.
Read-only. Rate-limited per token (listings 120/min, bytes 30/min). Responses are JSON except bytes.

| route | does |
|---|---|
| `POST claim` | body `{code, protocol: 1, instanceUrl, instanceName}`. Valid, unexpired, unclaimed code: stores the hashed token and the claimant's details, returns `{token, protocol: 1, library: {name}}`. Anything else: 404 `invalid_or_used` (one answer for unknown, expired, used and revoked, so codes cannot be probed). Rate-limited per client IP. |
| `GET library` | the library name, the collections in scope (id, name), counts |
| `GET titles?collection=&q=&cursor=` | titles in scope with their cover, identification and disk count; paged like the local library |
| `GET titles/{id}` | one title and its disks (id, name, kind, size, sha256, updatedAt) |
| `GET disks/{id}/files` | the disk's file listing, as the local disk files page gets it |
| `GET disks/{id}/bytes` | the disk image, with `ETag: <sha256>` |
| `GET covers/{id}` | a cover image, only when its title is in scope |

**Scope check on every request:** a title or disk is visible only if it belongs to the owner's org and (`everything`
or its title is in one of the share's collections) **at the moment of the request**. Anything else is 404, never 403,
so a recipient cannot tell "exists but not shared" from "does not exist". Bytes are streamed from the disk store; the
`entitlements` gate is replaced, for this route only, by this scope check (the owner chose to distribute).

**Protocol version:** claim exchanges `protocol`. An owner that does not speak the recipient's version answers 409
`protocol` with the versions it supports; the recipient shows "<owner> needs a WebFloppy update" or "your WebFloppy
needs an update". Every response carries `X-WebFloppy-Share-Protocol: 1`.

### 3.3 Reachability and certificates

The share page tests the instance's own public address (`BETTER_AUTH_URL` / `WEBADF_URL`) from the server: an HTTPS
`GET /api/share/v1/ping` to itself by that address. Hosted: always reachable. Self-hosted: the result is shown, with
a link to the help topic when it fails. The test proves the address resolves and answers from where the server
stands, not from the internet; the help topic says so.

A self-hosted instance using Caddy's internal CA (`tls internal`, the default for a LAN address) has a certificate no
other server trusts. The link then carries the **internal root's SHA-256 fingerprint** (`#pin=<base64url>`), read
from Caddy's data volume by the app container (the implementation adds that read-only mount). The recipient pins
that root for that remote library: the TLS chain must end in exactly that root. Instances with a publicly trusted
certificate (`WEBADF_DOMAIN`, a reverse proxy, a tunnel) produce links without a pin and are verified normally.
The internal root is long-lived (Caddy: 10 years), so pins do not break on leaf renewal.

### 3.4 Screens (owner)

**Settings › Sharing**

- A reachability line: "Your WebFloppy is reachable at https://... ✓" or, in red, why not, with the help link.
- Table of shares: Person · Collections ("Everything" or names) · Status (Waiting to be claimed, until <date> /
  Expired / Claimed by <name> (<url>) / Revoked) · Last used · actions.
- **New share…**: label, collection checkboxes or Everything. Result: the link with Copy, and "It works once. Unclaimed
  links expire on <date>."
- **Edit collections…** and **Revoke…** (confirm: "Rob loses access immediately. Disks Rob has changed stay Rob's.").
  Revoked and expired rows can be deleted from the list.

**Landing page** `/s/<code>` (owner's instance, no sign-in): "<library name> was shared with you. Open your
WebFloppy and paste this link in Remote › Add", plus "Where is your WebFloppy?" (an address field) that sends the
browser to `<address>/remote/add#link=<the link>`. The page never claims the code. The code is in the URL path, so
the page sends `Referrer-Policy: no-referrer` and is not cached.

## 4. Recipient side

### 4.1 Data

`remote_libraries`

| column | notes |
|---|---|
| id | text pk |
| org_id | the recipient's team (the whole team sees it, as with the local library) |
| base_url | the owner instance's origin |
| token_enc | the token, AES-256-GCM with a key derived (HKDF) from `BETTER_AUTH_SECRET`; self-hosters need no new setting |
| tls_pin | the root fingerprint from the link, or null |
| name | the library name from claim / `GET library` |
| status | `ok`, `unreachable`, `ended` (401 revoked / unknown token), `protocol` |
| last_ok_at, last_error, added_at, added_by | |

**Remote disks in drives become ordinary `disks` rows** with two new nullable columns, `remote_library_id` (FK,
cascade only through the explicit removal path in 4.4) and `remote_disk_id`. Such a row is **hidden** from the local
library, search, collections and counts (every library query adds `remote_library_id IS NULL`), and its bytes are
held with an entitlement for the recipient org, so mount, PaulaNET send, write-back and history work unchanged.

### 4.2 Flows

- **Add:** Remote › Add takes the link (pasted, or from `#link=` on `/remote/add`). The server parses origin, code
  and pin, calls `POST claim` (pinned TLS when a pin is given), stores the library, then opens it. Errors in plain
  words: "This link was already used, has expired or was revoked", "Can't reach <host>", "<host> needs an update".
- **Browse:** the recipient's pages call their own server, which calls the share API with the token. Listings are
  cached per remote library for 60 s (in memory / the existing cache layer); covers longer, by ETag.
- **Mount / Send to Amiga:** the server looks up a hidden disk row for (`remote_library_id`, `remote_disk_id`). If
  none, or its sha256 differs from the owner's current one, it fetches `bytes`, checks the sha256 against the ETag,
  stores the blob, creates or updates the hidden row (only while it is still untouched, see D2), then runs the
  existing mount or send. Every mount re-asks the owner, so a disk taken out of scope stops mounting.
- **First write (D2):** when write-back records the first change to a hidden remote disk, the row drops its remote
  columns and MOVES (same disk id) into the recipient's **own copy of the title**: a local game, one per (team,
  remote library, remote title), created in the same transaction from the hidden title's name, year and publisher,
  with a machine metadata source ('filename', so scans may re-identify it) and `games.copied_from` = the remote
  library's name. It shows in the recipient's library, Uncategorized, named as it was. The hidden stand-in title stays
  hidden, so another disk of the same title still mounted from the owner never appears under the own copy; a later
  first write to that disk joins the same own copy. Boards holding the disk follow it (their desired/mounted game id
  becomes the own copy's). The own copy's title page and its disks' files pages say "Your copy of <library name>'s
  library". From then on it is never refreshed from the owner.
- **Download:** streams through the recipient's server (same fetch and check), not cached as a disk row.

### 4.3 Status changes

Any 401 from the owner sets `ended`; repeated network failures set `unreachable` (retried on the next visit); 409
sets `protocol`. An `ended` library shows "Access ended" with only Remove.

### 4.4 Remove and revoke

Remove (the recipient), or the first `ended` answer (the owner revoked): every **hidden** disk row of that library is
ejected from any drive first, then deleted, with its entitlement unless another disk of the org holds the same sha256; the blob is left to the weekly GC's reference rules. Disks that became local
(D2) are untouched. Remove then deletes the `remote_libraries` row; an `ended` library stays listed until removed.

### 4.5 Screens (recipient)

- **Top menu:** Library · **Remote** · Devices · Upload · Help. On the phone, Remote sits with Library.
- **`/remote`:** one card per remote library (name, owner address, collections, status, last answered), Add a shared
  library, Remove…. Empty state explains what remote libraries are and has the Add button.
- **`/remote/[id]`:** the local library's parts, read-only: collections in scope, titles as cards or table with search,
  a title's disks, a disk's files. A "Remote · <name>" marker on every page. Disk actions: Mount in DF0:/DF1:, Send to
  Amiga, Download. No edit, rename, delete, file operations or drag into local collections.

## 5. Security

- **SSRF guard** on every outbound share request (claim, browse, bytes): resolve the host, refuse loopback,
  link-local, private, CGNAT and other non-public ranges, and re-check after redirects (redirects are refused
  outright). On by default on our deployment; **self-hosted instances allow private addresses by default** (two
  instances on one LAN) and `WEBADF_SHARE_PRIVATE_ADDRESSES=0` turns that off. Same rule both sides of parity: the
  setting exists everywhere, only the default differs.
- Responses are size-limited (listings 2 MB, bytes the largest disk kind the app accepts) and time-limited (10 s
  listings, 60 s bytes).
- The owner's API never reveals anything outside scope (404), never accepts writes, and logs each claim and revoke.
- Tokens: hashed at the owner, encrypted at the recipient, never sent to a browser.

## 6. Help

- **"Sharing your library"** (owner): making your WebFloppy reachable (router port forward to 443, reverse proxy,
  Tailscale Funnel, Cloudflare Tunnel; why HTTPS; `WEBADF_DOMAIN` for a trusted certificate; LAN-only sharing with the
  internal certificate and its pin), what recipients can and cannot do, D2 in one sentence, what Revoke does.
- **"Remote libraries"** (recipient): adding a link, what Mount and Send do, that saving to a remote disk makes it
  yours, what "Access ended" means.

`docs/self-hosting.md` gains a short section pointing at the help topic and the new setting.

## 7. Testing

- **Unit:** code and token generation and hashing; claim single use, expiry, replay and the one-answer 404; scope on
  every route (title removed from a collection after sharing → 404; `everything`; empty share); revoke; rate limits;
  SSRF guard ranges, DNS answers and refused redirects; protocol 409; token encryption round trip; pin check.
- **e2e (one server, two orgs):** share → claim → browse → mount (board simulated as in the existing mount specs) →
  write (becomes local, Uncategorized) → change scope → revoke (Access ended, hidden copies gone, the local copy
  stays). Runs over real HTTP to itself.
- **Self-host parity:** the Docker image on the operator's OMV server (172.16.10.11, installed from the command line;
  kept running for later triage) as owner with `tls internal` and a pinned link; the local dev server as recipient;
  then the other way round.
- **Hardware:** one A500 bench run: mount a remote disk, save to it, see it appear as a local Uncategorized disk.

## 8. Out of scope

Writing to the owner's disks; "Add to my library" of untouched disks; a relay for unreachable instances; email
invitations; sharing with individual users of the same team (shares are per team, as libraries are); showing the
recipient's activity to the owner beyond "last used".
