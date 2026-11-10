# dsh-repot

**Carry a DSH environment from one machine to another.**

The name is "repot": lift the plant with its root ball intact into a new pot. Plugins, configuration and folders travel through one private GitHub / Gitee repository; on the way back, every write must land on the expected path or it is refused.

[中文说明](README.zh.md) · [Install](#install) · [First run](#first-run) · [Why paths cannot drift](#why-paths-cannot-drift) · [Limitations](#limitations)

---

## What it carries

| Category | Carried | How |
|---|---|---|
| Plugins (registry install) | yes | `name@version` only by default; reinstall on restore, tarball optional |
| Plugins (`file:` linked source) | yes | the source tree travels, restored as a relative spec |
| Plugins (`file:` pointing at a tgz) | yes | the tarball travels as-is |
| Configuration | yes | `cordis.patch.yml` / `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` |
| Folders | yes | a snapshot of the chosen directories, with a path anchor |
| Sessions / tasks | no | sessions are zstd-appended logs; wrong shape and size for git |
| Credentials | no | the PAT never leaves the local credentials service |
| Runtimes | no | `dsh-runtimes` is per-machine |
| Caches | no | `storages`, `.plugin-manager/asar-out` are rebuildable |

Commits, branches and graphs are not here — better-sidebar's **Git** tab owns those.

## Install

```bash
dsh plugin --profile <your profile> add dsh-repot
```

Or install from the marketplace and restart DSH.

Two entry points appear:

- **Settings → Environment carry** — platform, token, repository, sync roots
- **Sidebar → Repot** — upload / compare / apply

Without better-sidebar the settings page also hosts the actions.

## First run

1. **Create a repository** (private is fine) and fill in `owner/repo` and the branch. All three sets use it by default; to split them (plugins on Gitee, files on GitHub) name a per-set repository under **Per-set repositories** and leave the rest empty to inherit.
2. **Paste a Personal Access Token.** Not your DSH password. GitHub needs `repo`; Gitee needs repository read/write. It is stored in the credentials service and never read back over HTTP.
3. **Register sync roots** — the anchors that survive a machine change:

| id | path |
|---|---|
| `work` | `D:\work` |
| `plugins` | `C:\Users\you\.dsh\plugins` |

At most three, never a drive root (`D:\`), the folder must exist, and roots may not nest. The `id` stays; the path is re-pointed on the new machine — that is the only thing you re-enter.

4. Pick what to carry in the sidebar and press **Upload**.
5. On the other machine: install the plugin, enter the same repository and token, register roots, press **Compare**, then **Apply**.

## The three buttons

| Button | Effect | Risk |
|---|---|---|
| **Upload** | writes the selected content to the repository, one commit | remote only |
| **Compare** | reads the remote manifest and diffs it against this machine | read-only |
| **Apply** | writes to this machine | **changes local files**, needs confirmation |

Folder restores raise a preflight dialog that lists every absolute path about to be written.

## Why paths cannot drift

Each folder entry records three things:

```
absPath   D:/work/notes       absolute path on the source machine
rootId    work                a registered root
relPath   notes               path inside that root
```

Restore resolves in order:

| Level | Condition | Behaviour |
|---|---|---|
| 1 | `absPath` exists here | use it |
| 2 | `rootId` + `relPath` exists here | relocate |
| 3 | neither exists | create, after you confirm it |

Every level then faces four hard refusals:

1. the target must be inside a registered root — blocks `..` escapes
2. the nearest existing ancestor must still realpath inside that root — blocks junction escapes
3. an existing target without this plugin's marker is refused — a directory you filled yourself is never eaten
4. a content hash mismatch is refused

Pruning only removes files recorded by the previous marker, so your own additions survive. Before anything is overwritten or deleted, the previous content is copied to `<profile>/.repot/backup/<stamp>/files/<id>/`, and a file you edited since the last restore is never overwritten and never pruned — it is reported as a conflict and left exactly as you left it.

## Folder diffs

A folder has no version number, so identity is the hash of its files. Two layers:

- the manifest records one tree hash per folder, which is what "same or different" compares
- every folder index (`files/<id>/.repot-index.json`) records a hash per file, which is what "which file" answers

Comparison therefore lists the actual files:

```
notes          +2 ~0 −0
  + plan.md
  + src/todo.ts
assets         +0 ~2 −1
  ~ logo.svg
  ~ tokens/colors.json
  − old-banner.png
```

`+` the remote added it, `~` both have it with different content, `−` the remote no longer has it (a restore removes it, unless you edited it locally).

Indexes written by an older version have no per-file hashes; those folders fall back to the tree-level verdict and say so.


## Three plugin shapes

| Shape | Stored | Restored by |
|---|---|---|
| registry | `name@version` (default, near zero bytes) | `installBundle('name@version')` |
| registry + carry | the tarball | download, then `installBundle(tgz)` |
| `file:` source | the source tree | materialise under `<profile>/plugins/<name>` |

Anything above 20 MB defaults to reinstall; `dsh-boot-suite` ships tens of megabytes of video and audio, so carrying it is a choice, not a default.

`file:D:/...` specs are rewritten to `file:./plugins/<name>` on restore.

## Safety boundaries

- The PAT lives only in the credentials service; not in settings, responses, or commit messages.
- Every request passes `ctx.connection.requestRejection`; cross-origin calls get 403.
- Configuration restores back up the previous file to `<profile>/.repot/backup/<stamp>/`; folder restores do the same for every file they replace or delete, under `backup/<stamp>/files/<id>/`.
- A file whose content no longer matches what this plugin last wrote is treated as *yours*: the restore skips it and reports it instead of reverting your edit.
- Remote branch updates use `force: false`; a moved branch is reported, not overwritten.

## Limitations

- **No session/task sync** — wrong shape and size for git.
- **Gitee writes file-by-file** — no dependable tree endpoint, so large sets are slow and deletions cannot ride the same commit.
- **No three-way merge** — conflicts are refused and reported, never guessed. Fix a conflict by taking the local file out of the way (or restoring it) and comparing again.
- **A folder is all-or-nothing** — the list shows individual files, but the tick is per folder; there is no "apply just this one file".
- **Comparison reads the folder** — hashes come from the bytes, so comparing a 500 MB folder costs 500 MB of reads (it does not hold them in memory).
- No multi-repository parallel work, submodules, or LFS.
- The marketplace requires a repository at least one day old; a brand-new repository is held, not rejected.

## Relationship to dsh-plugin-git-sync

dsh-repot supersedes it. On first start it reads `<profile>/.git-sync/settings.json` and the `GIT_SYNC_*` credentials once, migrates them, and leaves the old files untouched so a rollback still works. Do not enable both.

## License

MIT
