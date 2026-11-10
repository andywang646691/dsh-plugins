# Architecture & System Design

## 1. Overview & Boundary

`@max/dsh-json-formatter` is a DeepSeek Harness (DSH) Web client extension plugin that mounts into `dsh-better-sidebar` via the `ctx.betterSidebar` Cordis service.

### Components:
- **Host Half (`index.mjs`)**: Minimal Cordis plugin layer loaded by the DSH host runner.
- **Client Half (`client.js`)**: Pure ES/React component registered with DSH's browser module loader (`window.__ModuleLoader__.load`).
- **Better Sidebar Extension**:
  - `registerTab`: Registers the `dsh-json-formatter:tab` workspace tab.
  - `registerFileViewer`: Registers `dsh-json-formatter:viewer` for `.json` files (`priority: 10`).

## 2. Data Flow & State Management

```text
[DSH Web Shell]
      │
      ▼ (ModuleLoader.load)
[dsh-json-formatter (client.js)]
      │
      ▼ inject: ['betterSidebar']
[ctx.betterSidebar Service]
   ├── registerTab('dsh-json-formatter:tab')
   │      └── JsonWorkbenchTab (Text Editor + Tree Inspector)
   └── registerFileViewer('dsh-json-formatter:viewer', exts: ['json'])
          └── JsonFileViewer (Reads file content, provides 1-click format/save)
```

## 3. Design Token Contract

All styling in `client.js` references CSS variables directly:
- Outer background: `var(--dsw-alias-bg-layer-1)`
- Panels and Toolbars: `var(--dsw-alias-bg-layer-2)`, `var(--dsw-alias-bg-layer-3)`
- Borders: `var(--dsw-alias-border-l1)`, `var(--dsw-alias-border-l2)`
- Text: `var(--dsw-alias-label-primary)`, `var(--dsw-alias-label-secondary)`, `var(--dsw-alias-label-tertiary)`
- Interaction states: `var(--dsw-alias-interactive-bg-hover)`
- Semantic states: `var(--dsw-alias-state-business-primary)`, `var(--dsw-alias-state-done-primary)`, `var(--dsw-alias-state-error-primary)`
