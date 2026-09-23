# Vendored: Monocypher 4.0.2

- Version: 4.0.2
- Sources: downloaded separately, each into its OWN directory
  (`/tmp/mc-rel` for the release tarball, `/tmp/mc-gh` for the GitHub tag
  archive) so `diff -r` could not compare a directory with itself:
  - https://monocypher.org/download/monocypher-4.0.2.tar.gz
  - https://github.com/LoupVaillant/Monocypher/archive/refs/tags/4.0.2.tar.gz
- Tarball SHA-256 (monocypher-4.0.2.tar.gz, as printed by `shasum -a 256`):
  `38d07179738c0c90677dba3ceb7a7b8496bcfea758ba1a53e803fed30ae0879c`
- Date vendored: 2026-09-23

## Fix round 1: the first cross-check was vacuous

The first pass unpacked both tarballs into the *same* directory. On macOS's
default case-insensitive filesystem, `tar xzf gh.tar.gz`'s `Monocypher-4.0.2/`
landed on top of the already-unpacked `monocypher-4.0.2/` (same name, just a
different case), so `diff -r monocypher-4.0.2/src Monocypher-4.0.2/src`
compared a directory with itself and reported nothing -- which is not the
same thing as the two sources agreeing. The files actually vendored were the
GitHub tag archive's, not the release tarball's whose SHA-256 was recorded
above (visible as `// Monocypher version __git__` in the first line of each
vendored `.c`/`.h`, instead of the release's `// Monocypher version 4.0.2`).

Redone with the two tarballs unpacked into separate directories:

```
$ diff -r /tmp/mc-rel/monocypher-4.0.2/src /tmp/mc-gh/Monocypher-4.0.2/src
diff -r .../mc-rel/.../src/monocypher.c .../mc-gh/.../src/monocypher.c
1c1
< // Monocypher version 4.0.2
---
> // Monocypher version __git__
diff -r .../mc-rel/.../src/monocypher.h .../mc-gh/.../src/monocypher.h
1c1
< // Monocypher version 4.0.2
---
> // Monocypher version __git__
diff -r .../mc-rel/.../src/optional/monocypher-ed25519.c .../mc-gh/.../src/optional/monocypher-ed25519.c
1c1
< // Monocypher version 4.0.2
---
> // Monocypher version __git__
diff -r .../mc-rel/.../src/optional/monocypher-ed25519.h .../mc-gh/.../src/optional/monocypher-ed25519.h
1c1
< // Monocypher version 4.0.2
---
> // Monocypher version __git__

$ diff /tmp/mc-rel/monocypher-4.0.2/LICENCE.md /tmp/mc-gh/Monocypher-4.0.2/LICENCE.md
167a168,173
>
> Special notes
> -------------
>
> The files in `tests/externals/` were placed in the public domain by
> their respective authors.  See the `AUTHORS.md` files in each directory.
```

Only the expected differences: the version-comment line (the release tarball
bakes in the literal version string; the GitHub archive keeps the
placeholder `__git__` because it isn't built through the release process),
and `LICENCE.md`'s extra "Special notes" section, which documents files
under `tests/externals/` that are not part of what is vendored here. Nothing
in the `src/` content itself differs. The two sources agree on everything
that matters; not blocked.

All four vendored source files, and `LICENCE.md`, were then re-copied from
the RELEASE tarball (`/tmp/mc-rel`) to replace the wrongly-GitHub-sourced
copies. Content is otherwise byte-for-byte what the release tarball ships,
under their original file names (nothing was renamed).

Files copied, no modifications beyond copying as-is:
- `src/monocypher.c` -> `monocypher.c`
- `src/monocypher.h` -> `monocypher.h`
- `src/optional/monocypher-ed25519.c` -> `monocypher-ed25519.c`
- `src/optional/monocypher-ed25519.h` -> `monocypher-ed25519.h`
- `LICENCE.md` -> `LICENCE.md`

Unmodified; only `crypto_ed25519_check` (RFC 8032, SHA-512) is used.
