// Port of Hermes tools/skill_manager_tool.py (commit 8d7061f), scoped to ONE dedicated skills
// root (~/agent-memory/skills). Skills elsewhere (DSH bundled, ~/.dsh/skills, project skills)
// are read-only to this tool. Batches are atomic: any failure restores every touched file.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync, cpSync } from 'node:fs';
import { join, resolve, relative, sep, dirname } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { fuzzyFindAndReplace } from './fuzzy.js';

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 500; // aligned with DSH catalog display ceiling (DEFAULT_CATALOG_DESCRIPTION_MAX_LENGTH)
export const MAX_SKILL_CONTENT_CHARS = 100_000;
export const MAX_SKILL_FILE_BYTES = 1_048_576;
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/; // DSH skill-name grammar (stricter than Hermes)
const ALLOWED_SUBDIRS = new Set(['references', 'templates', 'scripts', 'assets']);

export const SKILL_MANAGE_DESCRIPTION =
  "Create, update or delete skills: your procedural memory for recurring tasks. The call is an " +
  "operations array (a single edit is a list of one); it applies atomically — any failure rolls " +
  "every touched skill back. Ops: create (full SKILL.md; lands in the dedicated agent skills " +
  "directory; must precede that skill's other ops), patch (targeted old_string/new_string fix — " +
  "preferred; content alone REPLACES the whole file, load it via the skill tool first), " +
  "write_file/remove_file (supporting files), delete (sole op only). Only skills in the agent " +
  "skills directory can be modified; others are read-only. " +
  `Description: max ${MAX_DESCRIPTION_LENGTH} chars, 'Use when <trigger>. <behavior>.'. Write ` +
  "lessons, not logs: imperative rule + why, no PR numbers/dates/incident narration, one rule per " +
  "lesson, references/ named by topic (extend before adding).";

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}

export function validateName(name) {
  if (!name) return 'Skill name is required.';
  if (typeof name !== 'string') return 'Skill name must be a string.';
  if (name.length > MAX_NAME_LENGTH) return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  if (!NAME_RE.test(name)) return `Invalid skill name '${name}'. Use lowercase letters, digits and single hyphens (kebab-case), e.g. 'deploy-vercel'.`;
  return null;
}

export function parseFrontmatter(content) {
  const text = content.replace(/^\ufeff/, '');
  if (!text.startsWith('---')) return { error: 'SKILL.md must start with YAML frontmatter (---). See existing skills for format.' };
  const m = /\n---\s*\n/.exec(text.slice(3));
  if (!m) return { error: "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line." };
  let data;
  try { data = parseYaml(text.slice(3, m.index + 3)); } catch (e) { return { error: `YAML frontmatter parse error: ${e.message}` }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'Frontmatter must be a YAML mapping (key: value pairs).' };
  const body = text.slice(m.index + 3 + m[0].length);
  return { data, body };
}

export function validateSkillMd(content, expectedName) {
  if (!content || !content.trim()) return 'Content cannot be empty.';
  if (content.length > MAX_SKILL_CONTENT_CHARS) return `SKILL.md exceeds ${MAX_SKILL_CONTENT_CHARS.toLocaleString('en-US')} characters (${content.length.toLocaleString('en-US')}). Move depth into references/ files.`;
  const fm = parseFrontmatter(content);
  if (fm.error) return fm.error;
  for (const f of ['name', 'description']) if (!(f in fm.data)) return `Frontmatter must include '${f}' field.`;
  if (String(fm.data.name) !== expectedName) return `Frontmatter name '${fm.data.name}' must equal the skill name '${expectedName}'.`;
  const desc = String(fm.data.description);
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    return `Description is ${desc.length} chars (exceeds ${MAX_DESCRIPTION_LENGTH}-char DSH catalog display ceiling). To prevent silent truncation of routing triggers in the skill catalog, descriptions must be ≤ ${MAX_DESCRIPTION_LENGTH} chars. Move detail into the skill body or references/.`;
  }
  if (!fm.body.trim()) return 'SKILL.md must have a body after the frontmatter.';
  return null;
}

function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') return 'file_path is required.';
  if (filePath.startsWith('/') || filePath.includes('\\') || /^[A-Za-z]:/.test(filePath)) return `file_path must be RELATIVE to the skill directory (e.g. 'references/api.md'), got '${filePath}'.`;
  const parts = filePath.split('/');
  if (parts.some((p) => p === '..' || p === '' || p === '.')) return `file_path '${filePath}' must not contain '..', '.' or empty segments.`;
  if (parts.length < 2 || !ALLOWED_SUBDIRS.has(parts[0])) return `file_path must start with one of: ${[...ALLOWED_SUBDIRS].map((d) => d + '/').join(', ')} (got '${filePath}').`;
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.root dedicated agent skills directory
 * @param {(name:string)=>boolean} [opts.existsElsewhere] whether a skill with this name lives in another (read-only) root
 * @param {object} [opts.usage] SkillUsage instance
 */
export class SkillManager {
  constructor({ root, existsElsewhere = () => false, usage = null }) {
    this.root = resolve(root);
    this.existsElsewhere = existsElsewhere;
    this.usage = usage;
  }

  dirOf(name) { return join(this.root, name); }
  skillMdOf(name) { return join(this.dirOf(name), 'SKILL.md'); }
  exists(name) { return existsSync(this.skillMdOf(name)); }

  list() {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter((n) => !n.startsWith('.') && existsSync(join(this.root, n, 'SKILL.md')));
  }

  /**
   * Apply an operations batch atomically.
   * @param {object[]} operations
   * @param {object} ctx { origin: 'foreground'|'background_review', hasRead?: (name, filePath?) => boolean }
   */
  apply(operations, ctx = { origin: 'foreground' }) {
    if (!Array.isArray(operations) || operations.length === 0) return { success: false, error: 'operations must be a non-empty array.' };
    if (operations.length > 20) return { success: false, error: 'At most 20 operations per call.' };
    const background = ctx.origin === 'background_review';
    if (operations.some((o) => o?.action === 'delete') && operations.length > 1) {
      return { success: false, error: "delete must be the only operation in its call." };
    }
    const snapshots = new Map(); // abs path -> previous content | null (absent)
    const snap = (p) => { if (!snapshots.has(p)) snapshots.set(p, existsSync(p) ? readFileSync(p) : null); };
    const createdDirs = [];
    const results = [];
    const created = new Set();
    try {
      for (const [i, raw] of operations.entries()) {
        const op = raw || {};
        const pos = `Operation ${i + 1} (${op.action || 'unknown'}${op.name ? ` ${op.name}` : ''})`;
        const nameErr = validateName(op.name);
        if (nameErr) throw new Error(`${pos}: ${nameErr}`);
        const name = op.name;
        const dir = this.dirOf(name);
        const md = this.skillMdOf(name);
        const mine = this.exists(name) || created.has(name);
        if (op.action !== 'create' && !mine) {
          if (this.existsElsewhere(name)) throw new Error(`${pos}: skill '${name}' is not in the agent skills directory (${this.root}); it is read-only to skill_manage. Suggest the change to the user instead.`);
          throw new Error(`${pos}: skill '${name}' does not exist. Create it first.`);
        }
        const needsRead = background && ['patch', 'remove_file', 'write_file'].includes(op.action) && !created.has(name);
        switch (op.action) {
          case 'create': {
            if (mine) throw new Error(`${pos}: skill '${name}' already exists. Patch it instead.`);
            if (this.existsElsewhere(name)) throw new Error(`${pos}: a skill named '${name}' already exists in another skills directory. Choose a different name or patch that one's owner.`);
            const content = String(op.content ?? '');
            const v = validateSkillMd(content, name);
            if (v) throw new Error(`${pos}: ${v}`);
            if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); createdDirs.push(dir); }
            snap(md); atomicWrite(md, content);
            created.add(name);
            results.push({ action: 'create', name, message: `Skill '${name}' created.` });
            break;
          }
          case 'patch': {
            const filePath = op.file_path;
            if (filePath !== undefined && filePath !== 'SKILL.md') {
              const fe = validateFilePath(filePath); if (fe) throw new Error(`${pos}: ${fe}`);
            }
            const target = filePath && filePath !== 'SKILL.md' ? join(dir, filePath) : md;
            if (needsRead && ctx.hasRead && !ctx.hasRead(name, filePath && filePath !== 'SKILL.md' ? filePath : undefined)) {
              throw new Error(`${pos}: read-before-write: load '${name}'${filePath && filePath !== 'SKILL.md' ? ` file ${filePath} with read` : ' with the skill tool'} during this review before modifying it, then retry once.`);
            }
            if (!existsSync(target)) throw new Error(`${pos}: ${filePath || 'SKILL.md'} does not exist in skill '${name}'.`);
            const before = readFileSync(target, 'utf8');
            let after;
            if (op.old_string === undefined && op.content !== undefined) {
              after = String(op.content); // whole-file rewrite (last resort)
            } else {
              const r = fuzzyFindAndReplace(before, String(op.old_string ?? ''), String(op.new_string ?? ''), !!op.replace_all);
              if (r.error) throw new Error(`${pos}: ${r.error}`);
              after = r.content;
            }
            if (target === md) { const v = validateSkillMd(after, name); if (v) throw new Error(`${pos}: patched SKILL.md is invalid: ${v}`); }
            else if (Buffer.byteLength(after) > MAX_SKILL_FILE_BYTES) throw new Error(`${pos}: file exceeds 1 MiB.`);
            snap(target); atomicWrite(target, after);
            results.push({ action: 'patch', name, file: filePath || 'SKILL.md', message: `Patched ${filePath || 'SKILL.md'} of '${name}'.` });
            break;
          }
          case 'edit': {
            if (needsRead && ctx.hasRead && !ctx.hasRead(name)) throw new Error(`${pos}: read-before-write: load '${name}' with the skill tool during this review first.`);
            const content = String(op.content ?? '');
            const v = validateSkillMd(content, name); if (v) throw new Error(`${pos}: ${v}`);
            snap(md); atomicWrite(md, content);
            results.push({ action: 'edit', name, message: `Rewrote SKILL.md of '${name}'.` });
            break;
          }
          case 'write_file': {
            const fe = validateFilePath(op.file_path); if (fe) throw new Error(`${pos}: ${fe}`);
            const target = join(dir, op.file_path);
            if (needsRead && existsSync(target) && ctx.hasRead && !ctx.hasRead(name, op.file_path)) {
              throw new Error(`${pos}: read-before-write: read the existing ${op.file_path} during this review before overwriting it.`);
            }
            const text = String(op.file_content ?? '');
            if (Buffer.byteLength(text) > MAX_SKILL_FILE_BYTES) throw new Error(`${pos}: file exceeds 1 MiB.`);
            snap(target); atomicWrite(target, text);
            results.push({ action: 'write_file', name, file: op.file_path, message: `Wrote ${op.file_path} in '${name}'.` });
            break;
          }
          case 'remove_file': {
            const fe = validateFilePath(op.file_path); if (fe) throw new Error(`${pos}: ${fe}`);
            const target = join(dir, op.file_path);
            if (!existsSync(target)) throw new Error(`${pos}: ${op.file_path} does not exist in '${name}'.`);
            if (needsRead && ctx.hasRead && !ctx.hasRead(name, op.file_path)) throw new Error(`${pos}: read-before-write: read ${op.file_path} during this review before removing it.`);
            snap(target); rmSync(target);
            results.push({ action: 'remove_file', name, file: op.file_path, message: `Removed ${op.file_path} from '${name}'.` });
            break;
          }
          case 'delete': {
            if (background) throw new Error(`${pos}: background review must never delete a skill. Mention overlap in your reply instead; the curator handles consolidation.`);
            rmSync(dir, { recursive: true, force: true });
            results.push({ action: 'delete', name, message: `Skill '${name}' deleted.` });
            break;
          }
          default:
            throw new Error(`${pos}: unknown action. Use create, patch, write_file, remove_file or delete.`);
        }
      }
    } catch (e) {
      for (const [p, prev] of [...snapshots.entries()].reverse()) {
        try { if (prev === null) rmSync(p, { force: true }); else writeFileSync(p, prev); } catch {}
      }
      for (const d of createdDirs.reverse()) try { rmSync(d, { recursive: true, force: true }); } catch {}
      return { success: false, error: `${e.message} No operations were applied (batch is all-or-nothing).` };
    }
    if (this.usage) {
      for (const r of results) {
        if (r.action === 'create') this.usage.recordCreated(r.name, background ? 'agent' : 'user');
        else if (r.action === 'delete') this.usage.forget(r.name);
        else this.usage.recordPatched(r.name);
      }
    }
    return { success: true, results, note: 'Skill changes saved. New or renamed skills appear in the catalog on the next request.' };
  }
}
