# dsh-context-kit

Save context tokens in DSH. One package, three parts:

| part | what it does |
| --- | --- |
| **context index** (host) | Keeps a small, stable system-prompt section listing the *pointers* that compaction would otherwise erase: recent tool artifacts and touched paths. Summaries lose content, not locations. |
| **preset tuner** (host) | Moves the automatic-compaction trigger earlier — and does it without freezing the agent preset, by regenerating the override from the preset that ships inside the app. |
| **Settings panel** (web) | A Context page: drag the trigger point, apply, preview, remove. No YAML editing. |

Why this combination: compaction is the lever that actually moves the bill. Compacting at 524K instead of
679K avoids re-sending the region above the trigger on every step; the index then makes sure the summary
that replaces that region still tells the model where things are. The two are complementary — the index
alone saves nothing on its own, and earlier compaction alone loses pointers.

## Install

```bash
dsh plugin add dsh-context-kit
```

Restart DSH. You get:

- two host plugins (`context-kit-index`, `context-kit-tuner`),
- a **Settings → Context** page,
- a `preset_tuner` tool,
- a `dsh-context-kit` CLI.

## Panel: Settings → Context

- **Compact at** — the fraction of the context window that triggers compaction (default `0.5` → ~524K).
- **Keep after compact** — how much survives compaction (default `0.16` → ~168K).
- **Save** writes `settings.json`, **Apply to profile** regenerates the profile override, and the page
  tells you to restart. **Preview** shows the exact generated YAML before it is written.
- **Remove override** deletes the managed block and falls back to upstream defaults.

Saving is not the same as applying: the panel never touches YAML until you press Apply, and applying
never happens silently.

Where it stores things:

```
<profile>/dsh-context-kit/settings.json          # what the panel edits
<profile>/dsh-context-kit/usage-cache.json       # parsed session stats, keyed by path+mtime+size
<profile>/cordis.patch.yml                       # managed block: generated, not hand-written
<profile>/dsh-context-kit/backups/               # every overwrite keeps the previous file (last 10)
```

Precedence: `settings.json` wins over the plugin's `config.presets` in the bundle/patch. In practice the
plugin row can stay empty (`presets: {}`) and the panel is the single place where numbers live — the
managed block in `cordis.patch.yml` always reflects what you last applied.

## Effect measurement

The second card in the panel answers "did this actually save anything?" without pretending to know
more than it can.

**Measured** (read from `~/.dsh/sessions/**/session.v4.jsonl.zstd`): steps, cache-hit / cache-miss /
output tokens, compaction count, average and peak context, cost expressed in hit-equivalents
(`miss × 10`, `output × 15`, hit = 1), and a rework signal — repeated identical tool calls, which is
the first sign compaction went too deep.

**Attributed by policy.** A session that compacted at ~712K ran under a different threshold than one
that compacted at ~419K, so the ledger is split by the observed trigger height (bucketed to 8K;
sessions that never compacted are listed as unclassifiable). "Data under the current threshold" tells
you how much of the window was actually produced by the setting you are looking at — it is 0 right
after you change the knobs, and grows from there. Do not read a saving off a window whose current
policy has no data.

**Estimated** (labelled in the UI and in the CLI): the saving versus the shipped default
(`0.8 / 0.16`). It replays your real per-step growth under both policies. It is a model, not a bill:
it assumes the same work happens and the same price ratio, and it does not price lost detail. When
the current threshold has almost no measured steps the panel says so explicitly.

Privacy: local only. The plugin reads session logs, writes a cache next to `settings.json`, and never
sends anything anywhere. The first run decompresses recent sessions (a few seconds); later runs reuse
the cache. The host RPC yields between files so the UI stays responsive.

## Why the tuner exists (the freeze problem)

The live `compaction-basic` instance lives **inside the agent preset**, in a group that is `isolate`d.
A host-level plugin cannot reach that service, and a profile patch row `- id: compaction-basic` targets
an inactive leftover row — it looks right and does nothing.

Overriding a preset row replaces its `config` wholesale, so the only way in is to restate the whole
preset. Hand-writing that copy freezes the preset: from then on you stop receiving upstream preset
updates. The tuner instead reads the preset **out of the running app** (`resources/app.asar`) and
regenerates the restatement:

- upstream text is kept byte for byte,
- your changes are inserted as extra lines only,
- the result lives in a marked managed block,
- after a DSH update the next startup (or `Apply`) regenerates it from the new upstream preset.

Unit tests assert the insertion-only property against the real shipped presets, and a live check reads
this machine's `app.asar` end to end.

## CLI

```bash
dsh-context-kit status
dsh-context-kit set --threshold 0.5 --retain 0.16 --preset cordis
dsh-context-kit sync [--force --mode replace]
dsh-context-kit preview
dsh-context-kit clear
dsh-context-kit report [--days 7]
```

`--resources "<DSH install>/resources"` when it cannot find the app by itself.
`--force --mode replace` is required to take over a hand-written override; without it the tool refuses
and points at the line numbers.

## Tool

```text
preset_tuner(action="status" | "preview" | "sync" | "clear" | "report", days?)
```

`status` is read-only and reports upstream drift; `sync` writes and tells you to restart;
`report` returns the same measured/estimated summary as the panel card.

## Safety

- **Fail closed.** If the upstream preset cannot be located, extracted, or modified safely (renamed
  plugin, changed layout, key already set upstream), nothing is written.
- **Never edits upstream text**, only inserts.
- **Never silently masks upstream values**: a configured key that upstream already sets aborts the sync.
- **Refuses to eat hand-written overrides** unless explicitly forced.
- **Backups + idempotence**: unchanged input writes nothing, so it never creates restart noise.

## What it does not do (yet)

- It does not evict history itself. Batch eviction of old tool results is the next lever; the tuner
  already supports adding a plugin into a preset group, which is where such an evictor has to live to
  see the compaction service.
- The trigger estimate assumes the documented window (`contextWindow` 1048576, `maxOutputTokens` 256000,
  `headroomTokens` 65536). Override them in the plugin config if your model differs.

## Rollback

```bash
dsh-context-kit clear     # then restart
```

Backups remain in `<profile>/dsh-context-kit/backups/`.

## License

MIT
