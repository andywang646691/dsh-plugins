// Port of Hermes tools/skill_usage.py: sidecar usage + provenance for skills in the dedicated
// agent skills root. Only `created_by: "agent"` skills (made by background review) are curated.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class SkillUsage {
  constructor(root) { this.path = join(root, '.usage.json'); }

  load() {
    try { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}; } catch { return {}; }
  }

  save(data) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.path);
  }

  update(name, fn) {
    const data = this.load();
    const rec = data[name] || { created_by: 'user', created_at: new Date().toISOString(), use_count: 0, patch_count: 0, state: 'active' };
    fn(rec);
    data[name] = rec;
    this.save(data);
    return rec;
  }

  recordCreated(name, by) { this.update(name, (r) => { r.created_by = by; r.created_at = new Date().toISOString(); r.state = 'active'; }); }
  recordPatched(name) { this.update(name, (r) => { r.patch_count = (r.patch_count || 0) + 1; r.last_patched_at = new Date().toISOString(); }); }
  recordUsed(name) {
    this.update(name, (r) => {
      r.use_count = (r.use_count || 0) + 1;
      r.last_used_at = new Date().toISOString();
      if (r.state === 'stale') r.state = 'active';
    });
  }
  forget(name) { const d = this.load(); delete d[name]; this.save(d); }
}
