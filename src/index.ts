import "dotenv/config";
import {
  ExchangeClient,
  WebSocketClient,
  Side,
  formatWad,
  parseWad,
  type WsMessage,
  type WsPositionUpdate,
  type Market,
} from "risex-client";
import { ethers } from "ethers";

const ACCOUNT_ADDRESS = process.env.ACCOUNT_ADDRESS!;
const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY!;
const TARGET_ADDRESS =
  process.env.TARGET_ADDRESS ||
  "0x00FA797B694Ecf18B71d8Bbe83612392364A1Ea1";
const COPY_RATIO = parseFloat(process.env.COPY_RATIO || "1.0");

const API_URL = "https://api.risex.trade";
const WS_URL = "wss://ws.risex.trade";

if (!ACCOUNT_ADDRESS || !SIGNER_PRIVATE_KEY) {
  console.error("Missing ACCOUNT_ADDRESS or SIGNER_PRIVATE_KEY in .env");
  process.exit(1);
}

interface TrackedPosition {
  size: bigint;
  side: Side;
}

const targetPositions = new Map<number, TrackedPosition>();
let exchange: ExchangeClient;
let markets: Market[] = [];
let processing = false;
const pendingQueue: WsPositionUpdate[] = [];

function marketIdNum(id: string | number): number {
  return typeof id === "string" ? parseInt(id, 10) : id;
}

function getMarketConfig(marketId: number) {
  return markets.find((m) => parseInt(m.market_id, 10) === marketId);
}

function sizeToSteps(size: bigint, stepSize: string): number {
  const step = parseWad(stepSize);
  return Number(size / step);
}

function applyRatio(size: bigint): bigint {
  if (COPY_RATIO === 1.0) return size;
  const scaled = (size * BigInt(Math.round(COPY_RATIO * 1e6))) / 1_000_000n;
  return scaled;
}

async function handlePositionUpdate(update: WsPositionUpdate) {
  const mktId = marketIdNum(update.market_id);
  const market = getMarketConfig(mktId);
  if (!market) {
    console.warn(`Unknown market ${mktId}, skipping`);
    return;
  }

  const newSizeWad = parseWad(update.size);
  const newSide: Side = update.side;
  const prev = targetPositions.get(mktId);

  const prevSize = prev?.size ?? 0n;
  const prevSide = prev?.side ?? Side.Long;

  if (newSizeWad === 0n) {
    targetPositions.delete(mktId);
  } else {
    targetPositions.set(mktId, { size: newSizeWad, side: newSide });
  }

  const stepSize = market.config.step_size;

  if (newSizeWad === 0n && prevSize > 0n) {
    console.log(`[COPY] Target closed position on market ${market.display_name}`);
    try {
      const result = await exchange.closePosition(mktId);
      if (result) {
        console.log(`[COPY] Closed position on ${market.display_name}: tx=${result.tx_hash}`);
      } else {
        console.log(`[COPY] No position to close on ${market.display_name}`);
      }
    } catch (err) {
      console.error(`[COPY] Failed to close position on ${market.display_name}:`, err);
    }
    return;
  }

  if (prevSize === 0n && newSizeWad > 0n) {
    const copySize = applyRatio(newSizeWad);
    const steps = sizeToSteps(copySize, stepSize);
    if (steps <= 0) {
      console.warn(`[COPY] Calculated 0 steps for market ${market.display_name}, skipping`);
      return;
    }
    console.log(
      `[COPY] Target opened ${newSide === Side.Long ? "LONG" : "SHORT"} ${formatWad(copySize.toString())} on ${market.display_name}`
    );
    try {
      const result =
        newSide === Side.Long
          ? await exchange.marketBuy(mktId, steps)
          : await exchange.marketSell(mktId, steps);
      console.log(`[COPY] Opened position: tx=${result.tx_hash}`);
    } catch (err) {
      console.error(`[COPY] Failed to open position on ${market.display_name}:`, err);
    }
    return;
  }

  if (prevSize > 0n && newSizeWad > 0n && prevSide !== newSide) {
    console.log(`[COPY] Target flipped position on ${market.display_name}`);
    try {
      const closeResult = await exchange.closePosition(mktId);
      if (closeResult) {
        console.log(`[COPY] Closed old position: tx=${closeResult.tx_hash}`);
      }
      const copySize = applyRatio(newSizeWad);
      const steps = sizeToSteps(copySize, stepSize);
      if (steps > 0) {
        const result =
          newSide === Side.Long
            ? await exchange.marketBuy(mktId, steps)
            : await exchange.marketSell(mktId, steps);
        console.log(`[COPY] Opened flipped position: tx=${result.tx_hash}`);
      }
    } catch (err) {
      console.error(`[COPY] Failed to flip position on ${market.display_name}:`, err);
    }
    return;
  }

  if (prevSize > 0n && newSizeWad > 0n && prevSide === newSide) {
    const sizeDelta = newSizeWad - prevSize;
    if (sizeDelta === 0n) return;

    const copyDelta = applyRatio(sizeDelta > 0n ? sizeDelta : -sizeDelta);
    const steps = sizeToSteps(copyDelta, stepSize);
    if (steps <= 0) return;

    if (sizeDelta > 0n) {
      console.log(`[COPY] Target increased position on ${market.display_name} by ${formatWad(copyDelta.toString())}`);
      try {
        const result =
          newSide === Side.Long
            ? await exchange.marketBuy(mktId, steps)
            : await exchange.marketSell(mktId, steps);
        console.log(`[COPY] Increased position: tx=${result.tx_hash}`);
      } catch (err) {
        console.error(`[COPY] Failed to increase position:`, err);
      }
    } else {
      console.log(`[COPY] Target decreased position on ${market.display_name} by ${formatWad(copyDelta.toString())}`);
      try {
        const result =
          newSide === Side.Long
            ? await exchange.marketSell(mktId, steps, true)
            : await exchange.marketBuy(mktId, steps);
        console.log(`[COPY] Decreased position: tx=${result.tx_hash}`);
      } catch (err) {
        console.error(`[COPY] Failed to decrease position:`, err);
      }
    }
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (pendingQueue.length > 0) {
    const update = pendingQueue.shift()!;
    await handlePositionUpdate(update);
  }
  processing = false;
}

async function initTargetPositions() {
  console.log(`[INIT] Fetching current positions for target ${TARGET_ADDRESS}`);
  const positions = await exchange.info.getAllPositions(TARGET_ADDRESS);
  for (const pos of positions) {
    const size = parseWad(pos.size);
    if (size > 0n) {
      targetPositions.set(parseInt(pos.market_id, 10), {
        size,
        side: pos.side as Side,
      });
      console.log(
        `[INIT] Target has ${pos.side === Side.Long ? "LONG" : "SHORT"} ${formatWad(pos.size)} on market ${pos.market_id}`
      );
    }
  }
}

async function connectWebSocket() {
  const ws = new WebSocketClient({ wsUrl: WS_URL, logLevel: "info" });

  ws.on("open", () => {
    console.log("[WS] Connected");
    ws.subscribe({
      channel: "positions",
      makers: [TARGET_ADDRESS],
    });
    console.log(`[WS] Subscribed to positions for ${TARGET_ADDRESS}`);
  });

  ws.on("close", () => {
    console.log("[WS] Disconnected, will auto-reconnect...");
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err);
  });

  ws.onChannel("positions", (msg: WsMessage) => {
    const data = msg.data as WsPositionUpdate | WsPositionUpdate[];
    const updates = Array.isArray(data) ? data : [data];
    for (const update of updates) {
      pendingQueue.push(update);
    }
    processQueue();
  });

  await ws.connect();
  return ws;
}

async function main() {
  console.log("=== RISEx Copy Trade Bot ===");
  console.log(`Account:  ${ACCOUNT_ADDRESS}`);
  console.log(`Target:   ${TARGET_ADDRESS}`);
  console.log(`Ratio:    ${COPY_RATIO}`);
  console.log();

  exchange = new ExchangeClient({
    baseUrl: API_URL,
    wsUrl: WS_URL,
    account: ACCOUNT_ADDRESS,
    signerKey: SIGNER_PRIVATE_KEY,
    logLevel: "info",
  });

  await exchange.init();
  console.log("[INIT] Exchange client initialized");

  markets = await exchange.info.getMarkets();
  console.log(`[INIT] Loaded ${markets.length} markets`);

  await initTargetPositions();
  await connectWebSocket();

  console.log("[BOT] Listening for target position changes...");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
