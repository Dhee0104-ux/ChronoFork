#!/usr/bin/env node
/**
 * The HTTP API and static host.
 *
 * Zero dependencies on purpose: `node:http` plus `node:fs` is enough to serve
 * the UI and expose the engine, and it means the whole project runs on a stock
 * Node install with no install step at all.
 *
 * The API is deliberately *thin*. Every endpoint is a read of the session model
 * plus a view model built with the same helpers the CLI uses, so the browser and
 * the terminal describe the same world: same diff, same narration, same
 * verdicts. Caching matters more than it looks — the UI re-reads a session on
 * every scrub, while an experiment (which folds a whole alternative history) is
 * cached per edit, because a click should not cost a replay.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describeEvent, eventTone, formatClock, formatPrice, formatQty } from "../engine/describe.ts";
import type { Command, EngineState, EventCore } from "../engine/types.ts";
import { listSessionIds, PUBLIC_DIR, SESSIONS_DIR } from "../log/paths.ts";
import { tamperSession, type TamperReport } from "../log/tamper.ts";
import { loadInterest } from "../sim/interest.ts";
import { SCENARIOS, scenarioById } from "../sim/scenarios.ts";
import { diffStates, tradeSeries, type SeriesPoint } from "../timeline/diff.ts";
import {
  runCounterfactual,
  type CounterfactualReport,
  type CounterfactualSpec,
} from "../timeline/report.ts";
import { Session, type SessionVerification } from "../timeline/session.ts";
import type { Timeline } from "../timeline/timeline.ts";

/* ------------------------------------------------------------------ caching */

const sessionCache = new Map<string, Session>();
const experimentCache = new Map<string, CounterfactualReport>();
const verifyCache = new Map<string, SessionVerification>();
const preparedCache = new Map<string, Array<{ spec: CounterfactualSpec; report: CounterfactualReport }>>();
const tamperCache = new Map<string, TamperReport>();

function loadSession(id: string): Session {
  let session = sessionCache.get(id);
  if (!session) {
    session = Session.load(id);
    sessionCache.set(id, session);
  }
  return session;
}

/** Every id we can serve, with the scenario metadata the logs do not carry. */
function sessionSummaries() {
  return listSessionIds().map((id) => {
    const session = loadSession(id);
    const scenario = scenarioById(id);
    const root = session.root;
    const tip = root.peek();
    return {
      id,
      label: scenario?.label ?? session.config.label,
      tagline: scenario?.tagline ?? "",
      description: session.config.description,
      instrument: session.config.instrument,
      participants: session.config.participants,
      events: root.length(),
      prints: tip.stats.volume,
      trades: tip.stats.tradeCount,
      lastPrice: tip.stats.lastPrice,
      firstVt: session.config.startVt,
      endVt: tip.vt,
      openOrders: Object.values(tip.orders).filter((order) => order.status === "OPEN").length,
      experiments: loadInterest(id).length,
    };
  });
}

/** A prepared experiment turned into a report, cached by its spec. */
function preparedExperiments(id: string): Array<{ spec: CounterfactualSpec; report: CounterfactualReport }> {
  const cached = preparedCache.get(id);
  if (cached) return cached;
  const session = loadSession(id);
  const results = loadInterest(id).flatMap((point) => {
    const original = session.root.eventAt(point.seq);
    if (!original) return [];
    const spec: CounterfactualSpec = {
      index: point.seq,
      mode: point.mode,
      label: point.label,
      note: point.why,
      edit: point.edit.drop
        ? null
        : {
            seq: original.seq,
            vt: original.vt,
            kind: original.kind,
            data: {
              ...(original.data as unknown as Record<string, unknown>),
              ...(point.edit.patch ?? {}),
            } as unknown as EventCore["data"],
          },
    };
    return [{ spec, report: runCounterfactual(session, spec) }];
  });
  preparedCache.set(id, results);
  return results;
}

/* -------------------------------------------------------------- view models */

function bookView(state: EngineState) {
  const level = (levels: EngineState["bids"]) =>
    levels.map((entry) => ({
      price: entry.price,
      priceLabel: formatPrice(entry.price),
      qty: entry.totalQty,
      orders: entry.orders.length,
    }));
  return { bids: level(state.bids), asks: level(state.asks) };
}

function accountView(state: EngineState) {
  return Object.values(state.accounts)
    .map((account) => ({
      owner: account.owner,
      cash: account.cash,
      cashLabel: formatPrice(account.cash),
      reservedCash: account.reservedCash,
      reservedCashLabel: formatPrice(account.reservedCash),
      positions: account.positions,
      reservedShares: account.reservedShares,
      totalCash: account.cash + account.reservedCash,
      exposure: account.positions + account.reservedShares,
    }))
    .sort((a, b) => b.totalCash - a.totalCash);
}

function tapeView(events: readonly EventCore[], timeline: Timeline) {
  return events.map((event) => ({
    seq: event.seq,
    vt: event.vt,
    clock: formatClock(event.vt),
    kind: event.kind,
    tone: eventTone(event),
    summary: describeEvent(event),
    provenance: timeline.provenanceOf(event.seq),
    overridden: timeline.overrideAt(event.seq) !== undefined,
  }));
}

function seriesView(state: EngineState): SeriesPoint[] {
  return tradeSeries(state, 420);
}

function stateResponse(session: Session, timeline: Timeline, at: number) {
  const clamped = Math.max(0, Math.min(at, timeline.length()));
  const materialized = timeline.stateAt(clamped);
  const state = materialized.state;
  const events = timeline.resolved();
  const from = Math.max(0, clamped - 80);
  return {
    session: session.id,
    timeline: timelineNode(timeline),
    timelines: session.tree(),
    at: clamped,
    length: timeline.length(),
    vt: state.vt,
    clock: formatClock(state.vt),
    sessionState: state.session,
    sessionIndex: state.sessionIndex,
    symbol: state.symbol,
    seq: state.seq,
    fromCheckpoint: materialized.fromCheckpoint,
    eventsReplayed: materialized.eventsReplayed,
    digests: materialized.digests,
    stats: {
      ...state.stats,
      lastPriceLabel: formatPrice(state.stats.lastPrice),
      highLabel: formatPrice(state.stats.high),
      lowLabel: formatPrice(state.stats.low),
      vwap:
        state.stats.vwapDenominator === 0
          ? null
          : state.stats.vwapNumerator / state.stats.vwapDenominator,
    },
    ledger: state.ledger,
    accounts: accountView(state),
    book: bookView(state),
    series: seriesView(state),
    tape: tapeView(events.slice(from, clamped), timeline),
    tapeFrom: from,
    openOrders: Object.values(state.orders)
      .filter((order) => order.status === "OPEN")
      .slice(0, 40)
      .map((order) => ({
        id: order.id,
        owner: order.owner,
        side: order.side,
        price: order.price,
        priceLabel: formatPrice(order.price),
        remaining: order.remaining,
        filled: order.filled,
        qty: order.qty,
        tif: order.tif,
        placedSeq: order.placedSeq,
        placedClock: formatClock(order.placedVt),
        clientRef: order.clientRef,
      })),
  };
}

function timelineNode(timeline: Timeline) {
  return {
    id: timeline.id,
    label: timeline.label,
    parentId: timeline.parent?.id ?? null,
    forkPoint: timeline.parent ? timeline.baseSeq : null,
    length: timeline.length(),
    overrides: timeline.overrideMap.size,
    note: timeline.note,
    createdAt: timeline.createdAt,
    checkpoints: timeline.checkpointKeys(),
    stats: timeline.stats,
  };
}

/* -------------------------------------------------------------------- edits */

interface ExperimentBody {
  index?: number;
  mode?: "branch" | "counterfactual";
  label?: string;
  note?: string;
  drop?: boolean;
  patch?: Record<string, unknown>;
}

function experimentFromBody(session: Session, body: ExperimentBody) {
  const index = Number(body.index);
  if (!Number.isInteger(index) || index < 0 || index >= session.root.length()) {
    throw new HttpError(400, `event index ${String(body.index)} is outside the root log`);
  }
  const original = session.root.eventAt(index) as EventCore;
  const mode = body.mode === "branch" ? "branch" : "counterfactual";
  const label = body.label?.trim() || `${mode} at #${index}`;
  const note = body.note?.trim() || "ad-hoc experiment";
  const patch = body.patch ?? {};
  const edit: EventCore | null = body.drop
    ? null
    : {
        seq: original.seq,
        vt: original.vt,
        kind: (patch.kind as EventCore["kind"]) ?? original.kind,
        data: { ...(original.data as unknown as Record<string, unknown>), ...patch } as unknown as EventCore["data"],
      };
  const spec: CounterfactualSpec = { index, mode, label, note, edit };
  const key = `${session.id}|${index}|${mode}|${JSON.stringify(edit)}`;
  let report = experimentCache.get(key);
  if (!report) {
    report = runCounterfactual(session, spec);
    experimentCache.set(key, report);
  }
  const baseline = session.root.state();
  const alternative = session.get(report.timelineId).evaluate();
  return {
    spec,
    report,
    series: {
      baseline: seriesView(baseline.state),
      alternative: seriesView(alternative.state),
      alternativeLegalLength: alternative.legalLength,
      alternativeTruncated: alternative.truncated,
    },
  };
}

/* --------------------------------------------------------------- http glue */

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

function sendStatic(response: ServerResponse, urlPath: string): void {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, relative);
  // Refuse anything that escapes the public directory.
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  const body = readFileSync(filePath);
  response.writeHead(200, {
    "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream",
    "content-length": body.length,
    "cache-control": "no-cache",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<ExperimentBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as ExperimentBody;
  } catch {
    throw new HttpError(400, "request body must be JSON");
  }
}

/** Numbers in a query string, with a fallback. */
function num(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const segments = url.pathname.split("/").filter((part) => part.length > 0);

  if (segments[0] !== "api") {
    sendStatic(response, url.pathname);
    return;
  }

  // GET /api/sessions
  if (segments.length === 2 && segments[1] === "sessions") {
    sendJson(response, 200, { sessions: sessionSummaries() });
    return;
  }

  const id = segments[2];
  if (segments[1] !== "sessions" || !id) throw new HttpError(404, "unknown endpoint");
  if (!existsSync(path.join(SESSIONS_DIR, `${id}.jsonl`))) {
    throw new HttpError(404, `no session '${id}'`);
  }
  const session = loadSession(id);

  // GET /api/sessions/:id
  if (segments.length === 3) {
    const scenario = scenarioById(id);
    sendJson(response, 200, {
      id,
      label: scenario?.label ?? session.config.label,
      tagline: scenario?.tagline ?? "",
      description: session.config.description,
      config: session.config,
      events: session.root.length(),
      headHash: session.store?.headHash ?? null,
      anchored: session.store?.anchored ?? false,
      tree: session.tree(),
      timeline: timelineNode(session.root),
      interest: loadInterest(id),
      checkpoints: session.root.checkpointKeys(),
      integrity: session.root.checkpointIntegrity(),
    });
    return;
  }

  const resource = segments[3];

  // GET /api/sessions/:id/state?at=&timeline=
  if (resource === "state" && request.method === "GET") {
    const timeline = session.get(url.searchParams.get("timeline") ?? "root");
    const at = num(url.searchParams.get("at"), timeline.length());
    sendJson(response, 200, stateResponse(session, timeline, at));
    return;
  }

  // GET /api/sessions/:id/events?from=&to=&timeline=
  if (resource === "events" && request.method === "GET") {
    const timeline = session.get(url.searchParams.get("timeline") ?? "root");
    const from = Math.max(0, num(url.searchParams.get("from"), 0));
    const to = Math.min(timeline.length(), num(url.searchParams.get("to"), from + 200));
    const events = timeline.resolved().slice(from, to);
    sendJson(response, 200, {
      timeline: timelineNode(timeline),
      from,
      to,
      total: timeline.length(),
      events: tapeView(events, timeline),
    });
    return;
  }

  // GET /api/sessions/:id/verify
  if (resource === "verify" && request.method === "GET") {
    let verification = verifyCache.get(id);
    if (!verification) {
      verification = session.verify();
      verifyCache.set(id, verification);
    }
    sendJson(response, 200, {
      ...verification,
      headHash: session.store?.headHash ?? null,
      checkpointIntegrity: session.root.checkpointIntegrity(),
      stats: session.root.stats,
    });
    return;
  }

  // GET /api/sessions/:id/experiments  (the prepared ones)
  if (resource === "experiments" && request.method === "GET") {
    sendJson(response, 200, {
      interest: loadInterest(id),
      results: preparedExperiments(id),
    });
    return;
  }

  // POST /api/sessions/:id/experiment  (an ad-hoc one)
  if (resource === "experiment" && request.method === "POST") {
    const body = await readBody(request);
    sendJson(response, 200, experimentFromBody(session, body));
    return;
  }

  // POST /api/sessions/:id/command — drive a branch forward by hand
  if (resource === "command" && request.method === "POST") {
    const body = (await readBody(request)) as { timeline?: string; command?: Command; vt?: number };
    const timeline = session.get(body.timeline ?? "root");
    if (!body.command) throw new HttpError(400, "a command is required");
    const events = session.submit(timeline.id, body.command, body.vt);
    sendJson(response, 200, {
      timeline: timelineNode(timeline),
      events: tapeView(events, timeline),
      state: stateResponse(session, timeline, timeline.length()),
    });
    return;
  }

  // GET /api/sessions/:id/tamper?seq=&field=&value=
  if (resource === "tamper" && request.method === "GET") {
    const requested = num(url.searchParams.get("seq"), 0);
    const field = url.searchParams.get("field") ?? "qty";
    const events = session.root.resolved();
    const numeric = (index: number): boolean =>
      typeof (events[index]?.data as unknown as Record<string, unknown> | undefined)?.[field] === "number";

    // The most instructive forgery is a *fill*: a print whose quantity never
    // happened is still perfectly applicable event by event, so the hash chain
    // is the only thing standing between it and a clean verification... which is
    // precisely the point of also running the semantic layer.
    let seq = requested;
    if (!(numeric(seq) && events[seq]?.kind === "TRADE")) {
      const trade = events.findIndex((event, index) => index >= seq && event.kind === "TRADE" && numeric(index));
      if (trade >= 0) seq = trade;
      else {
        let probe = seq;
        while (!numeric(probe) && probe < events.length - 1 && probe - requested < 500) probe += 1;
        seq = probe;
      }
    }

    const original = events[seq];
    if (!original) throw new HttpError(404, `no event #${requested}`);
    const current = (original.data as unknown as Record<string, unknown>)[field];
    const lot = session.config.instrument.lotSize;
    const suggested = typeof current === "number" ? (current > lot ? current - lot : current + lot) : 0;
    const after = num(url.searchParams.get("value"), suggested);
    const key = `${id}|${seq}|${field}|${after}`;
    let report = tamperCache.get(key);
    if (!report) {
      report = tamperSession(id, seq, field, after);
      tamperCache.set(key, report);
    }
    sendJson(response, 200, {
      report,
      original: {
        seq,
        kind: original.kind,
        summary: describeEvent(original),
        field,
        current,
        requestedSeq: requested,
      },
    });
    return;
  }

  // GET /api/sessions/:id/preview?seq=&patch=field=value&drop=1
  // A cheap "what does this event look like as an edit" for the edit panel.
  if (resource === "preview" && request.method === "GET") {
    const seq = num(url.searchParams.get("seq"), 0);
    const original = session.root.eventAt(seq);
    if (!original) throw new HttpError(404, `no event #${seq}`);
    sendJson(response, 200, {
      seq,
      kind: original.kind,
      summary: describeEvent(original),
      data: original.data,
      editable: Object.entries(original.data as unknown as Record<string, unknown>)
        .filter(([, value]) => typeof value === "number")
        .map(([key, value]) => ({ key, value: value as number })),
    });
    return;
  }

  throw new HttpError(404, `unknown endpoint '${url.pathname}'`);
}

// `||` rather than `??`: an empty PORT (which keeps turning up in host
// environments) would otherwise be read as port 0 and pick a random one.
const port = Number(process.env.PORT || 4_173) || 4_173;
const host = process.env.HOST || "127.0.0.1";

const ids = listSessionIds();
if (ids.length === 0) {
  console.error("No sessions on disk. Run `npm run seed` first.");
  process.exit(1);
}

const server = createServer((request, response) => {
  handle(request, response).catch((error: unknown) => {
    if (error instanceof HttpError) {
      sendJson(response, error.status, { error: error.message });
      return;
    }
    console.error(error);
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

server.listen(port, host, () => {
  console.log(`chronofork listening on http://${host}:${port}`);
  console.log(`  ${ids.length} sessions: ${ids.join(", ")}`);
  console.log(`  scenarios: ${SCENARIOS.map((scenario) => scenario.id).join(", ")}`);
});
