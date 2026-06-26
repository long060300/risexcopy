import "dotenv/config";
import axios from "axios";
import {
  ExchangeClient,
  type Market,
} from "risex-client";
import * as fs from "fs";
import * as path from "path";

// ── Config ──────────────────────────────────────────────────
const ACCOUNT_ADDRESS = process.env.ACCOUNT_ADDRESS!;
const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY!;
const TARGET_ADDRESS =
  process.env.TARGET_ADDRESS ||
  "0x00FA797B694Ecf18B71d8Bbe83612392364A1Ea1";

const TARGET_BALANCE_USD = parseFloat(process.env.TARGET_BALANCE_USD || "4500");
const MY_BALANCE_USD = parseFloat(process.env.MY_BALANCE_USD || "100");
const FIXED_LEVERAGE = parseInt(process.env.FIXED_LEVERAGE || "20", 10);
const MIN_ORDER_VOLUME_USD = parseFloat(process.env.MIN_ORDER_VOLUME_USD || "10");
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || "3", 10);
const MAX_DAILY_LOSS_USD = parseFloat(process.env.MAX_DAILY_LOSS_USD || "20");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "3000", 10);

const RISEX_API_URL = process.env.RISEX_API_URL || "https://api.risex.trade";
const RISEX_WS_URL = process.env.RISEX_WS_URL || "wss://ws.risex.trade";
const SCREENER_API = "https://risescreener.com/api/address";

const STATE_FILE = path.join(__dirname, "..", "state.json");

if (!ACCOUNT_ADDRESS || !SIGNER_PRIVATE_KEY) {
  console.error("Missing ACCOUNT_ADDRESS or SIGNER_PRIVATE_KEY in .env");
  process.exit(1);
}

const BASE_RATIO = MY_BALANCE_USD / TARGET_BALANCE_USD;

// ── Types ───────────────────────────────────────────────────
interface ScreenerFill {
  id: string;
  market_id: string;
  order_id: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  time: string;
  position_side: "BUY" | "SELL";
  realized_pnl: string;
  leverage: string;
  is_liquidation: boolean;
  is_otc: boolean;
}

interface ScreenerResponse {
  account: string;
  balance: number;
  positions: Array<{
    market_id: string;
    side: string;
    size: string;
    entry_price: string;
    [key: string]: unknown;
  }>;
  fills: ScreenerFill[];
  symbols: Record<string, string>;
}

interface AggregatedOrder {
  order_id: string;
  market_id: number;
  side: "BUY" | "SELL";
  position_side: "BUY" | "SELL";
  total_size: number;
  avg_price: number;
  realized_pnl: number;
  is_closing: boolean;
  timestamp: string;
}

interface BotState {
  last_seen_fill_time: string;
  last_seen_fill_ids: string[];
  daily_loss: number;
  daily_loss_date: string;
  my_positions: Record<number, { side: string; size: number }>;
}

// ── Globals ─────────────────────────────────────────────────
let exchange: ExchangeClient;
let markets: Market[] = [];
let symbols: Record<string, string> = {};
let state: BotState = {
  last_seen_fill_time: "0",
  last_seen_fill_ids: [],
  daily_loss: 0,
  daily_loss_date: todayStr(),
  my_positions: {},
};

// ── Helpers ─────────────────────────────────────────────────
function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function loadState(): BotState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return state;
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getMarket(marketId: number): Market | undefined {
  return markets.find((m) => parseInt(m.market_id, 10) === marketId);
}

function sizeToSteps(size: number, stepSize: number): number {
  return Math.floor(size / stepSize);
}

function checkDailyLoss(): boolean {
  const today = todayStr();
  if (today !== state.daily_loss_date) {
    state.daily_loss = 0;
    state.daily_loss_date = today;
    log("RISK", "Daily loss counter reset");
  }
  if (state.daily_loss >= MAX_DAILY_LOSS_USD) {
    log("RISK", `Daily loss limit reached ($${state.daily_loss.toFixed(2)} / $${MAX_DAILY_LOSS_USD})`);
    return false;
  }
  return true;
}

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}][${tag}] ${msg}`);
}

// ── Screener Polling ────────────────────────────────────────
async function fetchScreenerData(): Promise<ScreenerResponse> {
  const { data } = await axios.get<ScreenerResponse>(
    `${SCREENER_API}/${TARGET_ADDRESS}`,
    { timeout: 10000 }
  );
  return data;
}

function aggregateFills(fills: ScreenerFill[]): AggregatedOrder[] {
  const byOrder = new Map<string, ScreenerFill[]>();
  for (const fill of fills) {
    const existing = byOrder.get(fill.order_id) || [];
    existing.push(fill);
    byOrder.set(fill.order_id, existing);
  }

  const orders: AggregatedOrder[] = [];
  for (const [order_id, orderFills] of byOrder) {
    const first = orderFills[0];
    let totalSize = 0;
    let totalNotional = 0;
    let totalPnl = 0;

    for (const f of orderFills) {
      const size = parseFloat(f.size);
      totalSize += size;
      totalNotional += size * parseFloat(f.price);
      totalPnl += parseFloat(f.realized_pnl);
    }

    orders.push({
      order_id,
      market_id: parseInt(first.market_id, 10),
      side: first.side,
      position_side: first.position_side,
      total_size: totalSize,
      avg_price: totalSize > 0 ? totalNotional / totalSize : 0,
      realized_pnl: totalPnl,
      is_closing: totalPnl !== 0,
      timestamp: first.time,
    });
  }

  return orders.sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
}

function findNewFills(fills: ScreenerFill[]): ScreenerFill[] {
  const lastTime = state.last_seen_fill_time;
  const seenIds = new Set(state.last_seen_fill_ids);

  return fills.filter((f) => {
    if (f.time > lastTime) return true;
    if (f.time === lastTime && !seenIds.has(f.id)) return true;
    return false;
  });
}

// ── Copy Trading ────────────────────────────────────────────
function scaleSize(targetSize: number, marketPrice: number): number {
  let scaled = targetSize * BASE_RATIO;

  const volumeUsd = scaled * marketPrice;

  if (volumeUsd < MIN_ORDER_VOLUME_USD) {
    scaled = MIN_ORDER_VOLUME_USD / marketPrice;
  }

  const maxVolumePerPos = (MY_BALANCE_USD * FIXED_LEVERAGE) / MAX_POSITIONS;
  if (volumeUsd > maxVolumePerPos) {
    scaled = maxVolumePerPos / marketPrice;
    log("RISK", `Capped to $${maxVolumePerPos.toFixed(2)} notional`);
  }

  return scaled;
}

async function copyOrder(order: AggregatedOrder, targetPositions: ScreenerResponse["positions"]) {
  const market = getMarket(order.market_id);
  if (!market) {
    log("COPY", `Unknown market ${order.market_id}, skipping`);
    return;
  }

  const symbol = symbols[order.market_id.toString()] || `M${order.market_id}`;
  const stepSize = parseFloat(market.config.step_size);

  if (order.is_closing) {
    const targetStillHasPosition = targetPositions.some(
      (p) => parseInt(p.market_id, 10) === order.market_id
    );

    if (targetStillHasPosition) {
      // Partial close — target still has a position, reduce ours proportionally
      const myPos = state.my_positions[order.market_id];
      if (!myPos) {
        log("COPY", `Target partial closed ${symbol} but we have no position, skipping`);
        return;
      }

      const targetRemaining = targetPositions.find(
        (p) => parseInt(p.market_id, 10) === order.market_id
      )!;
      const remainingSize = parseFloat(targetRemaining.size);
      const closedSize = order.total_size;
      const totalBefore = remainingSize + closedSize;
      const reductionRatio = closedSize / totalBefore;

      const reduceAmount = myPos.size * reductionRatio;
      const reduceNotional = reduceAmount * order.avg_price;

      if (reduceNotional < MIN_ORDER_VOLUME_USD) {
        log("COPY", `Partial close on ${symbol} too small ($${reduceNotional.toFixed(2)} < $${MIN_ORDER_VOLUME_USD}), skipping`);
        return;
      }

      const steps = sizeToSteps(reduceAmount, stepSize);
      if (steps <= 0) return;

      log("COPY", `Target partial closed ${(reductionRatio * 100).toFixed(1)}% of ${symbol} | Reducing ${reduceAmount.toFixed(6)} (~$${reduceNotional.toFixed(2)})`);

      try {
        const result =
          myPos.side === "BUY"
            ? await exchange.marketSell(order.market_id, steps, true)
            : await exchange.marketBuy(order.market_id, steps);
        log("COPY", `Reduced ${symbol}: tx=${result.tx_hash}`);
        myPos.size -= reduceAmount;
        if (myPos.size <= 0) delete state.my_positions[order.market_id];
        saveState();
      } catch (err) {
        log("COPY", `Failed to reduce ${symbol}: ${(err as Error).message}`);
      }
    } else {
      // Full close — target has no remaining position
      log("COPY", `Target FULLY CLOSED ${symbol} | PnL: $${order.realized_pnl.toFixed(2)}`);

      try {
        const result = await exchange.closePosition(order.market_id);
        if (result) {
          log("COPY", `Closed ${symbol}: tx=${result.tx_hash}`);
        } else {
          log("COPY", `No position to close on ${symbol}`);
        }
        delete state.my_positions[order.market_id];
        saveState();
      } catch (err) {
        log("COPY", `Failed to close ${symbol}: ${(err as Error).message}`);
      }
    }
    return;
  }

  // Target is opening a position
  if (!checkDailyLoss()) return;

  const activeCount = Object.keys(state.my_positions).length;
  if (activeCount >= MAX_POSITIONS) {
    log("RISK", `Max ${MAX_POSITIONS} positions, skipping ${symbol}`);
    return;
  }

  const copySize = scaleSize(order.total_size, order.avg_price);
  const steps = sizeToSteps(copySize, stepSize);
  if (steps <= 0) {
    log("COPY", `0 steps for ${symbol}, skipping`);
    return;
  }

  const notional = copySize * order.avg_price;
  const copySide = order.side === "BUY" ? "LONG" : "SHORT";

  log(
    "COPY",
    `Target opened ${copySide} ${symbol} | ` +
    `Target: ${order.total_size.toFixed(6)} @ $${order.avg_price.toFixed(1)} | ` +
    `Ours: ${copySize.toFixed(6)} (~$${notional.toFixed(2)}) | ${steps} steps`
  );

  try {
    const result =
      order.side === "BUY"
        ? await exchange.marketBuy(order.market_id, steps)
        : await exchange.marketSell(order.market_id, steps);

    log("COPY", `Opened ${copySide} ${symbol}: tx=${result.tx_hash}`);
    state.my_positions[order.market_id] = { side: order.side, size: copySize };
    saveState();

  } catch (err) {
    log("COPY", `Failed to open ${symbol}: ${(err as Error).message}`);
  }
}

// ── Main Poll Loop ──────────────────────────────────────────
async function poll() {
  try {
    const data = await fetchScreenerData();
    symbols = data.symbols;

    const newFills = findNewFills(data.fills);
    if (newFills.length === 0) return;

    log("POLL", `${newFills.length} new fills detected`);

    const orders = aggregateFills(newFills);
    for (const order of orders) {
      await copyOrder(order, data.positions);
    }

    // Update state with latest fill time
    const allTimes = newFills.map((f) => f.time);
    const maxTime = allTimes.reduce((a, b) => (a > b ? a : b));
    state.last_seen_fill_time = maxTime;
    state.last_seen_fill_ids = newFills
      .filter((f) => f.time === maxTime)
      .map((f) => f.id);
    saveState();
  } catch (err) {
    log("POLL", `Error: ${(err as Error).message}`);
  }
}

// ── Startup ─────────────────────────────────────────────────
async function main() {
  console.log("=== RISEx Copy Trade Bot ===");
  console.log(`Account:    ${ACCOUNT_ADDRESS}`);
  console.log(`Target:     ${TARGET_ADDRESS}`);
  console.log(`Ratio:      ${(BASE_RATIO * 100).toFixed(2)}% ($${MY_BALANCE_USD} / $${TARGET_BALANCE_USD})`);
  console.log(`Leverage:   x${FIXED_LEVERAGE}`);
  console.log(`Min order:  $${MIN_ORDER_VOLUME_USD}`);
  console.log(`Max pos:    ${MAX_POSITIONS}`);
  console.log(`Max loss:   $${MAX_DAILY_LOSS_USD}/day`);
  console.log(`Poll:       every ${POLL_INTERVAL_MS}ms`);
  console.log();

  // Load persisted state
  state = loadState();
  log("INIT", `Loaded state: last fill time = ${state.last_seen_fill_time}`);

  // Init exchange client for placing orders
  exchange = new ExchangeClient({
    baseUrl: RISEX_API_URL,
    wsUrl: RISEX_WS_URL,
    account: ACCOUNT_ADDRESS,
    signerKey: SIGNER_PRIVATE_KEY,
    logLevel: "warn",
  });
  await exchange.init();
  log("INIT", "Exchange client initialized");

  // Load markets
  markets = await exchange.info.getMarkets();
  log("INIT", `Loaded ${markets.length} markets`);

  // Seed fill history so we don't copy old trades on first run
  if (state.last_seen_fill_time === "0") {
    log("INIT", "First run — seeding fill history...");
    const data = await fetchScreenerData();
    symbols = data.symbols;
    if (data.fills.length > 0) {
      const maxTime = data.fills.reduce((a, b) => (a.time > b.time ? a : b)).time;
      state.last_seen_fill_time = maxTime;
      state.last_seen_fill_ids = data.fills
        .filter((f) => f.time === maxTime)
        .map((f) => f.id);
      saveState();
      log("INIT", `Seeded with ${data.fills.length} historical fills, latest time: ${maxTime}`);
    }

    // Sync current target positions
    for (const pos of data.positions) {
      log("INIT", `Target has open position: ${symbols[pos.market_id] || pos.market_id} ${pos.side} ${pos.size}`);
    }
  }

  log("BOT", "Polling for new trades...");
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
