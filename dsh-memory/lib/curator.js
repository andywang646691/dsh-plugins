// Port of the deterministic part of Hermes agent/curator.py: inactivity-triggered lifecycle
// transitions for agent-created skills. Never deletes — archives into skills/.archive/.
// LLM consolidation is off by default in Hermes (consolidate: False) and is not implemented.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULTS = { intervalHours: 24 * 7, minIdleHours: 2, staleAfterDays: 14, archiveAfterDays: 30 };
const DAY = 86_400_000;

export class Curator {
  constructor({ root, usage, config = {} }) {
    this.root = root;
    this.usage = usage;
    this.cfg = { ...DEFAULTS, ...config };
    this.statePath = join(root, '.curator_state');
  }

  loadState() {
    try { return existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : {}; } catch { return {}; }
  }
  saveState(s) { mkdirSync(this.root, { recursive: true }); writeFileSync(this.statePath, JSON.stringify(s, null, 2)); }

  /** Hermes should_run_now: the first observation seeds last_run_at without running. */
  shouldRun(now = Date.now()) {
    const s = this.loadState();
    if (s.paused) return false;
    if (!s.last_run_at) { this.saveState({ ...s, last_run_at: new Date(now).toISOString(), run_count: s.run_count || 0 }); return false; }
    return now - Date.parse(s.last_run_at) >= this.cfg.intervalHours * 3_600_000;
  }

  /** apply_automatic_transitions: active → stale (14d) → archived (30d), agent-created only. */
  applyTransitions(now = Date.now()) {
    const data = this.usage.load();
    const summary = { stale: [], archived: [], reactivated: [] };
    for (const [name, rec] of Object.entries(data)) {
      if (rec.created_by !== 'agent' || rec.pinned || rec.state === 'archived') continue;
      const dir = join(this.root, name);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      // Never-active skills anchor on created_at so they don't self-archive.
      const last = Date.parse(rec.last_used_at || rec.created_at || '') || now;
      const idleDays = (now - last) / DAY;
      // use_count == 0 is absence of evidence: never archive a never-used skill younger than stale_after_days.
      if ((rec.use_count || 0) === 0 && idleDays < this.cfg.staleAfterDays) {
        if (rec.state === 'stale') { rec.state = 'active'; summary.reactivated.push(name); }
        continue;
      }
      if (idleDays >= this.cfg.archiveAfterDays) {
        const archive = join(this.root, '.archive');
        mkdirSync(archive, { recursive: true });
        let dest = join(archive, name);
        if (existsSync(dest)) dest = `${dest}-${now}`;
        renameSync(dir, dest);
        rec.state = 'archived'; rec.archived_at = new Date(now).toISOString(); rec.archived_path = dest;
        summary.archived.push(name);
      } else if (idleDays >= this.cfg.staleAfterDays) {
        if (rec.state !== 'stale') { rec.state = 'stale'; summary.stale.push(name); }
      } else if (rec.state === 'stale') {
        rec.state = 'active'; summary.reactivated.push(name);
      }
    }
    this.usage.save(data);
    return summary;
  }

  /** maybe_run_curator: gate on interval + idle, run transitions, persist state. */
  maybeRun({ idleForMs, now = Date.now() } = {}) {
    if (!this.shouldRun(now)) return null;
    if (idleForMs !== undefined && idleForMs < this.cfg.minIdleHours * 3_600_000) return null;
    const summary = this.applyTransitions(now);
    const s = this.loadState();
    this.saveState({ ...s, last_run_at: new Date(now).toISOString(), run_count: (s.run_count || 0) + 1, last_run_summary: summary });
    return summary;
  }
}
