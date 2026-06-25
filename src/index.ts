import "dotenv/config";
import {
  ExchangeClient,
  Side,
  formatWad,
  parseWad,
  type Position,
  type Market,
} from "risex-client";

const ACCOUNT_ADDRESS = process.env.ACCOUNT_ADDRESS!;
const SIGNER_PRIVATE_KEY = process.env.SIGNER_PRIVATE_KEY!;
const TARGET_ADDRESS =
  process.env.TARGET_ADDRESS ||
  "0x00FA797B694Ecf18B71d8Bbe83612392364A1Ea1";

const TARGET_BALANCE_USD = parseFloat(process.env.TARGET_BALANCE_USD || "4500");
const MY_BALANCE_USD = parseFloat(process.env.MY_BALANCE_USD || "100");
const FIXED_LEVERAGE = parseInt(process.env.FIXED_LEVERAGE || "20", 10);
const MIN_ORDER_VOLUME_USD = parseFloat(process.env.MIN_ORDER_VOLUME_USD || "1.5");
const MAX_POSITIONS = parseInt(process.env.MAX_POSITIONS || "3", 10);
const MAX_DAILY_LOSS_USD = parseFloat(process.env.MAX_DAILY_LOSS_USD || "20");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "2000", 10);

const API_URL = "https://api.rise.trade";
const WS_URL = "wss://ws.rise.trade";

if (!ACCOUNT_ADDRESS || !SIGNER_PRIVATE_KEY) {
  console.error("Missing ACCOUNT_ADDRESS or SIGNER_PRIVATE_KEY in .env");
  process.exit(1);
}

const BASE_RATIO = MY_BALANCE_USD / TARGET_BALANCE_USD;

interface TrackedPosition {
  size: bigint;
  side: Side;
}

const targetPositions = new Map<number, TrackedPosition>();
let exchange: ExchangeClient;
let markets: Market[] = [];

let dailyLoss = 0;
let dailyLossResetDate = todayDateStr();

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function checkAndResetDailyLoss() {
  const today = todayDateStr();
  if (today !== dailyLossResetDate) {
    dailyLoss = 0;
    dailyLossResetDate = today;
    console.log("[RISK] Daily loss counter reset");
  }
}

function canTrade(): boolean {
  checkAndResetDailyLoss();
  if (dailyLoss >= MAX_DAILY_LOSS_USD) {
    console.warn(`[RISK] Daily loss limit reached ($${dailyLoss.toFixed(2)} / $${MAX_DAILY_LOSS_USD}), skipping trade`);
    return false;
  }
  return true;
}

function marketIdNum(id: string | number): number {
  return typeof id === "string" ? parseInt(id, 10) : id;
}

function getMarketConfig(marketId: number) {
  return markets.find((m) => parseInt(m.market_id, 10) === marketId);
}

function sizeToSteps(size: bigint, stepSize: string): number {
  const step = parseWad(stepSize);
  if (step === 0n) return 0;
  return Number(size / step);
}

function getMarkPrice(market: Market): number {
  return parseFloat(formatWad(market.mark_price));
}

function scaleSize(targetSizeWad: bigint, market: Market): bigint {
  let scaled = (targetSizeWad * BigInt(Math.round(BASE_RATIO * 1e8))) / 100_000_000n;

  const markPrice = getMarkPrice(market);
  if (markPrice <= 0) return scaled;

  const sizeFloat = parseFloat(formatWad(scaled.toString()));
  const volumeUsd = sizeFloat * markPrice;

  if (volumeUsd < MIN_ORDER_VOLUME_USD) {
    const minSize = MIN_ORDER_VOLUME_USD / markPrice;
    scaled = parseWad(minSize.toFixed(18));
  }

  const maxVolumePerPosition = (MY_BALANCE_USD * FIXED_LEVERAGE) / MAX_POSITIONS;
  if (volumeUsd > maxVolumePerPosition) {
    const cappedSize = maxVolumePerPosition / markPrice;
    scaled = parseWad(cappedSize.toFixed(18));
    console.log(`[RISK] Capped position to $${maxVolumePerPosition.toFixed(2)} notional`);
  }

  return scaled;
}

async function handleChange(mktId: number, newSizeWad: bigint, newSide: Side) {
  const market = getMarketConfig(mktId);
  if (!market) {
    console.warn(`Unknown market ${mktId}, skipping`);
    return;
  }

  const prev = targetPositions.get(mktId);
  const prevSize = prev?.size ?? 0n;
  const prevSide = prev?.side ?? Side.Long;

  const stepSize = market.config.step_size;

  // Target fully closed
  if (newSizeWad === 0n && prevSize > 0n) {
    console.log(`[COPY] Target fully closed on ${market.display_name} → closing our position`);
    try {
      const result = await exchange.closePosition(mktId);
      if (result) {
        console.log(`[COPY] Closed position on ${market.display_name}: tx=${result.tx_hash}`);
      } else {
        console.log(`[COPY] No position to close on ${market.display_name}`);
      }
    } catch (err) {
      console.error(`[COPY] Failed to close on ${market.display_name}:`, err);
    }
    return;
  }

  // Target opened new position
  if (prevSize === 0n && newSizeWad > 0n) {
    if (!canTrade()) return;

    if (targetPositions.size >= MAX_POSITIONS) {
      console.warn(`[RISK] Max ${MAX_POSITIONS} positions reached, skipping new position on ${market.display_name}`);
      return;
    }

    const copySize = scaleSize(newSizeWad, market);
    const steps = sizeToSteps(copySize, stepSize);
    if (steps <= 0) {
      console.warn(`[COPY] Calculated 0 steps for ${market.display_name}, skipping`);
      return;
    }

    const markPrice = getMarkPrice(market);
    const notional = parseFloat(formatWad(copySize.toString())) * markPrice;
    console.log(
      `[COPY] Target opened ${newSide === Side.Long ? "LONG" : "SHORT"} on ${market.display_name} ` +
      `| Target size: ${formatWad(newSizeWad.toString())} | Our size: ${formatWad(copySize.toString())} (~$${notional.toFixed(2)})`
    );

    try {
      const result =
        newSide === Side.Long
          ? await exchange.marketBuy(mktId, steps)
          : await exchange.marketSell(mktId, steps);
      console.log(`[COPY] Opened position: tx=${result.tx_hash}`);
    } catch (err) {
      console.error(`[COPY] Failed to open on ${market.display_name}:`, err);
    }
    return;
  }

  // Target flipped side
  if (prevSize > 0n && newSizeWad > 0n && prevSide !== newSide) {
    console.log(`[COPY] Target flipped on ${market.display_name} → closing & reopening`);
    try {
      const closeResult = await exchange.closePosition(mktId);
      if (closeResult) {
        console.log(`[COPY] Closed old position: tx=${closeResult.tx_hash}`);
      }

      if (!canTrade()) return;

      const copySize = scaleSize(newSizeWad, market);
      const steps = sizeToSteps(copySize, stepSize);
      if (steps > 0) {
        const result =
          newSide === Side.Long
            ? await exchange.marketBuy(mktId, steps)
            : await exchange.marketSell(mktId, steps);
        console.log(`[COPY] Opened flipped position: tx=${result.tx_hash}`);
      }
    } catch (err) {
      console.error(`[COPY] Failed to flip on ${market.display_name}:`, err);
    }
    return;
  }

  // Target increased or decreased same-side position
  if (prevSize > 0n && newSizeWad > 0n && prevSide === newSide) {
    const sizeDelta = newSizeWad - prevSize;
    if (sizeDelta === 0n) return;

    if (sizeDelta > 0n) {
      if (!canTrade()) return;

      const scaledDelta = scaleSize(sizeDelta, market);
      const steps = sizeToSteps(scaledDelta, stepSize);
      if (steps <= 0) return;

      const markPrice = getMarkPrice(market);
      const notional = parseFloat(formatWad(scaledDelta.toString())) * markPrice;
      console.log(`[COPY] Target increased on ${market.display_name} | +${formatWad(scaledDelta.toString())} (~$${notional.toFixed(2)})`);

      try {
        const result =
          newSide === Side.Long
            ? await exchange.marketBuy(mktId, steps)
            : await exchange.marketSell(mktId, steps);
        console.log(`[COPY] Increased position: tx=${result.tx_hash}`);
      } catch (err) {
        console.error(`[COPY] Failed to increase:`, err);
      }
    } else {
      const reduction = -sizeDelta;
      const reductionRatio = Number((reduction * 10000n) / prevSize) / 10000;

      if (reductionRatio > 0.95) {
        console.log(`[COPY] Target closed ~100% on ${market.display_name} → closing our position`);
        try {
          const result = await exchange.closePosition(mktId);
          if (result) console.log(`[COPY] Closed position: tx=${result.tx_hash}`);
        } catch (err) {
          console.error(`[COPY] Failed to close:`, err);
        }
        return;
      }

      const myPositions = await exchange.info.getAllPositions(ACCOUNT_ADDRESS);
      const myPos = myPositions.find((p) => parseInt(p.market_id, 10) === mktId);
      if (!myPos) {
        console.warn(`[COPY] No position found to reduce on ${market.display_name}`);
        return;
      }

      const mySizeWad = parseWad(myPos.size);
      const closeAmount = BigInt(Math.round(Number(mySizeWad) * reductionRatio));
      const steps = sizeToSteps(closeAmount, stepSize);
      if (steps <= 0) return;

      const markPrice = getMarkPrice(market);
      const notional = parseFloat(formatWad(closeAmount.toString())) * markPrice;
      console.log(
        `[COPY] Target reduced ${(reductionRatio * 100).toFixed(1)}% on ${market.display_name} ` +
        `| Closing ${formatWad(closeAmount.toString())} (~$${notional.toFixed(2)})`
      );

      try {
        const result =
          newSide === Side.Long
            ? await exchange.marketSell(mktId, steps, true)
            : await exchange.marketBuy(mktId, steps);
        console.log(`[COPY] Reduced position: tx=${result.tx_hash}`);

        const pnl = myPos.unrealized_pnl ? parseFloat(formatWad(myPos.unrealized_pnl)) : 0;
        if (pnl < 0) {
          dailyLoss += Math.abs(pnl) * reductionRatio;
          console.log(`[RISK] Daily loss now: $${dailyLoss.toFixed(2)} / $${MAX_DAILY_LOSS_USD}`);
        }
      } catch (err) {
        console.error(`[COPY] Failed to reduce:`, err);
      }
    }
  }
}

async function pollTargetPositions() {
  try {
    const positions = await exchange.info.getAllPositions(TARGET_ADDRESS);

    const currentSnapshot = new Map<number, { size: bigint; side: Side }>();
    for (const pos of positions) {
      const size = parseWad(pos.size);
      if (size > 0n) {
        currentSnapshot.set(parseInt(pos.market_id, 10), {
          size,
          side: pos.side as Side,
        });
      }
    }

    const allMarketIds = new Set([
      ...targetPositions.keys(),
      ...currentSnapshot.keys(),
    ]);

    for (const mktId of allMarketIds) {
      const prev = targetPositions.get(mktId);
      const curr = currentSnapshot.get(mktId);

      const prevSize = prev?.size ?? 0n;
      const prevSide = prev?.side ?? Side.Long;
      const currSize = curr?.size ?? 0n;
      const currSide = curr?.side ?? Side.Long;

      if (currSize === prevSize && currSide === prevSide) continue;

      await handleChange(mktId, currSize, currSide);
    }

    // Update snapshot after processing all changes
    targetPositions.clear();
    for (const [mktId, pos] of currentSnapshot) {
      targetPositions.set(mktId, pos);
    }
  } catch (err) {
    console.error("[POLL] Failed to fetch target positions:", err);
  }
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

async function main() {
  console.log("=== RISEx Copy Trade Bot ===");
  console.log(`Account:    ${ACCOUNT_ADDRESS}`);
  console.log(`Target:     ${TARGET_ADDRESS}`);
  console.log(`Mode:       proportional (${MY_BALANCE_USD}$ / ${TARGET_BALANCE_USD}$ = ${(BASE_RATIO * 100).toFixed(2)}%)`);
  console.log(`Leverage:   x${FIXED_LEVERAGE}`);
  console.log(`Min order:  $${MIN_ORDER_VOLUME_USD}`);
  console.log(`Max pos:    ${MAX_POSITIONS}`);
  console.log(`Max loss:   $${MAX_DAILY_LOSS_USD}/day`);
  console.log(`Poll:       every ${POLL_INTERVAL_MS}ms`);
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

  console.log(`[BOT] Polling target positions every ${POLL_INTERVAL_MS}ms...`);
  setInterval(pollTargetPositions, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
