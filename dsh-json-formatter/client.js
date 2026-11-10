// Client plugin for @max/dsh-json-formatter
// Integrates with Better Sidebar (ctx.betterSidebar) to provide JSON formatting,
// key sorting, minifying, escaping/unescaping, smart auto-fix, and interactive tree view.

function __dsh_json_formatter_factory(require) {
  const React = require('react');
  const { createElement: h, useState, useEffect, useMemo, useRef, useCallback } = React;

  // Design Tokens helper: inline styles using DSH CSS variables
  const theme = {
    bgBase: 'var(--dsw-alias-bg-base, #1e1e20)',
    bgLayer1: 'var(--dsw-alias-bg-layer-1, #18181a)',
    bgLayer2: 'var(--dsw-alias-bg-layer-2, #222225)',
    bgLayer3: 'var(--dsw-alias-bg-layer-3, #2a2a2e)',
    borderL1: 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08))',
    borderL2: 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.15))',
    labelPrimary: 'var(--dsw-alias-label-primary, #ffffff)',
    labelSecondary: 'var(--dsw-alias-label-secondary, #a1a1aa)',
    labelTertiary: 'var(--dsw-alias-label-tertiary, #71717a)',
    hoverBg: 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06))',
    activeBg: 'var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.12))',
    primary: 'var(--dsw-alias-state-business-primary, #3b82f6)',
    done: 'var(--dsw-alias-state-done-primary, #a855f7)',
    warn: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
    error: 'var(--dsw-alias-state-error-primary, #ef4444)',
    fontMono: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
  };

  // SVG Icons
  function JsonIcon({ size = 16 }) {
    return h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      style: { flexShrink: 0 }
    }, [
      h('path', { key: 'p1', d: 'M4 6c0-1.1.9-2 2-2h1c.6 0 1 .4 1 1v2c0 .6.4 1 1 1h1c.6 0 1 .4 1 1s-.4 1-1 1h-1c-.6 0-1 .4-1 1v2c0 .6-.4 1-1 1H6c-1.1 0-2-.9-2-2V6z' }),
      h('path', { key: 'p2', d: 'M20 6c0-1.1-.9-2-2-2h-1c-.6 0-1 .4-1 1v2c0 .6-.4 1-1 1h-1c-.6 0-1 .4-1 1s.4 1 1 1h1c.6 0 1 .4 1 1v2c0 .6.4 1 1 1h1c1.1 0 2-.9 2-2V6z' }),
      h('circle', { key: 'c', cx: 12, cy: 12, r: 1, fill: 'currentColor' })
    ]);
  }

  // ── JSON Utilities ─────────────────────────────────────────────────────────

  function calculateLineCol(text, pos) {
    if (pos == null || pos < 0) return { line: 1, col: 1 };
    const prefix = text.slice(0, pos);
    const lines = prefix.split('\n');
    return {
      line: lines.length,
      col: lines[lines.length - 1].length + 1
    };
  }

  function parseJsonWithDiagnostics(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) {
      return { ok: true, data: null, isEmpty: true };
    }
    try {
      const data = JSON.parse(trimmed);
      return { ok: true, data, isEmpty: false };
    } catch (err) {
      let line = 1;
      let col = 1;
      const posMatch = err.message.match(/at position (\d+)/i) || err.message.match(/column (\d+)/i);
      const lineMatch = err.message.match(/line (\d+)/i);

      if (posMatch) {
        const pos = parseInt(posMatch[1], 10);
        const lc = calculateLineCol(trimmed, pos);
        line = lc.line;
        col = lc.col;
      } else if (lineMatch) {
        line = parseInt(lineMatch[1], 10);
      }

      return {
        ok: false,
        error: err.message,
        line,
        col
      };
    }
  }

  function sortObjectKeysRecursively(obj) {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(sortObjectKeysRecursively);
    }
    const sorted = {};
    const keys = Object.keys(obj).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      sorted[key] = sortObjectKeysRecursively(obj[key]);
    }
    return sorted;
  }

  function smartFixJsonText(rawText) {
    let text = rawText || '';
    // 1. Convert Python literals: None -> null, True -> true, False -> false
    text = text.replace(/\bNone\b/g, 'null');
    text = text.replace(/\bTrue\b/g, 'true');
    text = text.replace(/\bFalse\b/g, 'false');

    // 2. Remove trailing commas before } or ]
    text = text.replace(/,(\s*[}\]])/g, '$1');

    // 3. Convert single-quoted keys and strings: 'key': 'value' -> "key": "value"
    // Handle single quotes safely
    text = text.replace(/([{,]\s*)'([^'\\]*(?:\\.[^'\\]*)*)'\s*:/g, '$1"$2":');
    text = text.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ':"$1"');
    text = text.replace(/\[\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, '["$1"');
    text = text.replace(/,\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ',"$1"');

    // 4. Wrap unquoted keys: { foo: 1 } -> { "foo": 1 }
    text = text.replace(/([{,]\s*)([a-zA-Z0-9_$@#-]+)\s*:/g, '$1"$2":');

    return text;
  }

  function escapeJsonString(text) {
    return JSON.stringify(text || '');
  }

  function unescapeJsonString(text) {
    const trimmed = (text || '').trim();
    if (!trimmed) return '';
    try {
      // If it's wrapped in quotes, JSON.parse unescapes one layer of quotes
      let unescaped = trimmed;
      if (unescaped.startsWith('"') && unescaped.endsWith('"')) {
        unescaped = JSON.parse(unescaped);
      } else {
        // Replace common escaped sequences
        unescaped = unescaped.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
      return unescaped;
    } catch {
      return text.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
  }

  // ── Tree View Component ────────────────────────────────────────────────────

  function JsonTreeNode({ name, value, path = '$', defaultExpanded = true, onCopyPath, depth = 0 }) {
    const [expanded, setExpanded] = useState(defaultExpanded && depth < 2);
    const [copied, setCopied] = useState(false);

    const isArray = Array.isArray(value);
    const isObject = value !== null && typeof value === 'object';
    const isExpandable = isObject;

    const handleCopyPath = (e) => {
      e.stopPropagation();
      onCopyPath(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };

    const handleToggle = (e) => {
      e.stopPropagation();
      if (isExpandable) {
        setExpanded(!expanded);
      }
    };

    let countBadge = null;
    if (isArray) {
      countBadge = `[${value.length}]`;
    } else if (isObject) {
      countBadge = `{${Object.keys(value).length}}`;
    }

    return h('div', {
      style: {
        fontSize: '13px',
        lineHeight: '22px',
        fontFamily: theme.fontMono,
        marginLeft: depth > 0 ? '16px' : '0px',
        borderLeft: depth > 0 ? `1px solid ${theme.borderL1}` : 'none',
        paddingLeft: depth > 0 ? '8px' : '0px',
        marginTop: '2px'
      }
    }, [
      // Row header
      h('div', {
        key: 'header',
        onClick: handleToggle,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          cursor: isExpandable ? 'pointer' : 'default',
          borderRadius: '4px',
          padding: '1px 4px',
          userSelect: 'none',
          transition: 'background 0.15s'
        },
        onMouseEnter: (e) => { e.currentTarget.style.background = theme.hoverBg; },
        onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; }
      }, [
        // Arrow toggle
        isExpandable
          ? h('span', {
              key: 'arrow',
              style: {
                display: 'inline-block',
                width: '14px',
                textAlign: 'center',
                color: theme.labelTertiary,
                fontSize: '11px',
                transform: expanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.15s'
              }
            }, '▶')
          : h('span', { key: 'spacer', style: { width: '14px' } }),

        // Key Name
        name !== undefined && h('span', {
          key: 'name',
          style: {
            color: theme.labelSecondary,
            fontWeight: 500
          }
        }, `${name}: `),

        // Value or Badge
        isExpandable
          ? h('span', {
              key: 'badge',
              style: {
                color: theme.primary,
                fontSize: '11px',
                fontWeight: 600,
                padding: '0 5px',
                borderRadius: '4px',
                background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 12%, transparent)'
              }
            }, countBadge)
          : renderPrimitiveValue(value),

        // Copy Path action
        h('span', {
          key: 'copy',
          onClick: handleCopyPath,
          title: `复制 JSONPath (${path})`,
          style: {
            marginLeft: 'auto',
            fontSize: '10px',
            padding: '1px 6px',
            borderRadius: '4px',
            color: copied ? theme.done : theme.labelTertiary,
            background: copied ? 'color-mix(in srgb, var(--dsw-alias-state-done-primary, #a855f7) 15%, transparent)' : 'transparent',
            cursor: 'pointer',
            opacity: copied ? 1 : 0.6
          }
        }, copied ? '✓ 已复制路径' : path)
      ]),

      // Children when expanded
      isExpandable && expanded && h('div', {
        key: 'children',
        style: { display: 'flex', flexDirection: 'column' }
      }, isArray
        ? value.map((item, index) => h(JsonTreeNode, {
            key: index,
            name: index,
            value: item,
            path: `${path}[${index}]`,
            defaultExpanded,
            onCopyPath,
            depth: depth + 1
          }))
        : Object.entries(value).map(([k, v]) => h(JsonTreeNode, {
            key: k,
            name: k,
            value: v,
            path: `${path}.${k}`,
            defaultExpanded,
            onCopyPath,
            depth: depth + 1
          }))
      )
    ]);
  }

  function renderPrimitiveValue(value) {
    if (value === null) {
      return h('span', { style: { color: theme.labelTertiary, fontStyle: 'italic' } }, 'null');
    }
    if (typeof value === 'boolean') {
      return h('span', { style: { color: theme.done, fontWeight: 600 } }, String(value));
    }
    if (typeof value === 'number') {
      return h('span', { style: { color: theme.warn } }, String(value));
    }
    if (typeof value === 'string') {
      return h('span', {
        style: {
          color: theme.primary,
          wordBreak: 'break-all'
        }
      }, `"${value}"`);
    }
    return h('span', { style: { color: theme.labelSecondary } }, String(value));
  }

  // ── Main Workbench View ────────────────────────────────────────────────────

  function JsonWorkbenchTab({ ctx, scope, tab, initialContent = '' }) {
    const [rawText, setRawText] = useState(initialContent || '{\n  "name": "dsh-json-formatter",\n  "status": "active",\n  "version": 1,\n  "features": [\n    "format",\n    "minify",\n    "sort-keys",\n    "tree-view",\n    "smart-fix"\n  ]\n}');
    const [viewMode, setViewMode] = useState('text'); // 'text' | 'tree'
    const [indentSize, setIndentSize] = useState(2); // 2 | 4 | 'tab'
    const [statusToast, setStatusToast] = useState(null);
    const [filePath, setFilePath] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    const showToast = (msg, tone = 'info') => {
      setStatusToast({ msg, tone });
      setTimeout(() => setStatusToast(null), 2500);
    };

    const diagnostics = useMemo(() => {
      return parseJsonWithDiagnostics(rawText);
    }, [rawText]);

    const handleFormat = useCallback(() => {
      if (!diagnostics.ok) {
        showToast(`格式化失败: 第 ${diagnostics.line} 行语法错误`, 'error');
        return;
      }
      if (diagnostics.isEmpty) return;
      const indent = indentSize === 'tab' ? '\t' : indentSize;
      const formatted = JSON.stringify(diagnostics.data, null, indent);
      setRawText(formatted);
      showToast('已格式化', 'done');
    }, [diagnostics, indentSize]);

    const handleMinify = useCallback(() => {
      if (!diagnostics.ok) {
        showToast('JSON 解析错误，无法压缩', 'error');
        return;
      }
      if (diagnostics.isEmpty) return;
      const minified = JSON.stringify(diagnostics.data);
      setRawText(minified);
      showToast('已压缩为单行', 'done');
    }, [diagnostics]);

    const handleSortKeys = useCallback(() => {
      if (!diagnostics.ok) {
        showToast('JSON 解析错误，无法按键排序', 'error');
        return;
      }
      if (diagnostics.isEmpty) return;
      const sorted = sortObjectKeysRecursively(diagnostics.data);
      const indent = indentSize === 'tab' ? '\t' : indentSize;
      setRawText(JSON.stringify(sorted, null, indent));
      showToast('已完成 Key 字母排序', 'done');
    }, [diagnostics, indentSize]);

    const handleSmartFix = useCallback(() => {
      const fixed = smartFixJsonText(rawText);
      const check = parseJsonWithDiagnostics(fixed);
      if (check.ok) {
        const indent = indentSize === 'tab' ? '\t' : indentSize;
        setRawText(JSON.stringify(check.data, null, indent));
        showToast('智能修复成功并已规范化', 'done');
      } else {
        setRawText(fixed);
        showToast('已尝试修复，但仍有部分语法错误', 'warn');
      }
    }, [rawText, indentSize]);

    const handleEscape = useCallback(() => {
      setRawText(escapeJsonString(rawText));
      showToast('已转义为字符串字面量', 'done');
    }, [rawText]);

    const handleUnescape = useCallback(() => {
      const unescaped = unescapeJsonString(rawText);
      setRawText(unescaped);
      showToast('已完成反转义', 'done');
    }, [rawText]);

    const handleCopy = useCallback(() => {
      if (!rawText) return;
      navigator.clipboard.writeText(rawText).then(() => {
        showToast('已复制到剪贴板', 'done');
      }).catch(() => {
        showToast('复制失败', 'error');
      });
    }, [rawText]);

    const handleCopyPath = useCallback((path) => {
      navigator.clipboard.writeText(path).then(() => {
        showToast(`已复制路径: ${path}`, 'done');
      });
    }, []);

    // Load from workspace file
    const handleLoadWorkspaceFile = useCallback(async () => {
      if (!filePath.trim()) {
        showToast('请输入工作区文件路径（如 package.json）', 'warn');
        return;
      }
      try {
        const url = ctx.betterSidebar.hostRouteUrl('sidebar/api/fs.read');
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId: scope?.sessionId,
            cwd: scope?.cwd,
            path: filePath.trim()
          })
        });
        const data = await res.json();
        if (data.ok && data.value?.content != null) {
          setRawText(data.value.content);
          showToast(`已成功载入 ${filePath.trim()}`, 'done');
        } else {
          showToast(`读取失败: ${data.error?.message || '文件不存在'}`, 'error');
        }
      } catch (err) {
        showToast(`读取出错: ${err.message}`, 'error');
      }
    }, [ctx, scope, filePath]);

    // Save back to workspace file
    const handleSaveWorkspaceFile = useCallback(async () => {
      if (!filePath.trim()) {
        showToast('请输入要保存的文件路径（如 output.json）', 'warn');
        return;
      }
      setIsSaving(true);
      try {
        const url = ctx.betterSidebar.hostRouteUrl(
          `sidebar/write?${new URLSearchParams({
            sessionId: scope?.sessionId || '',
            cwd: scope?.cwd || '',
            path: filePath.trim()
          })}`
        );
        const res = await fetch(url, {
          method: 'POST',
          body: rawText
        });
        const data = await res.json();
        if (data.ok) {
          showToast(`已保存到 ${filePath.trim()}`, 'done');
        } else {
          showToast(`保存失败: ${data.error?.message || '权限或冲突'}`, 'error');
        }
      } catch (err) {
        showToast(`保存异常: ${err.message}`, 'error');
      } finally {
        setIsSaving(false);
      }
    }, [ctx, scope, filePath, rawText]);

    return h('div', {
      style: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        width: '100%',
        background: theme.bgLayer1,
        color: theme.labelPrimary,
        overflow: 'hidden'
      }
    }, [
      // Top Toolbar
      h('div', {
        key: 'toolbar',
        style: {
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '6px',
          padding: '8px 10px',
          background: theme.bgLayer2,
          borderBottom: `1px solid ${theme.borderL1}`,
          fontSize: '12px'
        }
      }, [
        // View Mode Switcher
        h('div', {
          key: 'mode-switch',
          style: {
            display: 'flex',
            borderRadius: '6px',
            border: `1px solid ${theme.borderL2}`,
            overflow: 'hidden',
            marginRight: '6px'
          }
        }, [
          h('button', {
            key: 'mode-text',
            onClick: () => setViewMode('text'),
            style: {
              background: viewMode === 'text' ? theme.primary : theme.bgLayer3,
              color: viewMode === 'text' ? '#ffffff' : theme.labelSecondary,
              border: 'none',
              padding: '4px 10px',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 500
            }
          }, '文本'),
          h('button', {
            key: 'mode-tree',
            onClick: () => setViewMode('tree'),
            style: {
              background: viewMode === 'tree' ? theme.primary : theme.bgLayer3,
              color: viewMode === 'tree' ? '#ffffff' : theme.labelSecondary,
              border: 'none',
              borderLeft: `1px solid ${theme.borderL1}`,
              padding: '4px 10px',
              fontSize: '12px',
              cursor: 'pointer',
              fontWeight: 500
            }
          }, '树状视图')
        ]),

        // Indent dropdown
        h('select', {
          key: 'indent-select',
          value: indentSize,
          onChange: (e) => {
            const v = e.target.value;
            setIndentSize(v === 'tab' ? 'tab' : parseInt(v, 10));
          },
          style: {
            background: theme.bgLayer3,
            color: theme.labelPrimary,
            border: `1px solid ${theme.borderL1}`,
            borderRadius: '4px',
            padding: '3px 6px',
            fontSize: '12px',
            outline: 'none',
            cursor: 'pointer'
          }
        }, [
          h('option', { key: '2', value: 2 }, '2 空格'),
          h('option', { key: '4', value: 4 }, '4 空格'),
          h('option', { key: 'tab', value: 'tab' }, 'Tab 制表符')
        ]),

        // Action Buttons
        h('button', {
          key: 'btn-format',
          onClick: handleFormat,
          style: buttonStyle()
        }, '✨ 格式化'),

        h('button', {
          key: 'btn-minify',
          onClick: handleMinify,
          style: buttonStyle()
        }, '⚡ 压缩'),

        h('button', {
          key: 'btn-sort',
          onClick: handleSortKeys,
          style: buttonStyle()
        }, '🔤 键排序'),

        h('button', {
          key: 'btn-fix',
          onClick: handleSmartFix,
          title: '修复单引号、Python字面量、尾逗号等',
          style: buttonStyle(theme.done)
        }, '🛠️ 智能修复'),

        h('button', {
          key: 'btn-escape',
          onClick: handleEscape,
          title: '转换为转义字符串',
          style: buttonStyle()
        }, '转义'),

        h('button', {
          key: 'btn-unescape',
          onClick: handleUnescape,
          title: '剥离转义符',
          style: buttonStyle()
        }, '反转义'),

        h('button', {
          key: 'btn-copy',
          onClick: handleCopy,
          style: buttonStyle()
        }, '📋 复制'),

        h('button', {
          key: 'btn-clear',
          onClick: () => setRawText(''),
          style: buttonStyle(theme.labelTertiary)
        }, '清空')
      ]),

      // File I/O Bar
      h('div', {
        key: 'file-bar',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '6px 10px',
          background: theme.bgLayer2,
          borderBottom: `1px solid ${theme.borderL1}`,
          fontSize: '11px'
        }
      }, [
        h('span', { style: { color: theme.labelTertiary } }, '工作区文件:'),
        h('input', {
          key: 'path-input',
          type: 'text',
          placeholder: '例如: package.json 或 data.json',
          value: filePath,
          onChange: (e) => setFilePath(e.target.value),
          style: {
            flex: 1,
            background: theme.bgBase,
            color: theme.labelPrimary,
            border: `1px solid ${theme.borderL1}`,
            borderRadius: '4px',
            padding: '3px 8px',
            fontSize: '12px',
            fontFamily: theme.fontMono,
            outline: 'none'
          }
        }),
        h('button', {
          key: 'btn-read',
          onClick: handleLoadWorkspaceFile,
          style: buttonStyle()
        }, '载入'),
        h('button', {
          key: 'btn-save',
          onClick: handleSaveWorkspaceFile,
          disabled: isSaving,
          style: buttonStyle(theme.primary)
        }, isSaving ? '保存中...' : '保存')
      ]),

      // Error or Diagnostics Banner
      !diagnostics.ok && h('div', {
        key: 'error-banner',
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 12px',
          background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 15%, transparent)',
          borderBottom: `1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary, #ef4444) 30%, transparent)`,
          color: theme.error,
          fontSize: '12px',
          fontFamily: theme.fontMono
        }
      }, [
        h('span', { key: 'err-msg' }, `⚠ 语法错误 (第 ${diagnostics.line} 行, 第 ${diagnostics.col} 列): ${diagnostics.error}`),
        h('button', {
          key: 'fix-shortcut',
          onClick: handleSmartFix,
          style: {
            background: theme.error,
            color: '#ffffff',
            border: 'none',
            borderRadius: '4px',
            padding: '2px 8px',
            fontSize: '11px',
            cursor: 'pointer'
          }
        }, '一键修复')
      ]),

      // Status Toast Banner
      statusToast && h('div', {
        key: 'status-toast',
        style: {
          padding: '4px 12px',
          fontSize: '11px',
          background: statusToast.tone === 'error' ? theme.error : (statusToast.tone === 'done' ? theme.done : theme.primary),
          color: '#ffffff',
          fontWeight: 500
        }
      }, statusToast.msg),

      // Content View
      h('div', {
        key: 'content-area',
        style: {
          flex: 1,
          overflow: 'auto',
          position: 'relative'
        }
      }, [
        viewMode === 'text'
          ? h('textarea', {
              key: 'textarea',
              value: rawText,
              onChange: (e) => setRawText(e.target.value),
              placeholder: '请在此粘贴或编写 JSON...',
              spellCheck: false,
              style: {
                width: '100%',
                height: '100%',
                background: theme.bgBase,
                color: theme.labelPrimary,
                border: 'none',
                outline: 'none',
                resize: 'none',
                padding: '12px',
                fontSize: '13px',
                lineHeight: '20px',
                fontFamily: theme.fontMono,
                boxSizing: 'border-box'
              }
            })
          : (diagnostics.ok && diagnostics.data !== null
              ? h('div', {
                  key: 'tree-container',
                  style: {
                    padding: '12px',
                    height: '100%',
                    boxSizing: 'border-box'
                  }
                }, [
                  h(JsonTreeNode, {
                    key: 'root-node',
                    name: 'root',
                    value: diagnostics.data,
                    path: '$',
                    defaultExpanded: true,
                    onCopyPath: handleCopyPath,
                    depth: 0
                  })
                ])
              : h('div', {
                  key: 'tree-fallback',
                  style: {
                    padding: '24px',
                    textAlign: 'center',
                    color: theme.labelTertiary,
                    fontSize: '13px'
                  }
                }, diagnostics.ok ? '（空 JSON 内容）' : '无法呈现树状视图：当前 JSON 存在语法错误，请先修复。')
            )
      ])
    ]);
  }

  function buttonStyle(colorAccent) {
    return {
      background: colorAccent
        ? `color-mix(in srgb, ${colorAccent} 15%, transparent)`
        : theme.bgLayer3,
      color: colorAccent || theme.labelPrimary,
      border: `1px solid ${colorAccent ? `color-mix(in srgb, ${colorAccent} 35%, transparent)` : theme.borderL1}`,
      borderRadius: '4px',
      padding: '3px 8px',
      fontSize: '12px',
      cursor: 'pointer',
      fontWeight: 500,
      transition: 'background 0.15s, border-color 0.15s',
      whiteSpace: 'nowrap'
    };
  }

  // ── File Viewer Component ──────────────────────────────────────────────────

  function JsonFileViewer({ ctx, scope, path, title, content, mtimeMs }) {
    return h(JsonWorkbenchTab, {
      ctx,
      scope,
      tab: { id: `editor:${path}`, path, title },
      initialContent: content || ''
    });
  }

  // ── Plugin Definition ──────────────────────────────────────────────────────

  return {
    inject: ['betterSidebar'],
    apply(ctx) {
      if (!ctx.betterSidebar) {
        console.warn('[@max/dsh-json-formatter] ctx.betterSidebar is not mounted');
        return;
      }

      console.log('[@max/dsh-json-formatter] Registering JSON Formatter tab & file viewer into Better Sidebar');

      // 1. Register Sidebar Tab
      ctx.effect(() => {
        return ctx.betterSidebar.registerTab({
          id: 'dsh-json-formatter:tab',
          title: () => 'JSON 格式化',
          description: () => 'JSON 格式化、压缩、键排序、转义及树状结构深度分析',
          icon: (size) => h(JsonIcon, { size }),
          order: 38,
          single: true,
          component: (props) => h(JsonWorkbenchTab, props)
        });
      });

      // 2. Register .json File Viewer
      ctx.effect(() => {
        return ctx.betterSidebar.registerFileViewer({
          id: 'dsh-json-formatter:viewer',
          title: () => 'JSON 格式化预览',
          icon: (size) => h(JsonIcon, { size }),
          exts: ['json'],
          priority: 10, // Higher than builtin code catch-all (-100)
          fetchStrategy: 'fsRead',
          component: (props) => h(JsonFileViewer, props)
        });
      });
    }
  };
}

// Module Loader Registrations
window.__ModuleLoader__.load({
  id: '@max/dsh-json-formatter',
  factory: __dsh_json_formatter_factory
});

window.__ModuleLoader__.load({
  id: 'dsh-json-formatter',
  factory: __dsh_json_formatter_factory
});
