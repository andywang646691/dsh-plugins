// Port of Hermes tools/threat_patterns.py (commit 8d7061f).
// Scope is cumulative: "all" ⊂ "context" ⊂ "strict". Memory writes use "strict".

export const MAX_SCAN_CHARS = 65_536;
const F = String.raw`(?:\w+\s+){0,8}`;
const SECRET_VAR = String.raw`\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)S?\b`;
const MODIFY = String.raw`(update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}`;

const PATTERNS = [
  [String.raw`ignore\s+${F}(previous|all|above|prior)\s+${F}instructions`, 'prompt_injection', 'all'],
  [String.raw`system\s+prompt\s+override`, 'sys_prompt_override', 'all'],
  [String.raw`disregard\s+${F}(your|all|any)\s+${F}(instructions|rules|guidelines)`, 'disregard_rules', 'all'],
  [String.raw`act\s+as\s+(if|though)\s+${F}you\s+${F}(have\s+no|don't\s+have)\s+${F}(restrictions|limits|rules)`, 'bypass_restrictions', 'all'],
  [String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, 'html_comment_injection', 'all'],
  [String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, 'hidden_div', 'all'],
  [String.raw`translate\s+[^\n]{0,512}\s+into\s+\w+(?:[\s-]+\w+){0,2}\s+and\s+(execute|run|eval)\b`, 'translate_execute', 'all'],
  [String.raw`do\s+not\s+${F}tell\s+${F}the\s+user`, 'deception_hide', 'all'],

  [String.raw`you\s+are\s+${F}now\s+(?:a|an|the)\s+`, 'role_hijack', 'context'],
  [String.raw`pretend\s+${F}(you\s+are|to\s+be)\s+`, 'role_pretend', 'context'],
  [String.raw`output\s+${F}(system|initial)\s+prompt`, 'leak_system_prompt', 'context'],
  [String.raw`(respond|answer|reply)\s+without\s+${F}(restrictions|limitations|filters|safety)`, 'remove_filters', 'context'],
  [String.raw`you\s+have\s+been\s+${F}(updated|upgraded|patched)\s+to`, 'fake_update', 'context'],
  [String.raw`\bname\s+yourself\s+\w+`, 'identity_override', 'context'],
  [String.raw`register\s+(as\s+)?a?\s*node`, 'c2_node_registration', 'context'],
  [String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, 'c2_heartbeat', 'context'],
  [String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, 'c2_task_pull', 'context'],
  [String.raw`connect\s+to\s+the\s+network\b`, 'c2_network_connect', 'context'],
  [String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, 'forced_action', 'context'],
  [String.raw`only\s+use\s+one[\s\-]?liners?\b`, 'anti_forensic_oneliner', 'context'],
  [String.raw`never\s+${F}(?:create|write)\s+${F}(?:script|file)\s+${F}disk`, 'anti_forensic_disk', 'context'],
  [String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|DSH)\w*`, 'env_var_unset_agent', 'context'],
  [String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, 'known_c2_framework', 'context'],
  [String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, 'c2_explicit', 'context'],
  [String.raw`\bcommand\s+and\s+control\b`, 'c2_explicit_long', 'context'],

  [String.raw`curl\s+[^\n]{0,2048}${SECRET_VAR}`, 'exfil_curl', 'all'],
  [String.raw`wget\s+[^\n]{0,2048}${SECRET_VAR}`, 'exfil_wget', 'all'],
  [String.raw`cat\s+[^\n]{0,2048}(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, 'read_secrets', 'all'],
  [String.raw`(send|post|upload|transmit)\s+[^\n]{0,2048}\s+(to|at)\s+https?://`, 'send_to_url', 'strict'],
  [String.raw`(include|output|print|share)\s+${F}(conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, 'context_exfil', 'strict'],

  [String.raw`authorized_keys`, 'ssh_backdoor', 'strict'],
  [String.raw`(?:\b(?:echo|cat|cp|mv|dd|tee|install|printf|rsync|scp|ln|append|add|write|sed|chmod|chown|truncate|rm|touch|curl|wget|git)\b|\bopen\s*\(|>>?)[^\n]{0,512}(?:\$HOME/\.ssh|~/\.ssh)`, 'ssh_access', 'strict'],
  [String.raw`\$HOME/\.dsh/\.credentials|~/\.dsh/\.credentials`, 'dsh_credentials', 'strict'],
  [String.raw`${MODIFY}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, 'agent_config_mod', 'strict'],
  // Hermes uses an inline (?-i:…) group for the SHOUTY_SNAKE exemption; JS has no inline
  // flag toggles, so that exemption is applied separately in hardcodedSecret().
];

const INVISIBLE = new Set([...'\u200b\u200c\u200d\u2060\u2062\u2063\u2064\ufeff\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069']);
const SCOPES = { all: ['all', 'context', 'strict'], context: ['context', 'strict'], strict: ['strict'] };
const COMPILED = { all: [], context: [], strict: [] };
for (const [src, id, scope] of PATTERNS) {
  for (const s of SCOPES[scope]) COMPILED[s].push([new RegExp(src, 'i'), id]);
}

const SECRET_RE = /(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']([A-Za-z0-9+/=_-]{20,})/gi;
const ENV_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
function hardcodedSecret(text) {
  for (const m of text.matchAll(SECRET_RE)) {
    if (!ENV_NAME_RE.test(m[1])) return true;
  }
  return false;
}

export function scanForThreats(content, scope = 'context') {
  if (!content) return [];
  const patterns = COMPILED[scope];
  if (!patterns) throw new Error(`scanForThreats: unknown scope ${scope}`);
  const text = content.slice(0, MAX_SCAN_CHARS);
  const findings = [];
  for (const ch of new Set(text)) {
    if (INVISIBLE.has(ch)) findings.push(`invisible_unicode_U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  }
  const norm = text.normalize('NFKC');
  for (const [re, id] of patterns) if (re.test(norm)) findings.push(id);
  if (scope === 'strict' && hardcodedSecret(norm)) findings.push('hardcoded_secret');
  return findings;
}

export function firstThreatMessage(content, scope = 'strict') {
  const f = scanForThreats(content, scope);
  if (f.length === 0) return null;
  const id = f[0];
  if (id.startsWith('invisible_unicode_')) {
    return `Blocked: content contains invisible unicode character ${id.replace('invisible_unicode_', '')} (possible injection).`;
  }
  return `Blocked: content matches threat pattern '${id}'. Content is injected into the system prompt and must not contain injection or exfiltration payloads.`;
}
