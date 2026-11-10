/**
 * BM25 index with Hermes-style Rarest-Token filtering.
 */
function stem(word) {
  if (word.length <= 3) return word;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3);
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2);
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  const tokens = [];
  const normalized = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const words = normalized.split(/[^a-z0-9_\u4e00-\u9fa5]+/);

  for (const w of words) {
    if (!w) continue;
    if (/[\u4e00-\u9fa5]/.test(w)) {
      for (let i = 0; i < w.length; i++) {
        tokens.push(w[i]);
        if (i < w.length - 1) tokens.push(w.slice(i, i + 2));
      }
    } else if (w.length > 1) {
      tokens.push(stem(w));
      tokens.push(w);
    }
  }
  return tokens;
}

export class ToolIndex {
  constructor() {
    this.docs = [];
    this.docFreq = new Map();
    this.avgDocLength = 0;
  }

  build(tools, prefix = 'mcp__') {
    this.docs = [];
    this.docFreq.clear();
    let totalLength = 0;

    for (const tool of tools) {
      const name = tool.name;
      let server = 'default';
      if (name.startsWith(prefix)) {
        server = name.slice(prefix.length).split('__')[0] || 'default';
      }

      const description = tool.description || '';
      const firstLineDesc = description.split('\n')[0].trim().slice(0, 100);
      const properties = tool.parameters?.properties || {};
      const paramNames = Object.keys(properties);
      const requiredParams = tool.parameters?.required || [];

      const indexText = `${name} ${server} ${description} ${paramNames.join(' ')}`;
      const tokens = tokenize(indexText);

      const doc = {
        name,
        server,
        description: firstLineDesc,
        requiredParams,
        tokens,
        length: tokens.length,
      };

      this.docs.push(doc);
      totalLength += doc.length;

      const uniqueTokens = new Set(tokens);
      for (const t of uniqueTokens) {
        this.docFreq.set(t, (this.docFreq.get(t) || 0) + 1);
      }
    }

    this.avgDocLength = this.docs.length > 0 ? totalLength / this.docs.length : 1;
  }

  search(query, limit = 5) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0 || this.docs.length === 0) return [];

    let rarestToken = null;
    let minFreq = Infinity;
    for (const t of queryTokens) {
      const freq = this.docFreq.get(t);
      if (freq !== undefined && freq > 0 && freq < minFreq) {
        minFreq = freq;
        rarestToken = t;
      }
    }

    let candidates = this.docs;
    if (rarestToken !== null) {
      const filtered = this.docs.filter((d) => d.tokens.includes(rarestToken));
      if (filtered.length > 0) candidates = filtered;
    }

    const N = this.docs.length;
    const k1 = 1.5;
    const b = 0.75;
    const scored = [];

    for (const doc of candidates) {
      let score = 0;
      let matchedCount = 0;

      for (const qt of queryTokens) {
        const tf = doc.tokens.filter((t) => t === qt).length;
        if (tf > 0) {
          matchedCount++;
          const df = this.docFreq.get(qt) || 1;
          const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
          const num = tf * (k1 + 1);
          const denom = tf + k1 * (1 - b + b * (doc.length / this.avgDocLength));
          score += idf * (num / denom);
        }
      }

      const minMatches = queryTokens.length >= 4 ? 2 : 1;
      if (matchedCount >= minMatches) {
        scored.push({ doc, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ doc }) => ({
      name: doc.name,
      server: doc.server,
      description: doc.description,
      required: doc.requiredParams,
    }));
  }

  getDocs() {
    return this.docs;
  }

  count() {
    return this.docs.length;
  }
}
