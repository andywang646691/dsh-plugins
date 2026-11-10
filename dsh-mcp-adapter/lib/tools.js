import { defineTool } from '@deepseek-ai/dsh-tools';
import { randomUUID } from 'node:crypto';

export function registerBridgeTools(ctx, index, deferredToolsMap) {
  const disposers = [];

  // 1. tool_search
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'tool_search',
        description:
          'Search the deferred MCP tools catalog using semantic queries or intent keywords. ' +
          'Returns matching tool names, descriptions, and required argument keys.',
        parameters: {
          queries: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Array of search queries, e.g. ["execute command on remote server", "manage sessions"]',
          },
          limit: {
            type: 'number',
            description: 'Max results per query (default 5, max 20)',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args) {
          const limit = Math.min(Math.max(args.limit || 5, 1), 20);
          const results = {};
          for (const query of args.queries || []) {
            if (typeof query === 'string' && query.trim()) {
              results[query] = index.search(query.trim(), limit);
            }
          }
          return {
            results,
            tip: 'Use tool_describe(names: [...]) to fetch full parameter JSON Schemas, or call directly with tool_call(calls: [...]).',
          };
        },
      })
    )
  );

  // 2. tool_describe
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'tool_describe',
        description: 'Fetch the full parameter JSON Schema and details for one or more deferred tools.',
        parameters: {
          names: {
            type: 'array',
            items: { type: 'string' },
            required: true,
            description: 'Array of exact tool names, e.g. ["mcp__nexusdock__exec_command"]',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        async execute(args, exec) {
          const tools = {};
          const notFound = [];

          for (const name of args.names || []) {
            let tool = deferredToolsMap.get(name);
            if (!tool && ctx.tools.get) {
              tool = ctx.tools.get(name, exec?.agent);
            }

            if (tool) {
              tools[name] = {
                description: tool.description,
                parameters: tool.parameters,
              };
            } else {
              notFound.push(name);
            }
          }

          return {
            tools,
            ...(notFound.length > 0 ? { notFound } : {}),
          };
        },
      })
    )
  );

  // 3. tool_call (with Hermes call-unwrapping into session events and UI tree)
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'tool_call',
        description: 'Invoke one or more deferred tools. Provide an array of calls: [{ name, arguments }].',
        parameters: {
          calls: {
            type: 'array',
            required: true,
            description: 'Array of tool invocations to run',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true, description: 'The exact deferred tool name' },
                arguments: { type: 'object', required: true, additionalProperties: true, description: 'JSON arguments for the tool' },
              },
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
          },
          render: (_args, value) => {
            // Render unrolled results cleanly in tool row
            const parts = [];
            for (const item of value.results || []) {
              const header = item.success ? `✓ [${item.name}]` : `✗ [${item.name}] (failed)`;
              const body = typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? item.error, null, 2);
              parts.push({
                type: 'text',
                text: `${header}\n${body}`,
              });
            }
            return parts.length > 0 ? parts : [{ type: 'text', text: JSON.stringify(value, null, 2) }];
          },
        },
        async execute(args, exec) {
          const results = [];
          const session = exec?.agent?.session;
          const rootCallId = exec?.callId;

          for (const call of args.calls || []) {
            if (!call || typeof call.name !== 'string') {
              results.push({ success: false, error: 'Invalid call entry: missing name' });
              continue;
            }

            // Always resolve the real executable Tool instance from the registry
            let tool = null;
            if (ctx.tools.get) {
              tool = ctx.tools.get(call.name, exec?.agent, exec?.toolSet)
                || ctx.tools.get(call.name, exec?.agent)
                || ctx.tools.get(call.name);
            }
            if (!tool && ctx.tools.executable) {
              tool = ctx.tools.executable(call.name, exec?.agent, exec?.toolSet)
                || ctx.tools.executable(call.name, exec?.agent)
                || ctx.tools.executable(call.name);
            }

            if (!tool) {
              results.push({
                name: call.name,
                success: false,
                error: `Tool "${call.name}" is not registered or unavailable.`,
              });
              continue;
            }

            const subCallId = randomUUID();
            const rawArgsString = JSON.stringify(call.arguments || {});

            // Hermes Unwrapping Step A: Emit sub-call start event so UI tool-tree unfolds the concrete tool card
            if (session && typeof session.append === 'function' && rootCallId) {
              try {
                session.append('tool/ptc-dispatch-start', {
                  rootCallId,
                  parentCallId: rootCallId,
                  subCallId,
                  name: call.name,
                  arguments: rawArgsString,
                });
              } catch (_) {}
            }

            try {
              const toolArgs = call.arguments || {};
              const res = await tool.execute(toolArgs, exec);

              results.push({
                name: call.name,
                success: true,
                result: res,
              });

              // Hermes Unwrapping Step B: Emit sub-call completion event so UI updates with exact outcome
              if (session && typeof session.append === 'function' && rootCallId) {
                try {
                  const content = [{
                    type: 'text',
                    text: typeof res === 'string' ? res : JSON.stringify(res, null, 2),
                  }];
                  session.append('tool/ptc-dispatch', {
                    rootCallId,
                    parentCallId: rootCallId,
                    subCallId,
                    name: call.name,
                    arguments: rawArgsString,
                    isError: false,
                    content,
                  });
                } catch (_) {}
              }
            } catch (err) {
              const errMsg = err?.message || String(err);
              results.push({
                name: call.name,
                success: false,
                error: errMsg,
              });

              // Hermes Unwrapping Step C: Emit sub-call error event
              if (session && typeof session.append === 'function' && rootCallId) {
                try {
                  session.append('tool/ptc-dispatch', {
                    rootCallId,
                    parentCallId: rootCallId,
                    subCallId,
                    name: call.name,
                    arguments: rawArgsString,
                    isError: true,
                    content: [{ type: 'text', text: `Error: ${errMsg}` }],
                    error: {
                      name: err?.name || 'ToolError',
                      code: err?.code || 'tool_failed',
                      reason: errMsg,
                    },
                  });
                } catch (_) {}
              }
            }
          }

          return { results };
        },
      })
    )
  );

  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose();
    }
  };
}
