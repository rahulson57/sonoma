/**
 * The inspector page (SPEC-012): one HTML document, one stylesheet and one script, all served from the inspector's
 * own origin. No CDN, no font or analytics request, no external origin anywhere. The CSP (server.ts) allows only
 * 'self'.
 *
 * The script renders data with DOM text nodes only (never innerHTML), so stored values, including `[REDACTED:<kind>]`
 * markers, are shown verbatim and nothing is reconstructed. Resume / Fork / Rollback / Export are shown as copyable
 * CLI commands and are never executed. Irreversible side effects carry a visible warning marker.
 *
 * The timeline marks `ckpt:timeline-rendered` (Performance API) once its nodes are in the DOM.
 */

export const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ckpt inspector</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header class="bar">
  <h1>ckpt inspector</h1>
  <span class="tag">local &middot; read-only</span>
</header>
<main class="layout">
  <nav class="runs" aria-label="Runs">
    <h2>Runs</h2>
    <ul id="run-list"></ul>
  </nav>
  <section class="timeline-wrap" aria-label="Timeline">
    <h2 id="timeline-title">Timeline</h2>
    <p id="diff-bar" class="diff-bar"></p>
    <ol id="timeline" class="timeline" data-testid="timeline"></ol>
  </section>
  <section id="detail" class="detail" aria-label="Checkpoint detail">
    <p class="hint">Select a checkpoint to see its STATE, WORKSPACE and LEDGER panes. Pick A and B to diff two checkpoints.</p>
  </section>
</main>
<p id="status" class="status" role="status"></p>
<script src="/app.js" defer></script>
</body>
</html>
`;

export const APP_CSS = String.raw`:root {
  color-scheme: light dark;
  --bg: #f6f6f3;
  --fg: #1c1c1a;
  --muted: #6a6a64;
  --line: #dadad3;
  --panel: #ffffff;
  --accent: #2c5a86;
  --warn: #9c3b06;
  --warn-bg: #fbe9dc;
  --lane: 1.25rem;
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151514;
    --fg: #e7e7e2;
    --muted: #9b9b94;
    --line: #34342f;
    --panel: #1f1f1d;
    --accent: #8fb6dd;
    --warn: #f2a877;
    --warn-bg: #3b2517;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); }
code, pre, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
.bar { display: flex; align-items: baseline; gap: .75rem; padding: .6rem 1rem; border-bottom: 1px solid var(--line); }
.bar h1 { font-size: 15px; margin: 0; }
.tag { color: var(--muted); font-size: 12px; }
.layout { display: grid; grid-template-columns: 17rem minmax(22rem, 1fr) minmax(26rem, 1.3fr); }
.layout > * { padding: .75rem 1rem; overflow: auto; height: calc(100vh - 2.7rem); }
.runs { border-right: 1px solid var(--line); }
.detail { border-left: 1px solid var(--line); background: var(--panel); }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: .25rem 0 .5rem; }
h3 { font-size: 13px; margin: 1rem 0 .4rem; }
ul, ol { list-style: none; margin: 0; padding: 0; }
button { font: inherit; color: inherit; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.run > button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: .35rem .5rem; }
.run > button:hover { background: var(--line); }
.run.active > button { background: var(--accent); color: var(--bg); }
.run .mono { display: block; overflow-wrap: anywhere; }
.run .sub { display: block; color: var(--muted); font-size: 12px; }
.run.active .sub { color: inherit; opacity: .85; }
.node { position: relative; display: grid; grid-template-columns: 1fr auto; gap: .1rem .5rem; margin-left: calc(var(--depth, 0) * var(--lane)); padding: .3rem .5rem .3rem .9rem; border-left: 2px solid var(--line); }
.node::before { content: ""; position: absolute; left: -5px; top: .7rem; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.node.forked { border-left-color: var(--accent); }
.node.forked::before { background: var(--accent); }
.node.selected { background: var(--panel); box-shadow: inset 0 0 0 1px var(--accent); }
.node .open { border: 0; background: transparent; padding: 0; text-align: left; font-weight: 600; }
.node .ab button { font-size: 11px; padding: 0 .4rem; margin-left: .2rem; }
.node .meta { grid-column: 1 / -1; color: var(--muted); font-size: 12px; }
.label { display: inline-block; margin-right: .35rem; padding: 0 .35rem; border-radius: 3px; background: var(--line); color: var(--fg); font-size: 11px; }
.diff-bar { color: var(--muted); font-size: 12px; min-height: 1.2em; margin: 0 0 .5rem; }
.pane { border-top: 1px solid var(--line); margin-top: .5rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .2rem .75rem; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
pre { background: var(--bg); border: 1px solid var(--line); padding: .5rem; margin: .25rem 0; max-height: 20rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.warn { color: var(--warn); background: var(--warn-bg); padding: 0 .35rem; border-radius: 3px; font-weight: 600; font-size: 12px; }
.ref { color: var(--muted); }
.side-effects li, .events li { padding: .25rem 0; border-bottom: 1px dashed var(--line); overflow-wrap: anywhere; }
.actions li { display: flex; align-items: center; gap: .5rem; margin: .25rem 0; }
.actions code { flex: 1; padding: .2rem .4rem; background: var(--bg); border: 1px solid var(--line); border-radius: 3px; user-select: all; overflow-wrap: anywhere; }
.hint { color: var(--muted); }
.status { position: fixed; right: 1rem; bottom: .5rem; margin: 0; color: var(--muted); font-size: 12px; }
@media (max-width: 1000px) {
  .layout { grid-template-columns: 1fr; }
  .layout > * { height: auto; }
}
`;

export const APP_JS = String.raw`(function () {
  'use strict';

  var ACTIONS = ['resume', 'fork', 'rollback', 'export'];
  var state = { runs: [], runId: null, nodes: [], selected: null, diffA: null, diffB: null };

  function byId(id) { return document.getElementById(id); }

  function h(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === undefined || value === null) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = String(value);
        else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, String(value));
      });
    }
    (children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function mono(text) { return h('code', { text: String(text) }); }
  function pre(value) { return h('pre', { text: JSON.stringify(value, null, 2) }); }
  function hint(text) { return h('p', { class: 'hint', text: text }); }
  function range(pair) { return '(' + pair[0] + ', ' + pair[1] + ']'; }
  function kv(pairs) {
    var children = [];
    pairs.forEach(function (pair) { children.push(h('dt', { text: pair[0] })); children.push(h('dd', null, [pair[1]])); });
    return h('dl', null, children);
  }

  function getJSON(path) {
    return fetch(path, { headers: { Accept: 'application/json' }, credentials: 'same-origin' }).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error((body && body.error) || ('HTTP ' + res.status));
        return body;
      });
    });
  }

  function status(text) { byId('status').textContent = text || ''; }
  function fail(err) { status('Error: ' + (err && err.message ? err.message : String(err))); }

  function runOf(id) { var i = id.indexOf(':'); return i < 0 ? id : id.slice(0, i); }
  function cpOf(id) { var i = id.indexOf(':'); return i < 0 ? id : id.slice(i + 1); }
  function shortRun(runId) { return runId.length > 14 ? runId.slice(0, 8) + '…' + runId.slice(-4) : runId; }

  function renderRuns() {
    var list = byId('run-list');
    list.textContent = '';
    if (state.runs.length === 0) { list.appendChild(h('li', { class: 'hint', text: 'No runs in this store.' })); return; }
    state.runs.forEach(function (run) {
      var sub = run.agent + ' · ' + run.created_at;
      if (run.parent_run_id) sub += ' · fork of ' + shortRun(run.parent_run_id) + ':' + run.forked_from_checkpoint;
      list.appendChild(h('li', { class: 'run' + (run.run_id === state.runId ? ' active' : '') }, [
        h('button', { type: 'button', title: run.run_id, onclick: function () { selectRun(run.run_id); } }, [
          h('span', { class: 'mono', text: run.run_id }),
          h('span', { class: 'sub', text: sub })
        ])
      ]));
    });
  }

  function selectRun(runId) {
    state.runId = runId;
    state.selected = null;
    state.diffA = null;
    state.diffB = null;
    renderRuns();
    renderDiffBar();
    var params = new URLSearchParams(window.location.search);
    params.set('run', runId);
    params.delete('checkpoint');
    window.history.replaceState(null, '', '?' + params.toString());
    byId('timeline-title').textContent = 'Timeline · ' + runId;
    status('Loading timeline…');
    return getJSON('/api/runs/' + encodeURIComponent(runId) + '/checkpoints').then(function (nodes) {
      state.nodes = nodes;
      renderTimeline();
      status('');
    }).catch(fail);
  }

  function renderTimeline() {
    var list = byId('timeline');
    var depth = Object.create(null);
    var fragment = document.createDocumentFragment();
    state.nodes.forEach(function (node) {
      var parentRun = node.parentId === null ? null : runOf(node.parentId);
      var forked = parentRun !== null && parentRun !== node.runId;
      if (!(node.runId in depth)) depth[node.runId] = forked && parentRun in depth ? depth[parentRun] + 1 : 0;
      var lineage = node.parentId === null ? 'root' : (forked ? 'forked from ' + node.parentId : 'parent ' + cpOf(node.parentId));
      var item = h('li', { class: 'node' + (forked ? ' forked' : '') + (node.checkpointId === state.selected ? ' selected' : ''), 'data-id': node.checkpointId }, [
        h('button', { type: 'button', class: 'open mono', title: node.checkpointId, onclick: function () { selectCheckpoint(node.checkpointId); } }, [
          shortRun(node.runId) + ':' + cpOf(node.checkpointId)
        ]),
        h('span', { class: 'ab' }, [
          h('button', { type: 'button', title: 'Diff from this checkpoint', onclick: function () { setDiff('a', node.checkpointId); } }, ['A']),
          h('button', { type: 'button', title: 'Diff to this checkpoint', onclick: function () { setDiff('b', node.checkpointId); } }, ['B'])
        ]),
        h('span', { class: 'meta' }, [
          node.label ? h('span', { class: 'label', text: node.label }) : null,
          node.createdAt + ' · ledger ' + range(node.ledgerRange) + ' · ' + lineage
        ])
      ]);
      item.style.setProperty('--depth', String(depth[node.runId]));
      fragment.appendChild(item);
    });
    list.textContent = '';
    if (state.nodes.length === 0) list.appendChild(h('li', { class: 'hint', text: 'This run has no checkpoints yet.' }));
    list.appendChild(fragment);
    list.setAttribute('data-ready', 'true');
    if (window.performance && typeof performance.mark === 'function') performance.mark('ckpt:timeline-rendered');
  }

  function selectCheckpoint(id) {
    state.selected = id;
    Array.prototype.forEach.call(byId('timeline').children, function (item) {
      item.classList.toggle('selected', item.getAttribute('data-id') === id);
    });
    status('Loading ' + id + '…');
    return getJSON('/api/checkpoints/' + encodeURIComponent(id)).then(function (panes) {
      renderDetail(id, panes);
      status('');
    }).catch(fail);
  }

  function sideEffectList(list) {
    if (!list.length) return hint('None.');
    return h('ul', { class: 'side-effects' }, list.map(function (effect) {
      return h('li', null, [
        effect.reversibility === 'irreversible'
          ? h('span', { class: 'warn', title: 'Irreversible. ckpt records side effects and never undoes them.', text: '⚠ irreversible' })
          : h('span', { class: 'ref', text: effect.reversibility }),
        ' ', mono(effect.type), ' → ', mono(effect.target)
      ]);
    }));
  }

  function eventItem(event) {
    var body;
    if (event.payloadRef) {
      body = h('span', { class: 'ref' }, [mono(event.payloadRef.ref), ' (' + event.payloadRef.size + ' bytes, not inlined)']);
    } else if (event.payload === null) {
      body = h('span', { class: 'hint', text: 'no payload' });
    } else {
      body = h('details', null, [h('summary', { text: 'payload' }), pre(event.payload)]);
    }
    return h('li', null, [mono('#' + event.seq), ' ', mono(event.type), ' ', h('span', { class: 'ref', text: event.actor + ' · ' + event.ts }), h('div', null, [body])]);
  }

  function copy(command) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(command).then(function () { status('Copied: ' + command); }, function () { status('Select the command to copy it.'); });
    } else {
      status('Select the command to copy it.');
    }
  }

  function renderDetail(id, panes) {
    var detail = byId('detail');
    var ledger = panes.ledger;
    detail.textContent = '';
    detail.appendChild(h('h2', { text: 'Checkpoint ' + id }));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'state' }, [h('h3', { text: 'STATE' }), pre(panes.state)]));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'workspace' }, [
      h('h3', { text: 'WORKSPACE' }),
      kv([
        ['commit', mono(panes.workspace.commit)],
        ['changed', panes.workspace.changedPaths.length
          ? h('ul', null, panes.workspace.changedPaths.map(function (p) { return h('li', null, [mono(p)]); }))
          : h('span', { class: 'hint', text: 'no changes' })]
      ])
    ]));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'ledger' }, [
      h('h3', { text: 'LEDGER' }),
      kv([
        ['range', mono(range(ledger.range))],
        ['tools', ledger.toolsUsed.length ? mono(ledger.toolsUsed.join(', ')) : h('span', { class: 'hint', text: 'none' })],
        ['model calls', mono(ledger.modelCalls)]
      ]),
      h('h3', { text: 'Side effects' }),
      sideEffectList(ledger.sideEffects),
      h('h3', { text: 'Events' }),
      ledger.events.length ? h('ol', { class: 'events' }, ledger.events.map(eventItem)) : hint('No events in this range.')
    ]));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'actions' }, [
      h('h3', { text: 'Actions (copy and run in your terminal)' }),
      h('ul', { class: 'actions' }, ACTIONS.map(function (action) {
        var command = 'ckpt ' + action + ' ' + id;
        return h('li', null, [mono(command), h('button', { type: 'button', onclick: function () { copy(command); } }, ['Copy'])]);
      }))
    ]));
  }

  function renderDiffBar() {
    byId('diff-bar').textContent = 'Diff: A = ' + (state.diffA || '—') + ' · B = ' + (state.diffB || '—');
  }

  function setDiff(side, id) {
    if (side === 'a') state.diffA = id; else state.diffB = id;
    renderDiffBar();
    if (!state.diffA || !state.diffB) return;
    var a = state.diffA;
    var b = state.diffB;
    status('Loading diff…');
    getJSON('/api/diff?a=' + encodeURIComponent(a) + '&b=' + encodeURIComponent(b)).then(function (diff) {
      renderDiff(a, b, diff);
      status('');
    }).catch(fail);
  }

  function renderDiff(a, b, diff) {
    var detail = byId('detail');
    detail.textContent = '';
    detail.appendChild(h('h2', { text: 'Diff ' + a + ' → ' + b }));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'diff-state' }, [
      h('h3', { text: 'State' }),
      diff.state.length ? h('ul', { class: 'events' }, diff.state.map(function (op) {
        return h('li', null, [mono(op.op), ' ', mono(op.path), op.op === 'remove' ? null : pre(op.value)]);
      })) : hint('No state changes.')
    ]));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'diff-workspace' }, [
      h('h3', { text: 'Workspace' }),
      diff.workspace.length ? h('ul', { class: 'events' }, diff.workspace.map(function (entry) {
        return h('li', null, [mono(entry.status), ' ', mono(entry.oldPath ? entry.oldPath + ' → ' + entry.path : entry.path)]);
      })) : hint('No workspace changes.')
    ]));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'diff-ledger' }, [
      h('h3', { text: 'Ledger' }),
      kv([['A', mono(range(diff.ledger.a))], ['B', mono(range(diff.ledger.b))]])
    ]));
    detail.appendChild(h('div', { class: 'pane', 'data-pane': 'diff-side-effects' }, [h('h3', { text: 'Side effects' }), sideEffectList(diff.sideEffects)]));
  }

  function init() {
    var params = new URLSearchParams(window.location.search);
    var wantedCheckpoint = params.get('checkpoint');
    renderDiffBar();
    getJSON('/api/runs').then(function (runs) {
      state.runs = runs;
      var wanted = params.get('run');
      var runId = wanted && runs.some(function (run) { return run.run_id === wanted; }) ? wanted : (runs.length ? runs[0].run_id : null);
      renderRuns();
      if (runId === null) { byId('timeline').setAttribute('data-ready', 'true'); return null; }
      return selectRun(runId).then(function () { if (wantedCheckpoint) return selectCheckpoint(wantedCheckpoint); return null; });
    }).catch(fail);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
`;
