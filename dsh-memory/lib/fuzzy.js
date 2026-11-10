// Reduced port of Hermes tools/fuzzy_match.py: an ordered chain of increasingly permissive
// strategies so whitespace / indentation / typography drift in model-supplied old_string still
// lands on the intended region. Strategies: exact, line-trimmed, whitespace-normalized,
// indentation-flexible, unicode-normalized.

const UNICODE_MAP = [
  [/[\u201c\u201d]/g, '"'], [/[\u2018\u2019]/g, "'"], [/\u2014/g, '--'], [/[\u2013\u2212]/g, '-'],
  [/\u2026/g, '...'], [/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' '],
];
const unicodeNorm = (s) => UNICODE_MAP.reduce((t, [re, r]) => t.replace(re, r), s);

function exactSpans(content, pattern) {
  const out = [];
  if (!pattern) return out;
  let i = 0;
  while ((i = content.indexOf(pattern, i)) !== -1) { out.push([i, i + pattern.length]); i += pattern.length; }
  return out;
}

// Match pattern lines against content lines after a per-line transform; spans cover whole lines.
function lineSpans(content, pattern, transform) {
  const cl = content.split('\n');
  const pl = pattern.split('\n');
  while (pl.length && !pl[0].trim()) pl.shift();
  while (pl.length && !pl[pl.length - 1].trim()) pl.pop();
  if (!pl.length) return [];
  const tp = pl.map(transform);
  const starts = [];
  let pos = 0;
  for (const line of cl) { starts.push(pos); pos += line.length + 1; }
  const out = [];
  for (let i = 0; i + tp.length <= cl.length; i++) {
    let ok = true;
    for (let j = 0; j < tp.length; j++) if (transform(cl[i + j]) !== tp[j]) { ok = false; break; }
    if (ok) {
      const end = starts[i + tp.length - 1] + cl[i + tp.length - 1].length;
      out.push([starts[i], end]);
      i += tp.length - 1;
    }
  }
  return out;
}

const STRATEGIES = [
  ['exact', (c, p) => exactSpans(c, p)],
  ['line_trimmed', (c, p) => lineSpans(c, p, (l) => l.trim())],
  ['whitespace_normalized', (c, p) => lineSpans(c, p, (l) => l.replace(/\s+/g, ' ').trim())],
  ['indentation_flexible', (c, p) => lineSpans(c, p, (l) => l.replace(/^\s+/, ''))],
  ['unicode_normalized', (c, p) => lineSpans(unicodeNorm(c), unicodeNorm(p), (l) => l.replace(/\s+/g, ' ').trim())
    // unicodeNorm can change lengths (— → --): only accept when lengths are unchanged.
    .filter(() => unicodeNorm(c).length === c.length)],
];

export function fuzzyFindAndReplace(content, oldString, newString, replaceAll = false) {
  if (oldString === newString) {
    return { error: 'No edit was applied because old_string and new_string are identical. Provide the existing text to replace in old_string and the changed replacement text in new_string.' };
  }
  if (!oldString) return { error: 'old_string must not be empty.' };
  for (const [name, fn] of STRATEGIES) {
    const spans = fn(content, oldString);
    if (!spans.length) continue;
    if (spans.length > 1 && !replaceAll) {
      return { error: `old_string matched ${spans.length} locations (strategy ${name}). Include more surrounding context so it matches once, or set replace_all.` };
    }
    let out = content;
    for (const [s, e] of [...spans].reverse()) out = out.slice(0, s) + newString + out.slice(e);
    return { content: out, count: spans.length, strategy: name };
  }
  return { error: 'old_string not found in the file (tried exact, line-trimmed, whitespace-normalized, indentation-flexible and unicode-normalized matching). Load the file again and copy the text verbatim.' };
}
