# Self-hosting webadf with Docker

One folder, one `.env`, one command. The stack runs your own copy of webadf: the web app, its Postgres, a
scheduler for the weekly clean-ups, and Caddy for HTTPS. Everything it stores lives in one data folder you can
copy.

## 1. Requirements

- Docker Engine with a current Compose v2 (`docker compose version`; the old `docker-compose` v1 is not supported). Docker Desktop works on macOS and Windows.
- A 64-bit Intel/AMD (amd64) or ARM (arm64) host.
- At least 1 GB free on the disk that holds the data folder (the app refuses to start below that, and warns below 5 GB).
  A disk image is 880 KB; history and a big library want more.
- A way to reach the host on port 443 (or the port you choose) from the computers and boards that use it.

## 2. Install

Make a folder and download two files into it, from the newest release. Releases are the `web-X.Y.Z` tags: look up
the newest one at <https://github.com/stefanskotte/webadf/tags> (only the `web-*` tags; the `fw-*` ones are board
firmware, and so is GitHub's "latest release") and put it in place of `web-X.Y.Z` below
(take them from a release, not from master: master's `compose.yaml` may already expect an image that is not released).

```bash
mkdir webadf && cd webadf
TAG=web-X.Y.Z   # the newest release tag, e.g. as shown on the releases page
curl -fsSLO https://raw.githubusercontent.com/stefanskotte/webadf/$TAG/compose.yaml
curl -fsSL https://raw.githubusercontent.com/stefanskotte/webadf/$TAG/.env.example -o .env
```

If `curl` is not installed (openmediavault and other minimal hosts), use `wget` instead:

```bash
wget -O compose.yaml https://raw.githubusercontent.com/stefanskotte/webadf/$TAG/compose.yaml
wget -O .env https://raw.githubusercontent.com/stefanskotte/webadf/$TAG/.env.example
```

Edit `.env` and set two values:

- `WEBADF_URL`: the https address you will open webadf at, for example `https://192.168.1.10` or `https://nas.lan`.
  The port people type must match `WEBADF_HTTPS_PORT` (443 unless you change it).
  For a public DNS name that points at this host, leave `WEBADF_URL` empty and set `WEBADF_DOMAIN=amiga.example.org`
  instead: Caddy then gets a Let's Encrypt certificate (port 443 must be reachable from the internet).
- `WEBADF_ADMIN_EMAIL`: the first admin.

Start it:

```bash
docker compose up -d
docker compose logs app | grep 'first admin'
```

The log line is `webadf: Sign up as the first admin (use you@example.org): https://192.168.1.10/sign-up?invite=ABCD2345`.
Open that link and sign up **with exactly that email address**. That is what makes the account the super-admin. Registration is
by invitation only; the super-admin invites everybody else from `/admin`.

The first start creates the data folder (`./data`, or `WEBADF_DATA_DIR`) with:

| Path | What |
| --- | --- |
| `postgres/` | the database |
| `blobs/` | disk images, covers, uploads |
| `backups/` | database dumps taken before a migration (section 5) |
| `secrets/` | `pg_password`, `better_auth_secret`, `cron_secret` (mode 0600). Keep them with the data: a new `better_auth_secret` signs everybody out, a new `pg_password` locks you out of the database. |
| `caddy/` | the generated `Caddyfile` and Caddy's certificates |

Other `.env` settings: `WEBADF_DATA_DIR`, `WEBADF_HTTPS_PORT`, `WEBADF_IMAGE_TAG`, `SUPERADMIN_EMAILS` (comma separated;
defaults to `WEBADF_ADMIN_EMAIL`) and `BLOB_GC_DELETE`.

Image tags: `latest` is the newest release (the `web-X.Y.Z` tags), `edge` is every build of master. Set
`WEBADF_IMAGE_TAG` to pin one.

Changing `WEBADF_URL` later: edit `.env` and run `docker compose up -d`. Caddy watches its Caddyfile and picks the
new address up without being restarted.

## 3. Certificates

Unless you use `WEBADF_DOMAIN`, Caddy signs the certificate with its own internal CA, so browsers warn on first visit.
Either accept the warning, or trust the CA once. Its root certificate is:

```
$WEBADF_DATA_DIR/caddy/caddy/pki/authorities/local/root.crt        (default: ./data/caddy/caddy/pki/authorities/local/root.crt)
```

- macOS: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain root.crt`
- Windows: open `certmgr.msc`, Trusted Root Certification Authorities, Certificates, All Tasks, Import, pick `root.crt`.
- Linux (Debian/Ubuntu): `sudo cp root.crt /usr/local/share/ca-certificates/webadf.crt && sudo update-ca-certificates`
  (Firefox keeps its own store: import it in Settings, Certificates.)

Opening the site by another name or address of the same host (its IP when `WEBADF_URL` names it, or the other way
round) still reaches webadf: Caddy answers with the certificate made for the host in `WEBADF_URL`, so the browser also
warns that the name does not match, and the app logs once per such address that sign-in and uploads need
`WEBADF_URL` to be the address you open (section 8). With `WEBADF_DOMAIN` only that domain is served: other names
and the bare IP fail the TLS handshake, because Caddy asks Let's Encrypt for no name it was not given.

## 4. Boards

A board talks to the server named in its firmware. To point one at your own copy, open its USB serial console
(firmware 1.13.0 or newer) and type:

```
wf server set https://192.168.1.10
wf server tls noverify
YES
wf reboot
```

- `wf server set https://host[:port]` stores the server (port 443 when left out). The board forgets its old pairing,
  so pair it again. It refuses while a disk is mounted: eject first.
- `wf server tls noverify` makes the board accept any certificate for that server (a board cannot trust Caddy's
  internal CA). The firmware asks `noverify accepts ANY certificate for this server -- type YES to confirm`; answer `YES`.
  With a public `WEBADF_DOMAIN` certificate you can skip this and keep the default `wf server tls verify`.
- `wf reboot` applies the change. `wf server show` prints the current server and TLS mode, and `wf server clear`
  returns to the default.

Then pair the board from **Devices** in the web app as usual.

## 5. Upgrade

```bash
docker compose pull && docker compose up -d
```

When a release's notes say `compose.yaml` changed, first download that release's `compose.yaml` over yours (as in
section 2, with the new tag), then run the two commands above.

On start the app applies any pending database migration. **Only when one is pending** it first writes a dump to
`$WEBADF_DATA_DIR/backups/<time>-before-<migration>.dump` (mode 0600):

```
webadf: migrations: backing up to /data/backups/20261015T195458Z-before-0038_device_server.dump before 1 pending
webadf: migrations: applied 0038_device_server
```

- The newest 5 backups are kept.
- A backup for the same migration younger than 24 hours is reused instead of taking another, so a migration that
  keeps failing and restarting does not push your older backups out. Not once a start has succeeded since (going
  back to the previous image, which then took writes): every successful start touches `backups/.last-start`, and
  only a backup newer than that is reused.
- A failed migration leaves the schema unchanged and names its backup: `migration failed in <tag> (...); the schema is unchanged; backup: <path>`.
  Go back to the previous image (`WEBADF_IMAGE_TAG`) while you report it.
- With nothing pending the log says `migrations: up to date` and no backup is taken.

## 6. Backup and restore

**Whole install** (simplest, and it includes the secrets): stop the stack first, so the database files are consistent,
then copy the whole data folder. Use `sudo`: on Linux `postgres/` belongs to the database user (mode 0700) and
`secrets/` is mode 0600, so a normal user cannot read them.

```bash
docker compose down
sudo cp -a data /somewhere/safe/webadf-data-$(date +%F)
docker compose up -d
```

Restore (the stack must be stopped; `data` here is your data folder and `/path/to/webadf-data-DATE` the copy):

```bash
docker compose down
sudo mv data data.broken-$(date +%F)          # keep it until the restore is confirmed, do not rm -rf
sudo cp -a /path/to/webadf-data-DATE data     # data/ must not exist now, or cp copies INTO it
docker compose up -d
```

`data/postgres` must sit directly under `data/`. Same paths and owners: do not `chown` it. Once the site works,
delete `data.broken-*`.

**A database dump** (the files in `backups/`, or one you take yourself). Take one:

```bash
docker compose exec -T db pg_dump -U webadf -d webadf --format=custom > webadf.dump
```

Restore one. Stop the writers first, restore, start again:

```bash
docker compose stop app scheduler
docker compose exec -T db pg_restore -U webadf -d webadf --clean --if-exists --single-transaction < webadf.dump
docker compose up -d
```

The files in `data/backups/` are mode 0600 and owned by uid 1000, so from the host read them with sudo:
`sudo cat data/backups/<file>.dump | docker compose exec -T db pg_restore -U webadf -d webadf --clean --if-exists --single-transaction`.

A good restore prints nothing and exits 0. `--clean --if-exists` drops what is there and recreates it;
`--single-transaction` means a failure changes nothing. A dump holds the database only; disk images live in
`blobs/`, so copy that folder too. **Restoring an older dump next to a newer `blobs/`** is safe (extra files are
cleaned up by the weekly clean-up), but **restoring a newer dump next to an older `blobs/`** leaves disks whose
files are missing.

**Weekly clean-up.** A scheduler container runs the jobs Vercel cron runs for our own deployment (library scan,
Demozoo, blob clean-up). It only runs while the stack is up: a slot missed while the host was off runs at the next
slot, and the blob clean-up is weekly, so that can be up to a week later. The blob clean-up deletes blobs nothing
references; set `BLOB_GC_DELETE=0` in `.env` to make it only report them.

## 7. Postgres major upgrade

Never automatic. The stack runs Postgres 18. When a release moves to a newer major, `setup` refuses to start on the
old data and says so (section 8). To move:

1. With the **old** stack still up and its `compose.yaml` in place, stop the writers and dump:
   `docker compose stop app scheduler`, then
   `docker compose exec -T db pg_dump -U webadf -d webadf --format=custom > upgrade.dump`.
2. `docker compose down`, then move the old cluster aside: `sudo mv data/postgres data/postgres.old`.
3. Download the new release's `compose.yaml` over the old one (the Postgres version is pinned in that file;
   `docker compose pull` only refreshes the images the current file names), then
   `docker compose pull && docker compose up -d db`. It starts an empty Postgres 18 and `setup` no longer refuses.
   The password is still the one in `secrets/pg_password`.
4. `docker compose exec -T db pg_restore -U webadf -d webadf --clean --if-exists --single-transaction < upgrade.dump`
   (prints nothing, exits 0), then `docker compose up -d`.
5. Keep `data/postgres.old` until you are satisfied.

## 8. Troubleshooting

Start-up problems print one line starting `webadf:`; read them with `docker compose logs setup app`.

| Message | Fix |
| --- | --- |
| `Set WEBADF_URL in .env to the address you open webadf at, e.g. https://192.168.1.10 (or set WEBADF_DOMAIN to a public DNS name)` | Fill it in `.env`. |
| `WEBADF_URL must start with https:// (Caddy serves TLS), got "..."` | Use an https address. |
| `WEBADF_URL says port N but WEBADF_HTTPS_PORT is M -- make them the same` | The port you type is the port Caddy publishes: make both agree. |
| `WEBADF_URL and WEBADF_DOMAIN disagree ... -- set only WEBADF_DOMAIN` | Set one of them. |
| `WEBADF_DOMAIN needs WEBADF_HTTPS_PORT=443` | Let's Encrypt checks on port 443. |
| `Set WEBADF_ADMIN_EMAIL in .env (it becomes the first admin)` | Fill it in `.env`. |
| `only N GB free on the data folder: webadf needs at least 1 GB` | Free space, or set `WEBADF_DATA_DIR` on a bigger disk. |
| `blobs is not writable by uid 1000: run sudo chown -R 1000:1000 "$WEBADF_DATA_DIR/blobs"` (same for `backups`) | Run the command. `setup` fixes ownership itself when it can; it cannot on, for example, an NFS share that squashes root. |
| `data/postgres holds a Postgres N cluster this image cannot use (the image is Postgres 18)`, or `holds a Postgres cluster this image cannot use (no 18/ folder ...)` | `data/postgres` holds an older major's cluster, or a cluster mounted at the old path (`PG_VERSION` directly inside). Section 7. |
| `db` restarts in a loop; its log says `mkdir: cannot create directory '/var/lib/postgresql': Permission denied` | The data folder's permissions or ACL give new directories no execute bit for other (default on openmediavault shared folders), so Postgres (uid 999) cannot enter it. `setup` now fixes `data/postgres` itself; if it persists, run `sudo chmod 755 <data>/postgres <data>/postgres/18`. |
| `the database refuses the password in secrets/pg_password` | `data/postgres` was created by another install. Restore that install's `secrets/` folder, or start with an empty `data/postgres`. |
| `secrets/<name> is missing -- run docker compose up -d` | The `setup` service creates it; do not start `app` by hand. |
| `secrets/<name> is empty -- restore it from a backup of the data folder` | A new secret would sign everybody out (or lock the database), so none is made for you. |
| `the database has a migration newer than this image` | You are running an older image than the data: set `WEBADF_IMAGE_TAG` to the newer one. |
| `migration failed in <tag> (...); the schema is unchanged; backup: <path>` | Section 5. |
| `backup failed (...); nothing was migrated` | Usually a full disk. Free space; the migration is retried on the next start. |
| `requests arrive as https://x but WEBADF_URL is https://y -- uploads and sign-in will fail; set WEBADF_URL to the address you open` | You opened the site by a different name or IP than `WEBADF_URL`. It still loads (with a certificate warning for the other name), but sign-in and uploads check the origin. Set `WEBADF_URL` to the address you use and run `docker compose up -d` (logged once per host). |
| `Too many requests. Please try again later.` at sign-up or sign-in | The sign-in endpoints allow 3 attempts per 10 seconds from one address. Wait ten seconds. |

**Somebody else signed up first.** The first-admin invite is for `WEBADF_ADMIN_EMAIL`, but anybody holding the link can
use it. Once any account exists, no new bootstrap invite is made. Recover with:

- If an existing super-admin is signed in: invite the right person from `/admin`.
- If nobody is super-admin: set `SUPERADMIN_EMAILS=<email of an account that exists>` in `.env` (it overrides the
  default of `WEBADF_ADMIN_EMAIL`), run `docker compose up -d`, sign in with that account, and invite from `/admin`.

## 9. What a new install fetches by itself

A fresh install is not empty. The scheduler container runs the same jobs as our own deployment, and the image
carries what cannot be fetched:

- **Firmware releases.** Daily, from the GitHub releases of the firmware repository, each verified with the boards'
  signing key before it is accepted. Boards are offered updates as on webadf.vercel.app. A release's notes and its
  "security" and "TEST build" marks are not signed, so whoever can edit those GitHub releases could mark a release
  "TEST build" (hidden from everyone on a self-host) or "security".
- **The PaulaNET driver disk.** Included in the image and stored on first start; the download and the Network mode
  of a board's DF1 work. Its licence is in `THIRD-PARTY-NOTICES.md`.
- **TOSEC.** Monthly, the newest release's Amiga ADF DATs from tosecdev.org. The result shows on `/admin/scan`, and
  the manual DAT upload there still works.
- **Demozoo.** Weekly, from Demozoo's public export.
- **OpenRetro.** Not fetched: upload FS-UAE Launcher's `Amiga.sqlite` at `/admin/scan` (run the Launcher once; find
  `Amiga.sqlite` in FS-UAE's data folder). Cover images are then fetched politely, one at a time.

These requests name your install in their User-Agent (`webadf/1.0 (Amiga disk library; +<WEBADF_URL>)`). Everything
else (library, uploads, history, devices, mounting) works as on our own deployment.
