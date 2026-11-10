# dsh-memory

Hermes-style memory and learning loop for DeepSeek Harness (self-use, unpublished).
Ports Hermes Agent commit `8d7061f`. Design: `/var/lib/dsh/workspace/docs/dsh-memory-plugin-design.md`.

## What it adds

| Piece | Behavior |
|---|---|
| `MEMORY.md` / `USER.md` | `~/agent-memory/memories/`, 2,200 / 1,375 chars, `§`-delimited, threat-scanned |
| Frozen snapshot | Rendered into the system prompt once per session (persisted in `.snapshots/`), refreshed only after compaction |
| `memory` tool | add / patch / remove in one atomic batch, budget checked on the final result |
| Guidance | Hermes "Skills come first" memory guidance + SKILLS_GUIDANCE + mandatory skill-loading rules |
| `skill_manage` tool | create / patch / write_file / remove_file / delete, only under `~/agent-memory/skills/`; fuzzy patch; atomic rollback |
| Skill discovery | A dedicated `skill-filesystem` provider scanning only `~/agent-memory/skills` |
| Background review | Every 10 user turns (memory) / 10 tool iterations (skills), forks a same-model child after the turn, whitelisted tools, 16-step cap, Hermes prompts; fully automatic |
| Curator | Hourly check; weekly when idle ≥2h: agent-created skills go stale at 14d, archived at 30d (never deleted) |
| `session_search` | Hermes 4-shape (discovery / scroll / read / browse) + Obelisk multi-agent bridge; Chinese-capable (FTS5 trigram + LIKE fallback + OR-relaxation); zero LLM calls |

## Layout

```
~/agent-memory/
  memories/MEMORY.md, USER.md
  skills/<name>/SKILL.md, .usage.json, .curator_state, .archive/
  .snapshots/   frozen per-session prompt snapshots
  .index/       session_search SQLite index
  .logs/dsh-memory.log
```

## Config (`cordis.patch.yml` → `dsh-memory`)

`home`, `memoryCharLimit`, `userCharLimit`, `memoryNudgeInterval`, `skillNudgeInterval`,
`backgroundReview`, `curator`, `sessionSearch`, `sectionOrder`. A patch overlay replaces the whole
`config` object, so restate every field you need.

## Develop

- Unit tests: `./test/run.sh`
- Installed into the `web` profile as `link:/var/lib/dsh/plugins/dsh-memory`. After editing code,
  toggle the `include:dsh-memory` entry off and on in Plugins (HMR reload).
- Headless E2E harness: `/var/lib/dsh/dshtest/run.sh` (isolated `DSH_HOME`, profile `memtest`).
