// Pump.fun Bot Sprint bot — launch scalper with a rug filter.
//
// Thesis, from the tape itself: almost every pump.fun launch is dead within
// the hour, and the only slice of its life that is reliably tradeable is the
// opening burst — the first seconds, when the creator's own buy and the
// first outside wallets hit the curve and the price steps up before the
// dump crowd arrives. So this bot buys only launches that pass a filter in
// their first slots, and is gone again within half a minute of slots:
// profit target, stop loss, hard time stop, and an instant exit the moment
// the creator sells. Stakes are small and flat so no single rug matters,
// and the account never holds more than a few positions at once.
//
// Speaks agent-fun/replay/v2 on stdin/stdout. No network, no files, no
// dependencies; a pure function of the batches it is fed.

import { createInterface } from "node:readline";

// ---------------------------------------------------------------- tunables
const CFG = {
  maxAge: 8, // slots after creation: the entry window
  minRealSolLamports: 500_000_000n, // 0.5 SOL: the curve must hold something
  maxRealSolLamports: 40_000_000_000n, // 40 SOL: later than this is not a launch
  maxBuyers: 4, // more distinct early buyers than this smells like a bundle
  minBuyers: 3, // a launch nobody else wants is not a burst, it is a trap
  minRunupX: 1.12, // price must already be stepping up at decision time
  minDevBuyLamports: 50_000_000n, // 0.05 SOL: the creator must have skin in it
  maxDevBuyLamports: 2_500_000_000n, // 2.5 SOL: a huge dev buy is a dump waiting
  maxSellShare: 0.2, // sells so far may be at most this share of volume
  maxRunupX: 2.2, // never chase a launch already up more than this
  stakeLamports: 100_000_000n, // 0.10 SOL: smaller stakes, smoother curve
  minBuyLamports: 10_000_000n, // the guardrail's round-trip floor: 0.01 SOL
  takeProfitX: 1.1, // +10% over average cost: bank wins sooner
  stopLossX: 0.92, // -8%: cut it sooner too
  maxHoldSlots: 40, // ~16 seconds of slots: out, whatever the tape says
  cashKeepLamports: 500_000_000n, // keep 0.5 SOL back for fees and margin
  buySlippageBps: 3000, // launches jump around; a refused buy costs nothing
  sellSlippageBps: 3000, // exits matter more than the last percent
};

interface Coin {
  createSlot: number;
  creator: string;
  createPrice: number;
  devBuyLamports: bigint;
  devSold: boolean;
  buyers: Set<string>;
  buyVolLamports: bigint;
  sellVolLamports: bigint;
  lastPrice: number;
  lastRealSolLamports: bigint;
  lastTradeSlot: number;
  complete: boolean;
  decided: boolean; // the entry window was judged, one way or the other
}

interface Held {
  entrySlot: number;
  sellPending: boolean;
  buyPending: boolean;
}

let caps = { maxOpen: 5, maxOrderBps: 100, maxOrdersPerBatch: 16 };
let orderCounter = 0;
const coins = new Map<string, Coin>();
const held = new Map<string, Held>();
const pending = new Map<string, { mint: string; side: string }>();

function nextId(): string {
  orderCounter += 1;
  return "s" + orderCounter.toString(36);
}

// ------------------------------------------------------------- event intake
function seeCoin(mint: string, slot: number): Coin {
  let c = coins.get(mint);
  if (!c) {
    c = {
      createSlot: slot,
      creator: "",
      createPrice: 0,
      devBuyLamports: 0n,
      devSold: false,
      buyers: new Set<string>(),
      buyVolLamports: 0n,
      sellVolLamports: 0n,
      lastPrice: 0,
      lastRealSolLamports: 0n,
      lastTradeSlot: slot,
      complete: false,
      decided: false,
    };
    coins.set(mint, c);
  }
  return c;
}

function priceOf(vSol: string, vTok: string): number {
  const t = Number(vTok);
  return t === 0 ? 0 : Number(vSol) / t;
}

function onCreate(ev: any, slot: number): void {
  const c = seeCoin(ev.mint, slot);
  c.createSlot = slot;
  c.creator = ev.creator;
  const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
  if (p > 0) {
    c.createPrice = p;
    c.lastPrice = p;
  }
  c.lastRealSolLamports = 0n; // a fresh curve holds no real SOL yet
}

function onTrade(ev: any, slot: number): void {
  const c = seeCoin(ev.mint, slot);
  const p = priceOf(ev.virtual_sol_reserves, ev.virtual_token_reserves);
  if (p > 0) c.lastPrice = p;
  if (c.createPrice === 0 && p > 0) c.createPrice = p;
  c.lastRealSolLamports = BigInt(ev.real_sol_reserves);
  c.lastTradeSlot = slot;
  const sol = BigInt(ev.sol_amount);
  if (ev.is_buy) {
    c.buyVolLamports += sol;
    if (ev.user === c.creator) {
      if (slot === c.createSlot) c.devBuyLamports += sol;
    } else if (c.buyers.size < 64) {
      c.buyers.add(ev.user);
    }
  } else {
    c.sellVolLamports += sol;
    if (ev.user === c.creator) c.devSold = true;
  }
}

function onFill(fill: any): void {
  const p = pending.get(fill.client_id);
  if (!p) return;
  pending.delete(fill.client_id);
  const h = held.get(p.mint);
  if (h) {
    if (p.side === "sell") h.sellPending = false;
    else h.buyPending = false;
  }
}

// ---------------------------------------------------------------- strategy
interface Order {
  side: string;
  client_id: string;
  mint: string;
  quote_lamports?: string;
  token_amount?: string;
  max_slippage_bps: number;
}

function decide(batch: any): Order[] {
  const slot: number = batch.slot;
  const account = batch.account;
  const cash = BigInt(account.cash_lamports);
  const accountHeld = new Map<string, { tokens: bigint; cost: bigint }>();
  for (const p of account.positions) {
    accountHeld.set(p.mint, { tokens: BigInt(p.token_amount), cost: BigInt(p.cost_lamports) });
  }
  for (const mint of [...held.keys()]) {
    if (!accountHeld.has(mint)) held.delete(mint);
  }
  for (const mint of accountHeld.keys()) {
    if (!held.has(mint)) held.set(mint, { entrySlot: slot, sellPending: false, buyPending: false });
  }

  const orders: Order[] = [];

  // Exits: profit target, stop loss, time stop, creator sold.
  for (const [mint, pos] of accountHeld) {
    if (orders.length >= caps.maxOrdersPerBatch) break;
    const h = held.get(mint)!;
    const c = coins.get(mint);
    if (!c || h.sellPending || pos.tokens === 0n) continue;
    const avgCost = Number(pos.cost) / Number(pos.tokens);
    if (avgCost === 0 || c.lastPrice === 0) continue;
    const x = c.lastPrice / avgCost;
    const exit =
      x >= CFG.takeProfitX ||
      x <= CFG.stopLossX ||
      slot - h.entrySlot >= CFG.maxHoldSlots ||
      c.devSold;
    if (exit) {
      const id = nextId();
      orders.push({
        side: "sell",
        client_id: id,
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: CFG.sellSlippageBps,
      });
      h.sellPending = true;
      pending.set(id, { mint, side: "sell" });
    }
  }

  // Entries: judge each launch once, inside its first slots.
  let openCount = accountHeld.size;
  for (const [mint, c] of coins) {
    if (orders.length >= caps.maxOrdersPerBatch || openCount >= caps.maxOpen) break;
    if (c.decided || c.complete || accountHeld.has(mint)) continue;
    const age = slot - c.createSlot;
    if (age < 1) continue;
    if (age > CFG.maxAge) {
      c.decided = true;
      continue;
    }
    // Wait for the opening tape: at least one outside buyer or a dev buy.
    if (c.buyers.size === 0 && c.devBuyLamports === 0n) continue;
    c.decided = true;
    if (c.devSold) continue;
    if (c.buyers.size < CFG.minBuyers || c.buyers.size > CFG.maxBuyers) continue;
    if (c.devBuyLamports < CFG.minDevBuyLamports || c.devBuyLamports > CFG.maxDevBuyLamports) continue;
    if (c.lastRealSolLamports < CFG.minRealSolLamports || c.lastRealSolLamports > CFG.maxRealSolLamports) continue;
    const vol = c.buyVolLamports + c.sellVolLamports;
    if (vol > 0n && Number(c.sellVolLamports) / Number(vol) > CFG.maxSellShare) continue;
    if (c.createPrice > 0 && c.lastPrice / c.createPrice > CFG.maxRunupX) continue;
    if (c.createPrice > 0 && c.lastPrice / c.createPrice < CFG.minRunupX) continue;

    const capLamports = (c.lastRealSolLamports * BigInt(caps.maxOrderBps)) / 10000n;
    let quote = CFG.stakeLamports;
    if (capLamports < quote) quote = capLamports;
    const cashLeft = cash - CFG.cashKeepLamports;
    if (cashLeft < quote) quote = cashLeft;
    if (quote < CFG.minBuyLamports) continue;
    const id = nextId();
    orders.push({
      side: "buy",
      client_id: id,
      mint,
      quote_lamports: quote.toString(),
      max_slippage_bps: CFG.buySlippageBps,
    });
    held.set(mint, { entrySlot: slot, sellPending: false, buyPending: true });
    pending.set(id, { mint, side: "buy" });
    openCount += 1;
  }

  return orders;
}

// -------------------------------------------------------------------- loop
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line) continue;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.type === "hello") {
    caps = {
      maxOpen: msg.caps.max_open_positions,
      maxOrderBps: msg.caps.max_order_bps_of_real_reserve,
      maxOrdersPerBatch: msg.caps.max_orders_per_batch,
    };
    continue;
  }
  if (msg.type === "done") process.exit(0);
  if (msg.type !== "batch") continue;

  for (const fill of msg.fills ?? []) onFill(fill);
  for (const ev of msg.events ?? []) {
    if (ev.event === "TradeEvent") onTrade(ev, msg.slot);
    else if (ev.event === "CreateEvent") onCreate(ev, msg.slot);
    else if (ev.event === "CompleteEvent") seeCoin(ev.mint, msg.slot).complete = true;
  }
  for (const mark of msg.marks ?? []) {
    const c = seeCoin(mark.mint, msg.slot);
    const p = priceOf(mark.virtual_quote_reserves, mark.virtual_token_reserves);
    if (p > 0) c.lastPrice = p;
    c.lastRealSolLamports = BigInt(mark.real_quote_reserves);
  }

  const orders = decide(msg);
  process.stdout.write(JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n");
}
