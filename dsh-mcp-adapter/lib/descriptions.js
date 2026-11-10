import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const STORAGE_DIR = process.env.DSH_HOME
  ? join(process.env.DSH_HOME, 'storages', 'mcp-adapter')
  : join(homedir(), '.dsh', 'storages', 'mcp-adapter');
const DESCRIPTIONS_FILE = join(STORAGE_DIR, 'descriptions.json');

export const DEFAULT_DESCRIPTIONS = {
  nexusdock: '操作我的电脑和 VPS 服务（当需要管理 Mac 本地或远程 Linux 服务器时使用）。',
};

export function loadPersistentDescriptions() {
  try {
    if (existsSync(DESCRIPTIONS_FILE)) {
      const text = readFileSync(DESCRIPTIONS_FILE, 'utf8');
      return JSON.parse(text);
    }
  } catch (_) {}
  return {};
}

export function savePersistentDescriptions(data) {
  try {
    mkdirSync(STORAGE_DIR, { recursive: true });
    writeFileSync(DESCRIPTIONS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

export function getAllDescriptions(extraConfig = {}) {
  return {
    ...DEFAULT_DESCRIPTIONS,
    ...(extraConfig || {}),
    ...loadPersistentDescriptions(),
  };
}
