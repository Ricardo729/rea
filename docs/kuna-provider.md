# Kuna provider

[Kuna](https://github.com/Noelo-Lab/kuna) is an Apache-2.0 decompiler distributed as one `kuna` executable. REA uses a `kuna` you supply. It does not download, install, update or bundle Kuna. REA verified this provider with Kuna 1.833; it accepts other releases and reports them as unverified in `rea doctor` and in each analysis profile.

Kuna is static: it reads the selected image and never executes it.

## Configure

```bash
export REA_KUNA_COMMAND=/absolute/path/to/kuna
rea doctor --provider kuna
```

Select it explicitly with `--provider kuna`, MCP's `open_binary.provider_id: "kuna"`, or `REA_ANALYSIS_PROVIDER=kuna`. With Kuna and another provider configured for the same target, `auto` reports `ambiguous` instead of choosing one.

| Setting                       | Default                                                                 | Meaning                                                                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REA_KUNA_COMMAND`            | none (required)                                                         | Absolute path of the `kuna` executable.                                                                                                                                                  |
| `REA_KUNA_CACHE_DIR`          | `~/Library/Caches/rea/kuna` (macOS), `$XDG_CACHE_HOME/rea/kuna` (Linux) | Absolute directory REA owns for project exports. Kuna's own spec cache also lives here, not in your Kuna cache.                                                                          |
| `REA_KUNA_CACHE_MAX_BYTES`    | 4 GiB                                                                   | Size cap; least recently used exports are evicted above it.                                                                                                                              |
| `REA_KUNA_PROJECT_TIMEOUT_MS` | 30 minutes                                                              | Deadline for one project export.                                                                                                                                                         |
| `REA_KUNA_TIMEOUT_MS`         | 120 s                                                                   | Deadline for one single-function decompile.                                                                                                                                              |
| `REA_KUNA_JOBS`               | 1                                                                       | `decompile-project --jobs`. 1 is Kuna's reference answer; more jobs finish sooner but lose callee-first prototypes, and change about 40–60% of function bodies on the measured binaries. |

Windows is not supported yet. Supported targets are ELF and thin Mach-O executables for x86-64, AArch64 and ARM; PE and universal Mach-O are rejected with a typed reason.

## What Kuna answers

| Tool                                                        | Source                                                                                                                    |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `list_procedures`, `search_procedures`, `procedure_address` | Kuna's callable inventory (`kuna functions --json`), including import slots it does not decompile                         |
| `address_name`                                              | Function entries, then the data labels Kuna's export assigns                                                              |
| `procedure_pseudo_code`, `batch_decompile`                  | The project export, or a single-function run while the export builds                                                      |
| `procedure_assembly`                                        | The project export's labeled listing                                                                                      |
| `analyze_function`                                          | Pseudocode and assembly from the export; callers, callees, references, comments, strings and CFG are declared unavailable |

Cross-references, callers, callees and basic blocks are not available from this provider. Use another provider when you need them.

## How answers are produced

The first analysis request in a session looks for this target's export in the cache. The export is keyed by the target's SHA-256, the Kuna executable's SHA-256, its version and `--jobs`.

- **Warm cache:** every answer comes from the verified export. Re-reading the cached files' digests costs tens of milliseconds the first time a session uses them.
- **Cold cache:**
  - REA starts `kuna decompile-project` in the background on a private copy of the target.
  - Meanwhile, pseudocode comes from one `kuna decompile --addr` run, and listings from `kuna functions --json`.
  - Assembly and data names wait for the export; progress notifications report the wait every ten seconds.
  - A single-function answer says so in its limitations. It lacks the export's whole-program prototypes, so a later request can return different text for the same function.

Each answer's `raw_result.source` records where it came from: `single-function`, or `project-export` with the cache directory, file, byte span and the file's SHA-256. Agents can open or search the export's `.c` and `.asm` there directly when that is cheaper than calling a tool per function. Text read that way is target-derived, like any decompiler output, but it bypasses the untrusted-content marker that REA's tool results carry.

The background export belongs to the session. `close_binary`, or the end of a CLI command, cancels it unless another session still waits for it. A one-shot CLI decompile therefore answers from a single-function run; any request that needs the export, such as `procedure_assembly` or `analyze_function`, keeps it.

## Provenance and limitations

- Addresses and bytes are Kuna's observations of the image. Procedure entries and extents are its derivations: extents are upper bounds clipped at the next entry, and Kuna can split one function at an entry its own analysis infers. Pseudocode is its reconstruction, never original source.
- Pseudocode and assembly are exact Kuna text; text from Kuna and from another provider is not comparable as equal or different.
- Results are re-read rather than replayed from REA's analysis snapshots, because a cold answer can differ from the export's.

## Cache ownership

REA writes Kuna's exports only inside `REA_KUNA_CACHE_DIR`:

- `projects/<key>/` holds published, immutable exports with a manifest of file digests.
- `staging/` holds builds in progress.
- `trash/` holds evicted exports awaiting removal.
- `home/` is Kuna's HOME.

Builds publish by one rename, so a reader sees a complete export or none. A damaged or edited export is removed and rebuilt. Staging left by a Kuna process REA could not prove stopped is marked and never removed automatically. `rea doctor --provider kuna` reports the cache directory without creating it.

## Verify with a real Kuna

```bash
REA_KUNA_COMMAND=/absolute/path/to/kuna npm run verify:kuna
```

The lane compiles a small source-owned fixture with the host C compiler and verifies the MCP workflow end to end. `--targets DIR --functions a,b` adds caller-built binaries, and `--compare-ghidra` (with `GHIDRA_INSTALL_DIR`) runs the same functions through Ghidra. See [testing](testing.md#kuna-lane) for coverage.
