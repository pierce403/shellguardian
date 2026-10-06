# GLib compatibility backport

This directory is the unmodified published `glib 0.18.5` crate with the two-line
runtime fix from [gtk-rs-core PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343)
and a ShellGuardian regression test. Original license/copyright files are retained.

Original crate archive SHA-256:
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`.
The original archive was verified against Cargo.lock before extraction.

[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) /
[GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g) describes
an immutable pointer incorrectly passed as a mutable C out-argument. The fix makes
the local pointer mutable and passes `&mut p`. No API or other runtime code changes.

The registry fix starts at GLib 0.20. Tauri's current GTK 3 stack requires 0.18;
raising the dependency to 0.20 does not satisfy that interface's version range.
The root `[patch.crates-io]` uses this local copy consistently throughout the graph.
No package version was falsified and no vulnerability alert is manually dismissed.
Version-only scanners may still identify the old version; consult this patch and
its optimized regression evidence. Remove the backport when the full desktop
dependency graph has a compatible patched upstream release.

Verify the affected path with optimizations enabled:

```bash
cargo test --manifest-path vendor/glib/Cargo.toml --release --test shellguardian_variant
```

Use the Linux pkg-config environment from `docs/development.md` when headers are
not installed globally. Do not format or mechanically rewrite this third-party
snapshot. Maintain any further edits as explicit upstream-derived patches.
