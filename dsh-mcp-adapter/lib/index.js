import { ToolIndex } from './bm25.js';
import { registerBridgeTools } from './tools.js';
import {
  loadPersistentDescriptions,
  savePersistentDescriptions,
  getAllDescriptions,
  DEFAULT_DESCRIPTIONS,
} from './descriptions.js';
import { applySkillMcpPanel } from './skills-viewer.js';

export const name = '@max/dsh-mcp-adapter';
export const inject = ['tools', 'systemPrompt', 'connection', 'typert', 'loader', 'skills', 'sessions', 'agents'];

export { loadPersistentDescriptions, savePersistentDescriptions, getAllDescriptions };

export function apply(ctx, rawConfig = {}) {
  // 1. Initialize Skill & MCP Panel Backend (SkillsViewerGateway + McpManagerGateway + ToolFilter + NestedSkillProvider)
  try {
    applySkillMcpPanel(ctx);
  } catch (err) {
    ctx.logger?.error?.('[dsh-mcp-adapter] Error initializing skill-mcp-panel services:', err);
  }

  // 2. Progressive Disclosure & Intent Routing Configuration
  const fileDescriptions = loadPersistentDescriptions();
  const config = {
    prefix: rawConfig.prefix ?? 'mcp__',
    keep: new Set(rawConfig.keep ?? []),
    serverDescriptions: {
      ...DEFAULT_DESCRIPTIONS,
      ...(rawConfig.serverDescriptions || {}),
      ...fileDescriptions,
    },
    stripMcpInstructions: rawConfig.stripMcpInstructions ?? true,
    stripMcpResourceServers: rawConfig.stripMcpResourceServers ?? true,
  };

  const index = new ToolIndex();
  const deferredToolsMap = new Map();
  const state = {
    deferredCount: 0,
    eagerCount: 0,
    serverCount: 0,
    serverPrompt: '',
  };

  // 3. Register Hermes Bridge tools (tool_search, tool_describe, tool_call)
  const disposeBridgeTools = registerBridgeTools(ctx, index, deferredToolsMap);
  ctx.effect(() => disposeBridgeTools, 'mcp-adapter.bridge');

  // 4. Register Server Overview as a native systemPrompt section
  ctx.systemPrompt.section({
    name: 'mcp-adapter:server-overview',
    order: 3100, // Appears right with external service descriptions
    interpolate: false,
    text: () => state.serverPrompt,
  });

  // 5. Strip unwanted raw MCP instruction sections cleanly via the official assemble waterfall
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    const transformed = await next();
    if (!transformed || !Array.isArray(transformed.sections)) return transformed;

    if (config.stripMcpInstructions || config.stripMcpResourceServers) {
      transformed.sections = transformed.sections.filter((section) => {
        const secName = typeof section.name === 'string' ? section.name : '';
        if (config.stripMcpInstructions && secName.startsWith('mcp:')) {
          return false;
        }
        if (config.stripMcpResourceServers && secName === 'mcp-resource-servers') {
          return false;
        }
        return true;
      });
    }
    return transformed;
  });

  // 6. Source-level tool filtering via standard Executor Decorator pattern
  const toolsService = ctx.tools;
  const currentExecutor = toolsService.selectExecutor();
  const origDescribe = currentExecutor.describe.bind(currentExecutor);

  currentExecutor.describe = function hermesDescribe(tools) {
    const eager = [];
    const deferred = [];

    deferredToolsMap.clear();

    for (const tool of tools) {
      if (tool.name.startsWith(config.prefix) && !config.keep.has(tool.name)) {
        deferred.push(tool);
        deferredToolsMap.set(tool.name, tool);
      } else {
        eager.push(tool);
      }
    }

    // Rebuild BM25 index on deferred tools
    index.build(deferred, config.prefix);
    state.deferredCount = deferred.length;
    state.eagerCount = eager.length;

    // Refresh persistent descriptions from disk / storage
    const currentFileDescriptions = loadPersistentDescriptions();
    const effectiveDescriptions = {
      ...config.serverDescriptions,
      ...currentFileDescriptions,
    };

    // Update Server Summary Prompt
    if (deferred.length > 0) {
      const grouped = new Map();
      for (const d of deferred) {
        const server = d.name.slice(config.prefix.length).split('__')[0] || 'default';
        if (!grouped.has(server)) grouped.set(server, 0);
        grouped.set(server, grouped.get(server) + 1);
      }
      state.serverCount = grouped.size;

      let promptText = '## 外部 MCP 服务能力与调度说明\n';
      promptText += '当前环境挂载了以下外部 MCP 服务。所有具体工具的定义已被折叠以保持提示词纯净。\n';
      promptText += '当任务涉及以下服务描述的场景时，请使用 `tool_search(queries: ["..."])` 搜索具体工具，再按需调用：\n\n';

      for (const [server, count] of grouped.entries()) {
        const desc = effectiveDescriptions[server] || '外部工具服务';
        promptText += `- **[${server}]** (${count} 个工具): ${desc}\n`;
      }
      state.serverPrompt = promptText;
    } else {
      state.serverCount = 0;
      state.serverPrompt = '';
    }

    // Call inner native describe only on eager tools
    const innerResult = origDescribe(eager);

    return {
      schemas: innerResult.schemas,
      // Retain knownNames so internal ordering and existence validation pass smoothly
      knownNames: innerResult.knownNames ?? tools.map((t) => t.name),
    };
  };

  // Ensure clean teardown on HMR / plugin disposal
  ctx.effect(() => () => {
    currentExecutor.describe = origDescribe;
  }, 'mcp-adapter.restore-describe');

  // 7. Register authenticated /api Fetch route using DSH client-connection service
  if (ctx.connection?.fetch?.register) {
    ctx.connection.fetch.register({
      path: '/api/mcp-adapter-descriptions',
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          const allDescs = getAllDescriptions(config.serverDescriptions);
          return Response.json(allDescs);
        }

        if (request.method === 'POST') {
          try {
            const body = await request.json();
            if (body && typeof body === 'object') {
              const current = loadPersistentDescriptions();
              const merged = { ...current, ...body };
              savePersistentDescriptions(merged);
              return Response.json({ ok: true, descriptions: merged });
            }
          } catch (_) {}
          return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
        }

        return new Response(null, { status: 405 });
      },
    });
  }

  // 8. Register /mcp-adapter status command
  if (typeof ctx.inject === 'function') {
    ctx.inject(['commands'], (ccmds) => {
      try {
        ccmds.commands.register({
          name: 'mcp-adapter',
          description: 'View MCP Adapter progressive disclosure status',
          execute: () => {
            const allDescs = getAllDescriptions(config.serverDescriptions);
            const lines = [
              '### MCP Adapter (Progressive Disclosure Mode)',
              `- **Deferred Tools**: ${state.deferredCount} across ${state.serverCount} MCP server(s)`,
              `- **Eager Tools**: ${state.eagerCount}`,
              `- **Prefix**: \`${config.prefix}\``,
              `- **Server Descriptions**: ${Object.keys(allDescs).join(', ') || '(none)'}`,
            ];
            return {
              content: lines.join('\n'),
            };
          },
        });
      } catch (e) {
        ctx.logger?.warn?.('Failed to register /mcp-adapter command:', e);
      }
    });
  }

  ctx.logger?.info?.('[dsh-mcp-adapter] Activated with full Skill & MCP management and progressive disclosure');
}
