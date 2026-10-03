/**
 * chronofork UI: scrub a session, fork it, and read the report.
 *
 * No framework and no build step — the server already speaks in view models, so
 * this file is mostly: fetch a document, render it, and keep one piece of state
 * (which position is selected) honest.
 */

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

async function api(path, options) {
  const response = await fetch(`/api${path}`, options);
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  return body;
}

const state = {
  sessions: [],
  id: null,
  detail: null,
  summary: null,
  timeline: "root",
  at: 0,
  view: null,
  prepared: [],
  preparedInterest: [],
  report: null,
  selection: 0,
  editFields: [],
  verify: null,
  tamper: null,
  busy: false,
  error: null,
  token: 0,
};

/* ------------------------------------------------------------------- boot */

async function boot() {
  const { sessions } = await api("/sessions");
  state.sessions = sessions;
  $("session-picker").innerHTML = sessions
    .map(
      (session) =>
        `<option value="${esc(session.id)}">${esc(session.label)} · ${session.events.toLocaleString()} events</option>`,
    )
    .join("");
  await loadSession(sessions[0].id);
  $("session-picker").addEventListener("change", (event) => loadSession(event.target.value));
  wireControls();
}

async function loadSession(id) {
  state.id = id;
  state.timeline = "root";
  state.report = null;
  state.tamper = null;
  state.verify = null;
  state.selection = 0;
  const [detail, prepared] = await Promise.all([api(`/sessions/${id}`), api(`/sessions/${id}/experiments`)]);
  state.detail = detail;
  state.summary = state.sessions.find((session) => session.id === id) ?? null;
  state.prepared = prepared.results;
  state.preparedInterest = prepared.interest;
  state.at = Math.min(state.at && state.at <= detail.events ? state.at : detail.events, detail.events);
  $("session-picker").value = id;
  $("session-tagline").textContent = detail.tagline || detail.description.slice(0, 90);
  $("verify-badge").className = "badge muted";
  $("verify-badge").textContent = "unverified";
  $("tamper-card").hidden = true;
  $("report-card").hidden = true;
  await loadState(state.at, true);
}

/* ------------------------------------------------------------------ state */

async function loadState(at, reset = false) {
  const token = ++state.token;
  const clamped = Math.max(0, Math.min(at, state.detail?.events ?? 0));
  const view = await api(`/sessions/${state.id}/state?timeline=${encodeURIComponent(state.timeline)}&at=${clamped}`);
  if (token !== state.token) return;
  state.view = view;
  state.at = view.at;
  if (reset) selectPosition(view.at, false);
  render();
}

async function selectPosition(index, moveScrub = true) {
  state.selection = Math.max(0, Math.min(index, state.detail.events - 1));
  const preview = await api(`/sessions/${state.id}/preview?seq=${state.selection}`);
  state.editFields = preview.editable;
  state.preview = preview;
  if (moveScrub) await loadState(state.selection + 1);
  else render();
}

/* ----------------------------------------------------------------- render */

function render() {
  const view = state.view;
  if (!view) return;

  const slider = $("scrub");
  slider.min = "0";
  slider.max = String(view.length);
  slider.value = String(view.at);
  $("scrub-position").textContent = `#${view.at.toLocaleString()} / ${view.length.toLocaleString()}`;
  $("scrub-clock").textContent = view.clock;
  $("scrub-replay").textContent = `· replayed ${view.eventsReplayed} from checkpoint ${view.fromCheckpoint}`;
  $("timeline-note").textContent = `${view.timeline.label} · ${view.timeline.overrides} overridden position${view.timeline.overrides === 1 ? "" : "s"}`;

  renderChart(view);
  renderTape(view);
  renderLadder(view);
  renderAccounts(view);
  renderStats(view);
  renderEdit();
  renderPrepared();
  renderTree();
  if (state.report) renderReport(state.report);
}

function renderChart(view) {
  const alt = state.report?.series?.alternative ?? null;
  const base = view.series;
  const all = [...base, ...(alt ?? [])];
  // Match the rendered width so the print markers stay circular instead of
  // being stretched by the viewBox.
  const W = Math.max(480, $("chart").clientWidth || 920);
  const H = 168;
  const L = 54;
  const R = 14;
  const T = 12;
  const B = 20;

  if (all.length < 2) {
    $("chart").innerHTML = '<p class="dim small">no prints up to this position</p>';
    return;
  }

  const prices = all.map((point) => point.price);
  let lo = Math.min(...prices);
  let hi = Math.max(...prices);
  const pad = Math.max(2, Math.round((hi - lo) * 0.1));
  lo -= pad;
  hi += pad;

  const length = Math.max(view.length, 1);
  const x = (k) => L + (W - L - R) * (Math.min(k, length) / length);
  const y = (price) => T + (H - T - B) * (1 - (price - lo) / (hi - lo || 1));
  const path = (points) =>
    points.map((point, index) => `${index === 0 ? "M" : "L"}${x(point.k).toFixed(1)},${y(point.price).toFixed(1)}`).join(" ");
  const marks = (points) =>
    points
      .map(
        (point) =>
          `<circle class="print ${point.aggressorSide === "BUY" ? "buy" : "sell"}" cx="${x(point.k).toFixed(1)}" cy="${y(
            point.price,
          ).toFixed(1)}" r="${Math.max(1.2, Math.min(3.4, point.qty / 90)).toFixed(1)}" />`,
      )
      .join("");

  const forkAt = state.report?.spec?.index;
  const gridLines = [hi, (hi + lo) / 2, lo]
    .map(
      (price) =>
        `<line x1="${L}" x2="${W - R}" y1="${y(price).toFixed(1)}" y2="${y(price).toFixed(1)}" stroke="#1b222c" stroke-width="1" />` +
        `<text class="axis" x="6" y="${(y(price) + 3).toFixed(1)}">${(price / 100).toFixed(2)}</text>`,
    )
    .join("");

  $("chart").innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="trade tape">
      <rect class="frame" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" rx="4" />
      ${gridLines}
      ${forkAt !== undefined ? `<line class="fork-line" x1="${x(forkAt)}" x2="${x(forkAt)}" y1="${T}" y2="${H - B}" />` : ""}
      <line class="sel-line" x1="${x(state.selection)}" x2="${x(state.selection)}" y1="${T}" y2="${H - B}" />
      <path class="baseline" d="${path(base)}" />
      ${alt && alt.length > 1 ? `<path class="alternative" d="${path(alt)}" />` : ""}
      ${marks(alt ?? base)}
      <text class="axis" x="${L}" y="${H - 6}">#0</text>
      <text class="axis" x="${W - R - 60}" y="${H - 6}">#${length.toLocaleString()}</text>
    </svg>`;

  $("divergence-note").textContent = alt
    ? `alternative tape: ${alt.length} prints${state.report.series.alternativeTruncated ? ` (stops at #${state.report.report.legalLength})` : ""}`
    : "no alternative history loaded";
}

function renderTape(view) {
  $("tape-range").textContent = `positions ${view.tapeFrom.toLocaleString()} – ${view.at.toLocaleString()}`;
  $("tape-body").innerHTML = view.tape
    .map(
      (row) => `
      <tr data-seq="${row.seq}" class="${row.seq === state.selection ? "selected" : ""}">
        <td>${row.overridden ? `<span class="flag">◆</span> ` : ""}${row.seq}</td>
        <td>${esc(row.clock)}</td>
        <td class="kind tone-${esc(row.tone)}">${esc(row.kind)}</td>
        <td>${esc(row.summary)}</td>
        <td class="kind">${esc(row.overridden ? "fork" : "")}</td>
      </tr>`,
    )
    .join("");
}

function renderLadder(view) {
  const bids = view.book.bids.slice(0, 9);
  const asks = view.book.asks.slice(0, 9);
  const maxQty = Math.max(1, ...[...bids, ...asks].map((level) => level.qty));
  const level = (side, entry) => `
    <div class="level ${side}">
      <span class="price">${esc(entry.priceLabel)}</span>
      <span class="bar"><i style="width:${Math.max(3, Math.round((entry.qty / maxQty) * 100))}%"></i></span>
      <span class="qty">${entry.qty.toLocaleString()}</span>
      <span class="orders">${entry.orders}</span>
    </div>`;

  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

  $("ladder").innerHTML = `
    ${bids.map((entry) => level("bid", entry)).join("")}
    <div class="spread-row"><span>spread</span><span>${
      spread === null ? "no two-sided market" : `${(spread / 100).toFixed(2)} (${spread}¢)`
    }</span></div>
    ${asks.map((entry) => level("ask", entry)).join("")}`;
  $("book-meta").textContent = `${bids.length} bid / ${asks.length} ask levels shown`;
}

function renderAccounts(view) {
  $("accounts-body").innerHTML = view.accounts
    .map(
      (account) => `
      <tr>
        <td>${esc(account.owner)}</td>
        <td class="num">${esc(account.cashLabel)}</td>
        <td class="num dim">${esc(account.reservedCashLabel)}</td>
        <td class="num">${account.positions.toLocaleString()}${
          account.reservedShares ? `<span class="dim"> +${account.reservedShares.toLocaleString()}</span>` : ""
        }</td>
      </tr>`,
    )
    .join("");
}

function renderStats(view) {
  const stats = view.stats;
  $("market-stats").innerHTML = `
    <div><span>last</span>${esc(stats.lastPriceLabel)}</div>
    <div><span>high</span>${esc(stats.highLabel)}</div>
    <div><span>low</span>${esc(stats.lowLabel)}</div>
    <div><span>vwap</span>${stats.vwap === null ? "-" : (stats.vwap / 100).toFixed(2)}</div>
    <div><span>prints</span>${stats.tradeCount.toLocaleString()}</div>
    <div><span>volume</span>${stats.volume.toLocaleString()}</div>
    <div><span>refused</span>${stats.rejectedOrders.toLocaleString()}</div>
    <div><span>cancelled</span>${stats.cancelledOrders.toLocaleString()}</div>`;
}

function renderEdit() {
  const preview = state.preview;
  $("edit-target").textContent = preview ? `position #${preview.seq}` : "click an event";
  $("edit-hint").textContent = preview
    ? `#${preview.seq} ${preview.kind} — ${preview.summary}`
    : "pick a position on the tape, then choose an edit.";
  $("edit-fields").innerHTML = (state.editFields ?? [])
    .map(
      (field) => `
      <label class="field"><span>${esc(field.key)}</span>
        <input type="number" data-field="${esc(field.key)}" value="${field.value}" step="1" />
      </label>`,
    )
    .join("");
  $("edit-drop").disabled = !preview;
  $("run-experiment").disabled = !preview || state.busy;
}

function renderPrepared() {
  $("prepared-count").textContent = `${state.prepared.length} on this session`;
  if (state.prepared.length === 0) {
    $("prepared").innerHTML = '<p class="dim small">This session has no prepared experiments.</p>';
    return;
  }
  $("prepared").innerHTML = state.prepared
    .map((entry, index) => {
      const verdict = entry.report.verdict;
      const klass =
        verdict === "legal-divergence" ? "ok" : verdict === "invariant-violation" ? "bad" : verdict === "impossible-history" ? "warn" : "muted";
      return `
        <button type="button" data-prepared="${index}">
          <span class="row">
            <span>#${entry.report.index} ${esc(entry.spec.label)}</span>
            <span class="badge ${klass}">${esc(verdict)}</span>
          </span>
          <span class="why">${esc(entry.spec.note.slice(0, 150))}</span>
        </button>`;
    })
    .join("");
}

function renderTree() {
  const tree = state.detail.tree;
  $("tree").innerHTML = tree
    .map((node) => {
      const active = node.id === state.timeline ? "active" : "";
      const meta =
        node.parentId === null
          ? `root · ${node.tip.toLocaleString()} events`
          : `fork at #${node.forkPoint} · ${node.tip.toLocaleString()} events · ${node.overrides} edits`;
      return `<button type="button" class="${active}" data-timeline="${esc(node.id)}">
        ${esc(node.label)} <span class="dim">${esc(node.id)}</span>
        <div class="why dim">${esc(meta)}</div>
      </button>`;
    })
    .join("");
}

function renderReport(payload) {
  const report = payload.report;
  const card = $("report-card");
  card.hidden = false;
  const klass =
    report.verdict === "legal-divergence"
      ? "ok"
      : report.verdict === "invariant-violation"
        ? "bad"
        : report.verdict === "impossible-history"
          ? "warn"
          : "muted";
  $("report-verdict").className = `badge ${klass}`;
  $("report-verdict").textContent = report.verdict;
  $("report-headline").textContent = report.headline;
  $("report-narration").innerHTML = report.diff.narration.map((line) => `<li>${esc(line)}</li>`).join("");
  $("report-deltas").innerHTML = report.diff.accounts.length
    ? `<table><thead><tr><th>owner</th><th class="num">cash</th><th class="num">shares</th></tr></thead><tbody>${report.diff.accounts
        .slice(0, 6)
        .map(
          (account) => `<tr><td>${esc(account.owner)}</td>
            <td class="num ${account.cashDelta >= 0 ? "tone-buy" : "tone-sell"}">${account.cashDelta >= 0 ? "+" : ""}${(
              account.cashDelta / 100
            ).toFixed(2)}</td>
            <td class="num">${account.positionsDelta >= 0 ? "+" : ""}${account.positionsDelta.toLocaleString()}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : '<p class="dim small">No account moved.</p>';

  $("report-invariants").innerHTML = (report.invariants?.verdicts ?? [])
    .map((verdict) =>
      verdict.firstViolationSeq === null
        ? `<span class="chip ok" title="${esc(verdict.summary)}">${esc(verdict.id)}</span>`
        : `<span class="chip bad" title="${esc(verdict.detail ?? verdict.summary)}">${esc(verdict.id)} @ #${verdict.firstViolationSeq}</span>`,
    )
    .join("");

  const digests = report.diff.digests;
  $("report-meta").innerHTML = [
    `positions applied ${report.legalLength.toLocaleString()} of ${report.totalPositions.toLocaleString()}`,
    `book ${digests.bookEqual ? "same" : "different"}`,
    `accounts ${digests.accountsEqual ? "same" : "different"}`,
    `orders ${digests.ordersEqual ? "same" : "different"}`,
    `${report.elapsedMs.toFixed(0)} ms`,
  ].join(" · ");

  const branch = report.mode === "branch";
  $("branch-form").hidden = !branch;
  if (branch) {
    $("branch-note").textContent = `branch '${report.timelineId}' has ${payload.report.totalPositions.toLocaleString()} events — send an order and it becomes its own market.`;
    $("branch-price").value = $("branch-price").value || String(report.original.vt % 97 + 2390);
  }
}

/* --------------------------------------------------------------- actions */

function wireControls() {
  $("scrub").addEventListener("input", (event) => loadState(Number(event.target.value)));
  document.querySelectorAll("[data-step]").forEach((button) =>
    button.addEventListener("click", () => loadState(state.at + Number(button.dataset.step))),
  );
  document.querySelectorAll("[data-jump]").forEach((button) =>
    button.addEventListener("click", () => loadState(button.dataset.jump === "last" ? state.detail.events : 0)),
  );
  $("seek-edit").addEventListener("click", () => selectPosition(state.at));

  $("tape-body").addEventListener("click", (event) => {
    const row = event.target.closest("tr[data-seq]");
    if (row) selectPosition(Number(row.dataset.seq));
  });

  $("run-experiment").addEventListener("click", runExperiment);
  $("verify-button").addEventListener("click", runVerify);
  $("branch-send").addEventListener("click", sendBranchOrder);

  $("prepared").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-prepared]");
    if (!button) return;
    const entry = state.prepared[Number(button.dataset.prepared)];
    runExperiment({ spec: entry.spec, silent: true });
  });

  $("tree").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-timeline]");
    if (!button) return;
    state.timeline = button.dataset.timeline;
    state.report = null;
    await loadState(state.at, true);
  });

  document.addEventListener("keydown", (event) => {
    if (event.target.matches("input, select, textarea")) return;
    if (event.key === "ArrowLeft") loadState(state.at - 1);
    if (event.key === "ArrowRight") loadState(state.at + 1);
  });
}

async function runExperiment(options = {}) {
  const spec = options.spec ?? buildSpec();
  if (!spec) return;
  setBusy(true);
  try {
    const payload = await api(`/sessions/${state.id}/experiment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(spec),
    });
    state.report = payload;
    state.selection = payload.spec.index;
    if (!options.silent) await loadState(payload.spec.mode === "branch" ? payload.report.totalPositions : state.at);
    renderReport(payload);
    renderChart(state.view);
  } catch (error) {
    alert(`experiment failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function buildSpec() {
  if (!state.preview) return null;
  const patch = {};
  document.querySelectorAll("#edit-fields input[data-field]").forEach((input) => {
    const original = state.editFields.find((field) => field.key === input.dataset.field);
    const value = Number(input.value);
    if (original && Number.isFinite(value) && value !== original.value) patch[input.dataset.field] = value;
  });
  return {
    index: state.preview.seq,
    mode: $("edit-mode").value,
    label: $("edit-label").value.trim() || `experiment at #${state.preview.seq}`,
    note: `edited ${Object.keys(patch).join(", ") || "nothing"}`,
    drop: $("edit-drop").checked,
    patch,
  };
}

async function runVerify() {
  setBusy(true);
  try {
    const result = await api(`/sessions/${state.id}/verify`);
    state.verify = result;
    const ok = result.ok;
    $("verify-badge").className = `badge ${ok ? "ok" : "bad"}`;
    $("verify-badge").textContent = ok
      ? `${result.chain.events.toLocaleString()} events verified`
      : `FAILED at #${result.chain.failedSeq ?? "?"}`;
    // The tamper test is the interactive half of verification: take one number
    // from the selected event, rewrite it in a copy of the log, and show which
    // of the three layers notices.
    const seq = state.selection ?? Math.floor(result.chain.events / 2);
    const tamper = await api(`/sessions/${state.id}/tamper?seq=${seq}`);
    state.tamper = tamper;
    renderTamper(tamper);
  } catch (error) {
    alert(`verify failed: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function renderTamper(payload) {
  $("tamper-card").hidden = false;
  const { report, original } = payload;
  $("tamper-target").textContent = `#${original.seq} ${original.kind} ${original.field}: ${toString(report.before)} → ${toString(report.after)}`;

  const checks = (verify, title, note) => `
    <div>
      <h3>${title}</h3>
      <p class="dim small">${note}</p>
      <p class="badge ${verify.ok ? "ok" : "bad"}">${verify.ok ? "accepted" : `rejected at #${verify.failedSeq ?? "?"}`}</p>
      <ul class="narration small">${verify.checks
        .map((check) => `<li class="${check.ok ? "" : "tone-sell"}">${esc(check.name)}: ${esc(check.detail)}</li>`)
        .join("")}</ul>
    </div>`;

  $("tamper-naive").innerHTML = checks(
    report.naive.verify,
    "1 · edited, hashes kept",
    "The payload is changed and the recorded hashes are left alone.",
  );
  $("tamper-forged").innerHTML = checks(
    report.forged.verify,
    "2 · forged, chain recomputed",
    "Every hash after the edit is recomputed, so the file is internally consistent.",
  );

  const semantic = report.semantic;
  $("tamper-semantic").innerHTML = `
    <div>
      <h3>3 · semantic replay</h3>
      <p class="dim small">The reducer and the invariant monitor do not read hashes at all.</p>
      ${
        semantic
          ? `<p class="badge ${semantic.failure || !semantic.invariants.ok ? "bad" : "ok"}">${
              semantic.failure
                ? `impossible history at #${semantic.failure.seq}`
                : semantic.invariants.ok
                  ? "history still legal"
                  : `${semantic.invariants.violations.length} invariant break${semantic.invariants.violations.length === 1 ? "" : "s"}`
            }</p>
            <ul class="narration small">${
              semantic.failure
                ? `<li>${esc(semantic.failure.message)}</li>`
                : semantic.invariants.violations
                    .slice(0, 5)
                    .map(
                      (violation) =>
                        `<li>${esc(violation.invariant)} at #${violation.atSeq} (${esc(violation.subject)}): ${esc(violation.detail)}</li>`,
                    )
                    .join("") || "<li>nothing broke — this edit is a legal market.</li>"
            }</ul>`
          : '<p class="dim small">no meta line to replay</p>'
      }
    </div>`;
}

async function sendBranchOrder() {
  const report = state.report?.report;
  if (!report) return;
  const command = {
    kind: "PLACE_ORDER",
    owner: state.detail.config.participants[0].owner,
    side: $("branch-side").value,
    price: Number($("branch-price").value),
    qty: Number($("branch-qty").value),
    tif: $("branch-tif").value,
  };
  setBusy(true);
  try {
    await api(`/sessions/${state.id}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeline: report.timelineId, command, vt: state.view.vt + 1_000 }),
    });
    state.timeline = report.timelineId;
    state.detail = await api(`/sessions/${state.id}`);
    await loadState(state.view.length + 20);
  } catch (error) {
    alert(`branch order refused: ${error.message}`);
  } finally {
    setBusy(false);
  }
}

function setBusy(value) {
  state.busy = value;
  $("run-experiment").disabled = value || !state.preview;
  $("verify-button").disabled = value;
}

function toString(value) {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

boot().catch((error) => {
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<p style="color:#f87171;padding:16px 22px">failed to start: ${esc(error.message)}</p>`,
  );
});
