const benchmarkSymbols = ["^GSPC"];
const colors = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#14b8a6", "#8b5cf6", "#84cc16", "#f97316", "#06b6d4", "#ec4899"];

let selectedPeriod = "YTD";
let selectedBenchmark = "SP500";
let portfolioViewMode = "total";

const portfolioValueCache = new Map();
const periodReturnCache = new Map();
const twrCache = new Map();
const dailySeriesCache = new Map();
const stockPerformanceCache = new Map();

function clearPerformanceCaches() {
  portfolioValueCache.clear();
  periodReturnCache.clear();
  twrCache.clear();
  dailySeriesCache.clear();
  stockPerformanceCache.clear();
}







let activities = [];
let priceRows = [];
let priceBySymbol = new Map();
let holdings = [];
let statementData = null;
let symbolMetadata = new Map();
let targets = [];
let manualNotes = [];
let holdingsCurrentRows = [];
let holdingsCurrentAsOf = null;
let holdingsSnapshotMap = new Map();
let loadedActivityFilename = null;

const symbolAliases = {
  AAPL: "AAPL",
  CASH: "CASH.TO",
  SHOP: "SHOP.TO",
  VCN: "VCN.TO",
  VFV: "VFV.TO",
  XQQ: "XQQ.TO"
};

const fallbackMetadata = {
  AAPL: { sector: "Consumer Technology", country: "US", assetClass: "Stock", theme: "Tech", riskBucket: "Medium" },
  CASH: { sector: "Cash", country: "Canada", assetClass: "ETF", theme: "Cash/T-Bill", riskBucket: "Low" },
  SHOP: { sector: "Software", country: "Canada", assetClass: "Stock", theme: "Tech", riskBucket: "Medium" },
  VCN: { sector: "Broad Market", country: "Canada", assetClass: "ETF", theme: "Core ETF", riskBucket: "Low" },
  VFV: { sector: "Broad Market", country: "US", assetClass: "ETF", theme: "Core ETF", riskBucket: "Low" },
  XQQ: { sector: "Technology", country: "US", assetClass: "ETF", theme: "Tech", riskBucket: "Medium" }
};

const fallbackTargets = [
  { bucket: "Core ETF", target: 0.55 },
  { bucket: "Cash/T-Bill", target: 0.15 },
  { bucket: "Tech", target: 0.30 }
];

const money = (value, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(value) || 0);
const number = (value, max = 2) =>
  new Intl.NumberFormat("en-CA", { maximumFractionDigits: max }).format(Number(value) || 0);
const pct = value => Number.isFinite(value) ? `${number(value * 100, 2)}%` : "-";
const safeDiv = (num, den) => den ? num / den : 0;
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
})[char]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"') {
      if (quoted && next === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(value);
      if (row.some(cell => cell.trim() !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }
  if (value || row.length) {
    row.push(value);
    if (row.some(cell => cell.trim() !== "")) rows.push(row);
  }
  return rows;
}

function parseHoldingsAsOf(text) {
  const match = String(text || "").match(/As of\s+(\d{4}-\d{2}-\d{2})/i);
  return match ? match[1] : null;
}

function parseHoldingsSnapshotMap(rows, asOfDate = null) {
  const map = new Map();
  rows.forEach(row => {
    const rawSymbol = String(row.symbol || "").trim();
    const symbol = canonicalSymbol(rawSymbol);
    const quantity = parseAmount(row.quantity);
    if (!symbol || !Number.isFinite(quantity) || quantity <= 0) return;

    map.set(symbol, {
      symbol,
      display: displaySymbol(symbol),
      name: row.name || displaySymbol(symbol),
      quantity,
      bookCad: parseAmount(row["book value (cad)"]),
      bookMarket: parseAmount(row["book value (market)"]),
      bookMarketCurrency: String(row["book value currency (market)"] || row["market price currency"] || "CAD").trim().toUpperCase(),
      marketPrice: parseAmount(row["market price"]),
      marketPriceCurrency: String(row["market price currency"] || row["market value currency"] || "CAD").trim().toUpperCase(),
      marketValue: parseAmount(row["market value"]),
      marketValueCurrency: String(row["market value currency"] || row["market price currency"] || "CAD").trim().toUpperCase(),
      asOf: asOfDate || null
    });
  });
  return map;
}

function parseHoldingsCurrent(rows, asOfDate = null) {
  const date = asOfDate || latestDate();
  return rows
    .map(row => {
      const rawSymbol = String(row.symbol || "").trim();
      const symbol = canonicalSymbol(rawSymbol);
      const quantity = parseAmount(row.quantity);
      if (!symbol || !Number.isFinite(quantity) || quantity <= 0) return null;

      const name = row.name || displaySymbol(symbol);

      // Brokerage snapshot fields. These should drive the current holdings table.
      const snapshotPrice = parseAmount(row["market price"]);
      const snapshotPriceCurrency = String(row["market price currency"] || row["market value currency"] || "CAD").trim().toUpperCase();
      const snapshotMarketValue = parseAmount(row["market value"]);
      const snapshotMarketValueCad = parseAmount(row["market value (cad)"] || row["market value cad"]);
      const snapshotMarketCurrency = String(row["market value currency"] || row["market price currency"] || snapshotPriceCurrency || "CAD").trim().toUpperCase();

      const nativeBookValue = parseAmount(row["book value (market)"] || row["book value"]);
      const nativeBookCurrency = String(row["book value currency (market)"] || row["book value currency"] || snapshotMarketCurrency || "CAD").trim().toUpperCase();
      const bookCad = parseAmount(row["book value (cad)"] || row["book value cad"]);

      // Fallback only if the holdings snapshot is missing a price/value.
      const latestRow = latestPrice(symbol);
      const fallbackPrice = latestRow?.close || 0;
      const fallbackCurrency = latestRow?.currency || snapshotMarketCurrency || snapshotPriceCurrency || "CAD";

      const hasSnapshotPrice = Number.isFinite(snapshotPrice) && snapshotPrice > 0;
      const hasSnapshotMarketValue = Number.isFinite(snapshotMarketValue) && snapshotMarketValue > 0;
      const hasSnapshotMarketValueCad = Number.isFinite(snapshotMarketValueCad) && snapshotMarketValueCad > 0;
      const hasBookCad = Number.isFinite(bookCad) && bookCad > 0;
      const hasNativeBookValue = Number.isFinite(nativeBookValue) && nativeBookValue > 0;

      const price = hasSnapshotPrice
        ? snapshotPrice
        : (fallbackPrice || safeDiv(snapshotMarketValue, quantity));
      const priceCurrency = hasSnapshotPrice ? snapshotPriceCurrency : fallbackCurrency;

      const marketCurrency = snapshotMarketCurrency || priceCurrency;
      const marketValue = hasSnapshotMarketValue ? snapshotMarketValue : (price ? quantity * price : 0);
      const marketCad = hasSnapshotMarketValueCad ? snapshotMarketValueCad : amountCad(marketValue, marketCurrency, date);

      const costCad = hasBookCad ? bookCad : amountCad(nativeBookValue, nativeBookCurrency, date);

      const snapshotNativeUnrealized = parseAmount(row["market unrealized returns"] || row["unrealized returns"] || row["unrealized gain/loss"]);
      const hasSnapshotNativeUnrealized = Number.isFinite(snapshotNativeUnrealized) && snapshotNativeUnrealized !== 0;
      const nativeUnrealizedCurrency = String(row["market unrealized returns currency"] || row["unrealized returns currency"] || snapshotMarketCurrency || nativeBookCurrency || "CAD").trim().toUpperCase();
      const nativeUnrealized = hasSnapshotNativeUnrealized
        ? snapshotNativeUnrealized
        : (marketValue && hasNativeBookValue ? marketValue - nativeBookValue : 0);
      const officialUnrealizedCad = hasSnapshotNativeUnrealized
        ? amountCad(nativeUnrealized, nativeUnrealizedCurrency, date)
        : (marketCad - costCad);
      const nativeReturnPct = hasNativeBookValue ? safeDiv(nativeUnrealized, nativeBookValue) : null;

      return {
        symbol,
        name,
        quantity,
        costCad,
        buys: 0,
        sells: 0,
        dividends: 0,
        commissions: 0,
        currency: priceCurrency,
        trades: 0,
        display: displaySymbol(symbol),
        metadata: metadataFor(symbol),
        targetBucket: null,
        price: price || safeDiv(marketValue, quantity),
        priceDate: asOfDate ? `${asOfDate} holdings snapshot` : "holdings snapshot",
        marketCurrency,
        marketValue,
        marketCad,
        unrealizedCad: officialUnrealizedCad,
        returnPct: costCad ? safeDiv(officialUnrealizedCad, costCad) : (nativeBookValue ? nativeReturnPct : 0),
        nativeBookValue,
        nativeBookCurrency,
        nativeMarketValue: marketValue,
        nativeMarketCurrency: marketCurrency,
        nativeUnrealized,
        nativeUnrealizedCurrency,
        nativeReturnPct,
        hasPrice: Boolean(price),
        hasMarketPrice: Boolean(snapshotPrice || snapshotMarketValue),
        usedSnapshotPriceFallback: false,
        snapshotQuantity: quantity,
        snapshotBookCad: costCad,
        quantityReconciliationDiff: 0,
        bookReconciliationDiff: 0
      };
    })
    .filter(Boolean)
    .map(row => ({ ...row, targetBucket: targetBucketFor(row) }))
    .sort((a, b) => b.marketCad - a.marketCad);
}

function toObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows.shift().map(key => String(key || "").trim().toLowerCase());
  return rows.map(row => Object.fromEntries(header.map((key, index) => [key, row[index] ?? ""])));
}

function normalizeActivityType(value) {
  return String(value || "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toUpperCase();
}

function parseAmount(value) {
  return Number(String(value || "").replace(/,/g, "")) || 0;
}

function manualFx() {
  return Math.max(parseFloat(document.querySelector("#fxRate")?.value) || 1.3642, 0);
}

function fxAt(date) {
  const targetDate = date || (priceRows.length ? priceRows.map(row => row.date).sort().at(-1) : null);
  if (targetDate && priceBySymbol?.size) {
    for (const symbol of ["CAD=X", "USDCAD", "USD/CAD"]) {
      const row = priceAt(symbol, targetDate);
      if (row?.close && Number.isFinite(row.close) && row.close > 0) return row.close;
    }
  }
  return manualFx();
}

function fx() {
  return fxAt(latestDate());
}

function canonicalSymbol(symbol) {
  const clean = String(symbol || "").trim().toUpperCase();
  return symbolAliases[clean] || clean;
}

function displaySymbol(symbol) {
  return String(symbol || "").replace(".TO", "").replace(".CN", "").replace("U-UN", "U.UN");
}

function amountCad(amount, currency, date = null) {
  return String(currency || "CAD").toUpperCase() === "USD" ? amount * fxAt(date) : amount;
}

function parseActivities(text) {
  return toObjects(text)
    .filter(row => row.transaction_date && row.activity_type)
    .map(row => {
      const activityType = normalizeActivityType(row.activity_type);
      const subType = normalizeActivityType(row.activity_sub_type);
      const direction = normalizeActivityType(row.direction);
      let transaction = activityType;
      if (activityType === "TRADE" && subType === "BUY") transaction = "TRADE_BUY";
      if (activityType === "TRADE" && subType === "SELL") transaction = "TRADE_SELL";
      if (activityType === "MONEY_MOVEMENT") transaction = "MONEY_MOVEMENT";
      if (activityType === "DIVIDEND") transaction = "DIVIDEND";
      if (activityType === "INTEREST") transaction = "INTEREST";
      if (activityType === "STOCK_LENDING") transaction = "STOCK_LENDING_INCOME";
      if (activityType === "FEE" || subType === "NRT") transaction = subType || "FEE";

      const rawSymbol = String(row.symbol || row["underlying symbol"] || "").trim();
      const symbol = rawSymbol ? canonicalSymbol(rawSymbol) : "Cash";
      const currency = String(row.currency || "CAD").trim().toUpperCase();
      return {
        date: String(row.transaction_date).slice(0, 10),
        settlementDate: String(row.settlement_date || "").slice(0, 10),
        accountId: row.account_id || "",
        accountType: row.account_type || "",
        activityType,
        subType,
        direction,
        transaction,
        symbol,
        rawSymbol,
        name: row.name || rawSymbol || "Cash",
        currency,
        quantity: parseAmount(row.quantity),
        unitPrice: parseAmount(row.unit_price),
        commission: parseAmount(row.commission),
        amount: parseAmount(row.net_cash_amount)
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function parsePrices(text) {
  const rows = toObjects(text)
    .map(row => ({
      date: String(row.date || row.timestamp || "").slice(0, 10),
      symbol: canonicalSymbol(row.symbol || row.ticker),
      close: parseAmount(row.regular_market_price || row.regularMarketPrice || row.market_price || row["market price"] || row.close || row.price || row["adj close"] || row.adjustedclose || row["adjusted close"]),
      adjClose: parseAmount(row.adj_close || row["adj close"] || row.adjustedclose || row["adjusted close"]),
      currency: String(row.currency || "CAD").trim().toUpperCase()
    }))
    .filter(row => row.date && row.symbol && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  priceBySymbol = new Map();
  rows.forEach(row => {
    if (!priceBySymbol.has(row.symbol)) priceBySymbol.set(row.symbol, []);
    priceBySymbol.get(row.symbol).push(row);
  });
  return rows;
}

function parseMetadata(text) {
  const map = new Map();
  toObjects(text).forEach(row => {
    const raw = String(row.symbol || "").trim().toUpperCase();
    if (!raw) return;
    const key = displaySymbol(canonicalSymbol(raw)).toUpperCase();
    map.set(key, {
      sector: row.sector || "Unclassified",
      country: row.country || "Unknown",
      assetClass: row.asset_class || row.assetClass || "Unknown",
      theme: row.theme || "Other",
      riskBucket: row.risk_bucket || row.riskBucket || "Medium"
    });
  });
  return map;
}

function parseTargets(text) {
  return toObjects(text)
    .map(row => ({
      bucket: String(row.bucket || row.theme || "").trim(),
      target: parseAmount(row.target_weight || row.target || row.weight) / 100
    }))
    .filter(row => row.bucket && Number.isFinite(row.target) && row.target > 0);
}

function parseManualNotes(text) {
  return toObjects(text)
    .map(row => ({
      date: String(row.date || "").slice(0, 10),
      symbol: displaySymbol(canonicalSymbol(row.symbol || "")),
      action: row.action || "",
      thesis: row.thesis || "",
      risk: row.risk || "",
      exitPlan: row.exit_plan || row.exitPlan || ""
    }))
    .filter(row => row.date || row.symbol || row.thesis);
}

function metadataFor(symbol) {
  const key = displaySymbol(canonicalSymbol(symbol)).toUpperCase();
  return symbolMetadata.get(key) || fallbackMetadata[key] || {
    sector: "Unclassified",
    country: symbol?.includes(".TO") || symbol?.includes(".CN") ? "Canada" : "US",
    assetClass: symbol?.includes(".TO") || symbol?.includes(".CN") ? "Stock/ETF" : "Stock",
    theme: "Other",
    riskBucket: "Medium"
  };
}

function targetBucketFor(row) {
  const meta = metadataFor(row.symbol);
  const theme = String(meta.theme || "").toLowerCase();
  const sector = String(meta.sector || "").toLowerCase();
  if (theme.includes("core")) return "Core ETF";
  if (theme.includes("cash") || theme.includes("t-bill") || sector.includes("cash")) return "Cash/T-Bill";
  if (theme.includes("uranium") || sector.includes("uranium")) return "Uranium";
  if (theme.includes("tech") || theme.includes("ai") || sector.includes("software") || sector.includes("semiconductor")) return "Tech";
  if (String(meta.riskBucket || "").toLowerCase() === "high") return "Speculative";
  return "Other";
}

function latestDate() {
  const latestPriceDate = priceRows.map(row => row.date).sort().at(-1) || null;
  const latestActivityDate = activities.map(row => row.date).sort().at(-1) || null;
  return [holdingsCurrentAsOf, latestPriceDate, latestActivityDate]
    .filter(Boolean)
    .sort()
    .at(-1) || new Date().toISOString().slice(0, 10);
}

function priceAt(symbol, date) {
  const rows = priceBySymbol.get(canonicalSymbol(symbol)) || [];
  if (!rows.length) return null;
  let left = 0;
  let right = rows.length - 1;
  let best = null;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (rows[mid].date <= date) {
      best = rows[mid];
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return best || rows[0];
}

function latestPrice(symbol) {
  const rows = priceBySymbol.get(canonicalSymbol(symbol)) || [];
  return rows[rows.length - 1] || null;
}

function replayPositions(untilDate = "9999-12-31") {
  const map = new Map();
  const ensure = tx => {
    const key = tx.symbol;
    const item = map.get(key) || {
      symbol: key,
      name: tx.name || displaySymbol(key),
      quantity: 0,
      costCad: 0,
      buys: 0,
      sells: 0,
      dividends: 0,
      commissions: 0,
      currency: tx.currency || "CAD",
      trades: 0
    };
    if (tx.name && tx.symbol !== "Cash") item.name = tx.name;
    if (tx.currency) item.currency = tx.currency;
    map.set(key, item);
    return item;
  };

  activities.filter(tx => tx.date <= untilDate).forEach(tx => {
    if (tx.symbol === "Cash") return;
    const item = ensure(tx);
    if (tx.transaction === "TRADE_BUY") {
      const cost = Math.abs(tx.amount) || tx.quantity * tx.unitPrice;
      item.quantity += tx.quantity;
      item.costCad += amountCad(cost + Math.abs(tx.commission || 0), tx.currency);
      item.buys += cost;
      item.commissions += Math.abs(tx.commission || 0);
      item.trades += 1;
    }
    if (tx.transaction === "TRADE_SELL") {
      const sellQuantity = Math.abs(tx.quantity);
      const proceeds = Math.abs(tx.amount) || sellQuantity * tx.unitPrice;
      const avgCost = item.quantity ? item.costCad / item.quantity : 0;
      item.quantity -= sellQuantity;
      item.costCad -= avgCost * sellQuantity;
      item.sells += proceeds;
      item.commissions += Math.abs(tx.commission || 0);
      item.trades += 1;
    }
    if (tx.transaction === "OPTION_EXPIRY") {
      const expireQuantity = Math.abs(tx.quantity);
      const avgCost = item.quantity ? item.costCad / item.quantity : 0;
      item.quantity -= expireQuantity;
      item.costCad -= avgCost * expireQuantity;
    }
    if (tx.transaction === "DIVIDEND" || tx.transaction === "INTEREST" || tx.transaction === "STOCK_LENDING_INCOME") {
      item.dividends += amountCad(tx.amount, tx.currency);
    }
    if (tx.activityType === "LEGACY_CORPORATE_ACTION" && tx.subType === "NAME_CHANGE") {
      item.quantity += tx.quantity;
    }
  });

  return [...map.values()].filter(item => Math.abs(item.quantity) > 0.000001);
}

function valuePosition(position, date = latestDate(), options = {}) {
  const snapshot = options.snapshot || holdingsSnapshotMap.get(canonicalSymbol(position.symbol)) || null;
  const price = priceAt(position.symbol, date);
  const costCad = Math.max(position.costCad, 0);
  const canUseSnapshotPrice = Boolean(
    options.allowSnapshotPriceFallback &&
    snapshot?.marketPrice &&
    holdingsCurrentAsOf &&
    date >= holdingsCurrentAsOf
  );
  const usedSnapshotPriceFallback = !price && canUseSnapshotPrice;
  const unitPrice = price?.close || (usedSnapshotPriceFallback ? snapshot.marketPrice : null);
  const currency = price?.currency || (usedSnapshotPriceFallback ? snapshot.marketPriceCurrency : (position.currency || "CAD"));
  const nativeValue = unitPrice ? position.quantity * unitPrice : costCad;
  const marketCad = unitPrice ? amountCad(nativeValue, currency, price?.date || snapshot?.asOf || date) : costCad;
  const metadata = metadataFor(position.symbol);
  return {
    ...position,
    display: displaySymbol(position.symbol),
    metadata,
    targetBucket: targetBucketFor(position),
    price: unitPrice || safeDiv(costCad, position.quantity),
    priceDate: price?.date || (usedSnapshotPriceFallback ? `${snapshot.asOf || holdingsCurrentAsOf || date} snapshot fallback` : "cost fallback"),
    marketCurrency: unitPrice ? currency : "CAD",
    marketValue: nativeValue,
    marketCad,
    costCad,
    unrealizedCad: marketCad - costCad,
    returnPct: safeDiv(marketCad - costCad, costCad),
    hasPrice: Boolean(unitPrice),
    hasMarketPrice: Boolean(price),
    usedSnapshotPriceFallback,
    snapshotQuantity: Number.isFinite(snapshot?.quantity) ? snapshot.quantity : null,
    snapshotBookCad: Number.isFinite(snapshot?.bookCad) ? snapshot.bookCad : null,
    quantityReconciliationDiff: Number.isFinite(snapshot?.quantity) ? position.quantity - snapshot.quantity : null,
    bookReconciliationDiff: Number.isFinite(snapshot?.bookCad) ? costCad - snapshot.bookCad : null
  };
}

function buildHoldings() {
  // Current holdings should match the imported brokerage snapshot.
  // Use holdings-current.csv / holdings.csv as the source of truth for today
  // because it contains the broker's quantity, average/book cost, market price,
  // market value, and unrealized return. prices.csv is only a fallback and is mainly
  // for historical charts / benchmarks.
  if (holdingsCurrentRows.length) {
    holdings = parseHoldingsCurrent(holdingsCurrentRows, holdingsCurrentAsOf)
      .filter(position => position.marketCad || Math.abs(position.quantity) > 0.000001)
      .sort((a, b) => b.marketCad - a.marketCad);
    return;
  }

  holdings = replayPositions(latestDate()).map(position =>
    valuePosition(position, latestDate(), {
      allowSnapshotPriceFallback: true,
      snapshot: holdingsSnapshotMap.get(canonicalSymbol(position.symbol))
    })
  )
    .filter(position => position.marketCad || Math.abs(position.quantity) > 0.000001)
    .sort((a, b) => b.marketCad - a.marketCad);
}

function cashFlowsBetween(start, end) {
  return activities
    .filter(tx => tx.date > start && tx.date <= end)
    .reduce((sum, tx) => {
      if (tx.transaction === "MONEY_MOVEMENT") return sum + amountCad(tx.amount, tx.currency);
      return sum;
    }, 0);
}

function externalFlowsBetween(start, end, includeStart = false) {
  return activities
    .filter(tx => (includeStart ? tx.date >= start : tx.date > start) && tx.date <= end)
    .reduce((sum, tx) => {
      if (tx.transaction === "MONEY_MOVEMENT") return sum + amountCad(tx.amount, tx.currency);
      return sum;
    }, 0);
}

function cashBalanceAt(date) {
  return activities
    .filter(tx => tx.date <= date)
    .reduce((sum, tx) => sum + amountCad(tx.amount, tx.currency), 0);
}

function periodStartDate(period, end = latestDate()) {
  const date = new Date(`${end}T00:00:00`);
  if (period === "1D") date.setDate(date.getDate() - 1);
  if (period === "1M") date.setMonth(date.getMonth() - 1);
  if (period === "3M") date.setMonth(date.getMonth() - 3);
  if (period === "6M") date.setMonth(date.getMonth() - 6);
  if (period === "YTD") return `${date.getFullYear()}-01-01`;
  if (period === "1Y") date.setFullYear(date.getFullYear() - 1);
  if (period === "2Y") date.setFullYear(date.getFullYear() - 2);
  if (period === "MAX") return activities[0]?.date || end;
  return date.toISOString().slice(0, 10);
}

function portfolioValueAt(date) {
  if (portfolioValueCache.has(date)) return portfolioValueCache.get(date);

  let missing = [];
  let snapshotFallback = [];
  const value = replayPositions(date).reduce((sum, position) => {
    const valued = valuePosition(position, date, {
      allowSnapshotPriceFallback: Boolean(holdingsCurrentAsOf && date >= holdingsCurrentAsOf),
      snapshot: holdingsSnapshotMap.get(canonicalSymbol(position.symbol))
    });
    if (!valued.hasPrice) missing.push(valued.display);
    if (valued.usedSnapshotPriceFallback) snapshotFallback.push(valued.display);
    return sum + valued.marketCad;
  }, 0);

  portfolioValueAt.lastMissing = [...new Set(missing)].sort();
  portfolioValueAt.lastSnapshotFallback = [...new Set(snapshotFallback)].sort();
  portfolioValueCache.set(date, value);
  return value;
}

function accountValueAt(date) {
  return portfolioValueAt(date) + cashBalanceAt(date);
}

function currentOfficialAccountValue() {
  const end = latestDate();
  const holdingsValue = holdings.reduce((sum, row) => sum + (Number(row.marketCad) || 0), 0);
  return holdingsValue + cashBalanceAt(end);
}

function periodReturn(period) {
  if (periodReturnCache.has(period)) return periodReturnCache.get(period);


  const end = latestDate();
  const start = activePeriodStartDate(period, end);
  if (!start || start >= end) return null;
  const isMax = period === "MAX";
  const startValue = isMax ? 0 : accountValueAt(start);
  const endValue = currentOfficialAccountValue();
  const netFlows = externalFlowsBetween(start, end, isMax);
  const gain = endValue - startValue - netFlows;
  const denominator = isMax ? Math.max(netFlows, 0) : startValue + Math.max(netFlows, 0);
  const simple = startValue ? safeDiv(endValue - startValue, startValue) : null;
  const result = { period, start, end, startValue, endValue, netFlows, gain, denominator, simple, value: safeDiv(gain, denominator) };
  periodReturnCache.set(period, result);
  return result;
}

function benchmarkReturn(symbol, period) {
  const end = latestDate();
  const start = periodStartDate(period, end);
  const startPrice = priceAt(symbol, start);
  const endPrice = priceAt(symbol, end);
  if (!startPrice || !endPrice || startPrice.date === endPrice.date) return null;
  return safeDiv(endPrice.close - startPrice.close, startPrice.close);
}

function benchmarkPortfolioReturn(symbol, period) {
  const result = periodReturn(period);
  if (!result) return null;
  const startPrice = priceAt(symbol, result.start);
  const endPrice = priceAt(symbol, result.end);
  if (!startPrice || !endPrice || startPrice.date === endPrice.date) return null;

  const includeStart = period === "MAX";
  const startInvestment = includeStart ? 0 : result.startValue;
  let units = safeDiv(startInvestment, startPrice.close);
  activities
    .filter(tx => tx.transaction === "MONEY_MOVEMENT")
    .filter(tx => (includeStart ? tx.date >= result.start : tx.date > result.start) && tx.date <= result.end)
    .forEach(tx => {
      const flow = amountCad(tx.amount, tx.currency);
      const price = priceAt(symbol, tx.date);
      if (price?.close) units += flow / price.close;
    });

  const endValue = units * endPrice.close;
  const gain = endValue - startInvestment - result.netFlows;
  const denominator = includeStart ? Math.max(result.netFlows, 0) : startInvestment + Math.max(result.netFlows, 0);
  return safeDiv(gain, denominator);
}


function activeSelectedPeriodReturnValue(period = selectedPeriod) {
  const result = activePeriodReturn(period);
  if (!result) return null;
  return result.value;
}

function activeBenchmarkPortfolioReturn(symbol, period) {
  if (portfolioViewMode !== "stocks") return benchmarkPortfolioReturn(symbol, period);

  const result = activePeriodReturn(period);
  if (!result) return null;
  const startPrice = priceAt(symbol, result.start);
  const endPrice = priceAt(symbol, result.end);
  if (!startPrice || !endPrice || startPrice.date === endPrice.date) return null;

  const includeStart = period === "MAX";
  const startInvestment = includeStart ? 0 : result.startValue;
  let units = safeDiv(startInvestment, startPrice.close);

  activities
    .filter(tx => stockOnlySymbols().has(canonicalSymbol(tx.symbol)))
    .filter(tx => ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction))
    .filter(tx => (includeStart ? tx.date >= result.start : tx.date > result.start) && tx.date <= result.end)
    .forEach(tx => {
      const flow = stockOnlyFlowAmount(tx);
      const price = priceAt(symbol, tx.date);
      if (price?.close) units += flow / price.close;
    });

  const endValue = units * endPrice.close;
  const gain = endValue - startInvestment - result.netFlows;
  const denominator = includeStart ? Math.max(result.netFlows, 0) : startInvestment + Math.max(result.netFlows, 0);
  return safeDiv(gain, denominator);
}

function valuationDates(start, end) {
  const dates = new Set(priceRows.map(row => row.date).filter(date => date >= start && date <= end));
  if (start) dates.add(start);
  if (end) dates.add(end);
  return [...dates].sort();
}

function dailyAccountSeries(start = periodStartDate("MAX", latestDate()), end = latestDate()) {
  const cacheKey = `${start}|${end}`;
  if (dailySeriesCache.has(cacheKey)) return dailySeriesCache.get(cacheKey);

  const series = valuationDates(start, end)
    .map(date => ({ date, value: accountValueAt(date) }))
    .filter(point => Number.isFinite(point.value));
  if (series.length && end === latestDate()) {
    series[series.length - 1] = { date: end, value: currentOfficialAccountValue() };
  }
  dailySeriesCache.set(cacheKey, series);
  return series;
}
function twrIndexSeries(period = selectedPeriod) {
  const end = latestDate();
  const start = periodStartDate(period, end);
  const points = dailyAccountSeries(start, end).filter(point => point.value > 0);
  if (points.length < 2) return [];

  const series = [{ date: points[0].date, value: 1 }];
  let previous = points[0];
  let index = 1;
  for (const point of points.slice(1)) {
    const flow = externalFlowsBetween(previous.date, point.date, false);
    if (previous.value > 0) {
      const subReturn = (point.value - flow) / previous.value - 1;
      if (Number.isFinite(subReturn)) index *= 1 + subReturn;
      series.push({ date: point.date, value: index });
    }
    previous = point;
  }
  return series;
}

function timeWeightedReturn(period = selectedPeriod) {
  if (twrCache.has(period)) return twrCache.get(period);

  const series = twrIndexSeries(period);
  if (series.length < 2) return null;
  const result = {
    start: series[0].date,
    end: series.at(-1).date,
    value: series.at(-1).value - 1
  };
  twrCache.set(period, result);
  return result;
}
function maxDrawdown(series) {
  if (!series || series.length < 2) return null;
  let peak = series[0].value;
  let peakDate = series[0].date;
  let worst = { value: 0, peakDate, troughDate: series[0].date };
  series.forEach(point => {
    if (point.value > peak) {
      peak = point.value;
      peakDate = point.date;
    }
    const drawdown = safeDiv(point.value - peak, peak);
    if (drawdown < worst.value) {
      worst = { value: drawdown, peakDate, troughDate: point.date };
    }
  });
  return worst;
}

function daysBetween(start, end) {
  return (new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000;
}

function xnpv(rate, flows) {
  const first = flows[0].date;
  return flows.reduce((sum, flow) => sum + flow.amount / Math.pow(1 + rate, daysBetween(first, flow.date) / 365), 0);
}

function xnpvPrime(rate, flows) {
  const first = flows[0].date;
  return flows.reduce((sum, flow) => {
    const years = daysBetween(first, flow.date) / 365;
    return sum - years * flow.amount / Math.pow(1 + rate, years + 1);
  }, 0);
}

function xirr(flows, guess = 0.1) {
  if (!flows || flows.length < 2) return null;
  if (!flows.some(flow => flow.amount > 0) || !flows.some(flow => flow.amount < 0)) return null;
  let rate = guess;
  for (let i = 0; i < 100; i += 1) {
    const value = xnpv(rate, flows);
    const slope = xnpvPrime(rate, flows);
    if (!Number.isFinite(value) || !Number.isFinite(slope) || slope === 0) break;
    const next = rate - value / slope;
    if (Math.abs(next - rate) < 1e-7) return next;
    rate = Math.max(-0.999, Math.min(100, next));
  }

  let low = -0.999;
  let high = 100;
  let lowValue = xnpv(low, flows);
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const midValue = xnpv(mid, flows);
    if (!Number.isFinite(midValue)) return null;
    if (Math.abs(midValue) < 0.01) return mid;
    if (Math.sign(midValue) === Math.sign(lowValue)) {
      low = mid;
      lowValue = midValue;
    } else {
      high = mid;
    }
  }
  return null;
}

function buildXirrFlows() {
  const flows = activities
    .filter(tx => tx.transaction === "MONEY_MOVEMENT")
    .map(tx => ({ date: tx.date, amount: -amountCad(tx.amount, tx.currency) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!flows.length) return null;
  flows.push({ date: latestDate(), amount: accountValueAt(latestDate()) });
  return flows;
}

function activeBuildXirrFlows() {
  if (portfolioViewMode !== "stocks") return buildXirrFlows();

  const flows = activities
    .filter(tx => stockOnlySymbols().has(canonicalSymbol(tx.symbol)))
    .filter(tx => ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction))
    .map(tx => ({ date: tx.date, amount: -stockOnlyFlowAmount(tx) }))
    .sort((a, b) => a.date.localeCompare(b.date));

  if (!flows.length) return null;
  flows.push({ date: latestDate(), amount: activeCurrentValue() });
  return flows;
}

function computeRealizedPnl() {
  const books = new Map();
  const realized = new Map();
  const trades = [];
  const ensureBook = symbol => {
    if (!books.has(symbol)) books.set(symbol, { quantity: 0, cost: 0, weightedDateMs: 0 });
    return books.get(symbol);
  };
  const addRealized = (tx, amount, proceeds = 0, costBasis = 0, quantity = 0, holdingDays = 0) => {
    const entry = realized.get(tx.symbol) || { symbol: displaySymbol(tx.symbol), amount: 0, proceeds: 0, costBasis: 0, quantity: 0, holdingDaysWeighted: 0, trades: 0 };
    entry.amount += amount;
    entry.proceeds += proceeds;
    entry.costBasis += costBasis;
    entry.quantity += quantity;
    entry.holdingDaysWeighted += holdingDays * quantity;
    entry.trades += 1;
    realized.set(tx.symbol, entry);
    trades.push({
      date: tx.date,
      symbol: displaySymbol(tx.symbol),
      proceeds,
      costBasis,
      amount,
      quantity,
      holdingDays
    });
  };

  activities
    .filter(tx => tx.symbol !== "Cash")
    .filter(tx => ["TRADE_BUY", "TRADE_SELL", "OPTION_EXPIRY"].includes(tx.transaction))
    .forEach(tx => {
      const book = ensureBook(tx.symbol);
      const quantity = Math.abs(tx.quantity);
      if (!quantity) return;
      if (tx.transaction === "TRADE_BUY") {
        const cost = Math.abs(amountCad(tx.amount, tx.currency));
        const dateMs = new Date(`${tx.date}T00:00:00`).getTime();
        book.weightedDateMs += dateMs * quantity;
        book.quantity += quantity;
        book.cost += cost;
        return;
      }

      const proceeds = tx.transaction === "OPTION_EXPIRY" ? 0 : Math.abs(amountCad(tx.amount, tx.currency));
      const matchedQuantity = Math.min(quantity, Math.max(book.quantity, 0));
      const costBasis = safeDiv(book.cost, book.quantity) * matchedQuantity;
      const averageDateMs = safeDiv(book.weightedDateMs, book.quantity);
      const holdingDays = averageDateMs ? Math.max(0, daysBetween(new Date(averageDateMs).toISOString().slice(0, 10), tx.date)) : 0;
      if (matchedQuantity > 0) {
        const remainingWeight = safeDiv(book.quantity - matchedQuantity, book.quantity);
        book.quantity -= matchedQuantity;
        book.cost -= costBasis;
        book.weightedDateMs *= Math.max(remainingWeight, 0);
      }
      addRealized(tx, proceeds - costBasis, proceeds, costBasis, matchedQuantity, holdingDays);
    });

  const perSymbol = [...realized.values()].map(row => ({
    ...row,
    averageHoldingDays: safeDiv(row.holdingDaysWeighted, row.quantity)
  })).sort((a, b) => b.amount - a.amount);
  return {
    total: perSymbol.reduce((sum, row) => sum + row.amount, 0),
    perSymbol,
    trades: trades.sort((a, b) => b.date.localeCompare(a.date))
  };
}

function cashBalancesByCurrency() {
  return activities.reduce((balances, tx) => {
    const currency = String(tx.currency || "CAD").toUpperCase();
    if (currency === "CAD" || currency === "USD") balances[currency] += tx.amount;
    return balances;
  }, { CAD: 0, USD: 0 });
}

function trailingIncome(months = 12) {
  const end = latestDate();
  const cutoff = new Date(`${end}T00:00:00`);
  cutoff.setMonth(cutoff.getMonth() - months);
  const start = cutoff.toISOString().slice(0, 10);
  return activities
    .filter(tx => ["DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(tx.transaction))
    .filter(tx => tx.date >= start && tx.date <= end)
    .reduce((sum, tx) => sum + amountCad(tx.amount, tx.currency), 0);
}

function monthlyIncomeRows() {
  const map = new Map();
  activities
    .filter(tx => ["DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(tx.transaction))
    .forEach(tx => {
      const month = tx.date.slice(0, 7);
      const row = map.get(month) || { month, dividends: 0, interest: 0, lending: 0, total: 0 };
      const amount = amountCad(tx.amount, tx.currency);
      if (tx.transaction === "DIVIDEND") row.dividends += amount;
      if (tx.transaction === "INTEREST") row.interest += amount;
      if (tx.transaction === "STOCK_LENDING_INCOME") row.lending += amount;
      row.total += amount;
      map.set(month, row);
    });
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

function dailyTwrReturns(period = selectedPeriod) {
  const series = twrIndexSeries(period);
  return series.slice(1).map((point, index) => ({
    date: point.date,
    value: safeDiv(point.value, series[index].value) - 1
  })).filter(row => Number.isFinite(row.value));
}

function benchmarkDailyReturns(symbol = "^GSPC", period = selectedPeriod) {
  const end = latestDate();
  const start = periodStartDate(period, end);
  const rows = (priceBySymbol.get(canonicalSymbol(symbol)) || [])
    .filter(row => row.date >= start && row.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows.slice(1).map((row, index) => ({
    date: row.date,
    value: safeDiv(row.close, rows[index].close) - 1
  })).filter(row => Number.isFinite(row.value));
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stddev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
}

function pairedReturns(portfolioRows, benchmarkRows) {
  const benchmarkMap = new Map(benchmarkRows.map(row => [row.date, row.value]));
  return portfolioRows
    .filter(row => benchmarkMap.has(row.date))
    .map(row => ({ portfolio: row.value, benchmark: benchmarkMap.get(row.date) }));
}

function covariance(a, b) {
  if (a.length < 2 || b.length < 2 || a.length !== b.length) return 0;
  const avgA = mean(a);
  const avgB = mean(b);
  return a.reduce((sum, value, index) => sum + (value - avgA) * (b[index] - avgB), 0) / (a.length - 1);
}

function riskMetrics(period = selectedPeriod) {
  const portfolio = dailyTwrReturns(period);
  const benchmark = benchmarkDailyReturns("^GSPC", period);
  const values = portfolio.map(row => row.value);
  const paired = pairedReturns(portfolio, benchmark);
  const pairedPortfolio = paired.map(row => row.portfolio);
  const pairedBenchmark = paired.map(row => row.benchmark);
  const dailyStd = stddev(values);
  const downsideStd = stddev(values.filter(value => value < 0));
  const benchmarkVariance = stddev(pairedBenchmark) ** 2;
  const beta = benchmarkVariance ? covariance(pairedPortfolio, pairedBenchmark) / benchmarkVariance : null;
  const correlationDenom = stddev(pairedPortfolio) * stddev(pairedBenchmark);
  return {
    observations: values.length,
    volatility: dailyStd * Math.sqrt(252),
    sharpe: dailyStd ? mean(values) / dailyStd * Math.sqrt(252) : null,
    sortino: downsideStd ? mean(values) / downsideStd * Math.sqrt(252) : null,
    beta,
    correlation: correlationDenom ? covariance(pairedPortfolio, pairedBenchmark) / correlationDenom : null,
    maxDrawdown: maxDrawdown(twrIndexSeries(period))
  };
}

function returnBreakdown() {
  const summary = totals();
  const realized = computeRealizedPnl();
  const income = statementData?.totals?.dividends || 0;
  const fees = statementData?.totals?.feesTaxes || 0;
  return {
    realized: realized.total,
    unrealized: summary.returnCad,
    income,
    fees,
    total: realized.total + summary.returnCad + income + fees,
    realizedRows: realized.perSymbol,
    realizedTrades: realized.trades
  };
}

function rebalancingRows() {
  const summary = totals();
  const actual = new Map();
  holdings.forEach(row => {
    const bucket = targetBucketFor(row);
    actual.set(bucket, (actual.get(bucket) || 0) + row.marketCad);
  });
  const allBuckets = new Set([...targets.map(row => row.bucket), ...actual.keys()]);
  const targetByBucket = new Map(targets.map(row => [row.bucket, row.target]));
  return [...allBuckets].sort().map(bucket => {
    const actualValue = actual.get(bucket) || 0;
    const targetWeight = targetByBucket.has(bucket) ? targetByBucket.get(bucket) : null;
    const targetValue = targetWeight === null ? null : summary.totalCad * targetWeight;
    return {
      bucket,
      actualValue,
      actualWeight: safeDiv(actualValue, summary.totalCad),
      targetWeight,
      differenceValue: targetValue === null ? null : targetValue - actualValue,
      differenceWeight: targetWeight === null ? null : targetWeight - safeDiv(actualValue, summary.totalCad)
    };
  }).sort((a, b) => Math.abs((b.differenceValue ?? 0)) - Math.abs((a.differenceValue ?? 0)));
}

function scenarioRows() {
  const summary = totals();
  const usdNative = holdings.filter(row => row.marketCurrency === "USD").reduce((sum, row) => sum + row.marketValue, 0);
  const currentFx = fx();
  const fx130Value = summary.totalCad - usdNative * currentFx + usdNative * 1.30;
  const techValue = holdings.filter(row => metadataFor(row.symbol).theme === "Tech").reduce((sum, row) => sum + row.marketCad, 0);
  const stockValue = holdings.filter(row => metadataFor(row.symbol).assetClass === "Stock").reduce((sum, row) => sum + row.marketCad, 0);

  return [
    { label: "USD/CAD moves to 1.30", value: fx130Value - summary.totalCad, detail: `New value ${money(fx130Value)}` },
    { label: "Tech sleeve drops 20%", value: -techValue * 0.20, detail: `Tech current ${money(techValue)}` },
    { label: "Single stocks drop 15%", value: -stockValue * 0.15, detail: `Stock current ${money(stockValue)}` }
  ];
}

function alertRows() {
  const summary = activeTotals();
  const rows = activeHoldings();
  const selected = activePeriodReturn("1D");
  const portfolioTwr = portfolioViewMode === "stocks" ? activePeriodReturn(selectedPeriod) : activeTimeWeightedReturn(selectedPeriod);
  const benchmarkRet = selectedBenchmarkReturn(selectedPeriod);
  const themeRows = grouped(rows, row => metadataFor(row.symbol).theme);
  const speculative = rows.filter(row => metadataFor(row.symbol).riskBucket === "High").reduce((sum, row) => sum + row.marketCad, 0);
  const usd = rows.filter(row => row.marketCurrency === "USD").reduce((sum, row) => sum + row.marketCad, 0);
  const cashLike = portfolioViewMode === "stocks" ? 0 : rows.filter(row => targetBucketFor(row) === "Cash/T-Bill").reduce((sum, row) => sum + row.marketCad, 0);
  const alerts = [];
  if (selected?.value < -0.03) alerts.push({ label: "Portfolio down more than 3% in a day", severity: "negative" });
  rows.filter(row => row.returnPct < -0.10).forEach(row => alerts.push({ label: `${row.display} is down ${pct(row.returnPct)} from cost`, severity: "negative" }));
  rows.filter(row => row.returnPct > 0.50).forEach(row => alerts.push({ label: `${row.display} is up ${pct(row.returnPct)} from cost`, severity: "positive" }));
  rows.filter(row => safeDiv(row.marketCad, summary.totalCad) > 0.15).forEach(row => alerts.push({ label: `${row.display} is above 15% portfolio weight`, severity: "negative" }));
  themeRows.filter(row => safeDiv(row.value, summary.totalCad) > 0.30).forEach(row => alerts.push({ label: `${row.label} theme is above 30%`, severity: "negative" }));
  if (safeDiv(speculative, summary.totalCad) > 0.40) alerts.push({ label: `Speculative/high-risk sleeve is ${pct(safeDiv(speculative, summary.totalCad))}`, severity: "negative" });
  if (safeDiv(usd, summary.totalCad) > 0.50) alerts.push({ label: `USD exposure is ${pct(safeDiv(usd, summary.totalCad))}`, severity: "negative" });
  if (safeDiv(cashLike, summary.totalCad) < 0.05) alerts.push({ label: "Cash/T-bill buffer is below 5%", severity: "negative" });
  if (portfolioTwr && benchmarkRet !== null && benchmarkRet - portfolioTwr.value > 0.05) {
    alerts.push({ label: `${selectedBenchmarkConfig().shortLabel} is beating this view by ${pct(benchmarkRet - portfolioTwr.value)}`, severity: "negative" });
  }
  const lastIncome = activities.filter(tx => ["DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(tx.transaction)).at(-1);
  if (lastIncome) alerts.push({ label: `Latest income: ${displaySymbol(lastIncome.symbol)} ${money(amountCad(lastIncome.amount, lastIncome.currency))} on ${lastIncome.date}`, severity: "positive" });
  return alerts.slice(0, 12);
}

function missingHistoricalPriceSymbols() {
  const symbols = new Set();
  const ignored = new Set();
  const isOptionSymbol = symbol => {
    const s = String(symbol || "");
    if (!s.includes(" ")) return false;
    return /\b\d{6}[CP]\d+\b/i.test(s) || /\b\d{6}[CP]\b/i.test(s);
  };
  activities
    .filter(tx => ["TRADE_BUY", "TRADE_SELL", "OPTION_EXPIRY"].includes(tx.transaction))
    .filter(tx => tx.symbol !== "Cash")
    .forEach(tx => {
      if (isOptionSymbol(tx.rawSymbol || tx.symbol) || isOptionSymbol(tx.symbol)) {
        ignored.add(String(tx.rawSymbol || tx.symbol).trim());
        return;
      }
      if (!(priceBySymbol.get(canonicalSymbol(tx.symbol)) || []).length) symbols.add(displaySymbol(tx.symbol));
    });
  return { missing: [...symbols].sort(), ignored: [...ignored].sort() };
}

function qualityScores() {
  const summary = activeTotals();
  const rows = activeHoldings();
  const topWeight = safeDiv(rows[0]?.marketCad || 0, summary.totalCad);
  const topFive = safeDiv(rows.slice(0, 5).reduce((sum, row) => sum + row.marketCad, 0), summary.totalCad);
  const core = portfolioViewMode === "stocks" ? 0 : safeDiv(rows.filter(row => targetBucketFor(row) === "Core ETF").reduce((sum, row) => sum + row.marketCad, 0), summary.totalCad);
  const speculative = safeDiv(rows.filter(row => metadataFor(row.symbol).riskBucket === "High").reduce((sum, row) => sum + row.marketCad, 0), summary.totalCad);
  const usd = safeDiv(rows.filter(row => row.marketCurrency === "USD").reduce((sum, row) => sum + row.marketCad, 0), summary.totalCad);
  const cashLike = portfolioViewMode === "stocks" ? 0 : safeDiv(rows.filter(row => targetBucketFor(row) === "Cash/T-Bill").reduce((sum, row) => sum + row.marketCad, 0), summary.totalCad);
  const diversification = Math.round(Math.max(0, 100 - topFive * 80));
  const concentration = Math.round(Math.max(0, 100 - topWeight * 220));
  const currency = Math.round(Math.max(0, 100 - Math.abs(usd - 0.35) * 140));
  const speculation = Math.round(Math.max(0, 100 - speculative * 130));
  const incomeReliability = Math.round(Math.min(100, cashLike * 180 + core * 70));
  return [
    { label: "Diversification score", score: diversification, detail: `Top 5 weight ${pct(topFive)}` },
    { label: "Concentration risk", score: concentration, detail: `Largest holding ${pct(topWeight)}` },
    { label: "Currency risk", score: currency, detail: `USD exposure ${pct(usd)}` },
    { label: "Speculation score", score: speculation, detail: `High-risk sleeve ${pct(speculative)}` },
    { label: "Income reliability", score: incomeReliability, detail: `Cash/core buffer ${pct(cashLike + core)}` }
  ];
}

function totals() {
  const totalCad = holdings.reduce((sum, row) => sum + row.marketCad, 0);
  const costCad = holdings.reduce((sum, row) => sum + row.costCad, 0);
  const byCurrency = holdings.reduce((acc, row) => {
    acc[row.marketCurrency] = (acc[row.marketCurrency] || 0) + row.marketValue;
    return acc;
  }, {});
  return { totalCad, costCad, returnCad: totalCad - costCad, byCurrency };
}

function grouped(rows, keyFn) {
  const map = new Map();
  rows.forEach(row => {
    const key = keyFn(row);
    map.set(key, (map.get(key) || 0) + row.marketCad);
  });
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
}

function buildStatementData() {
  const months = new Map();
  const traded = new Map();
  const income = new Map();
  const totals = {
    contributions: 0,
    withdrawals: 0,
    netContributions: 0,
    buys: 0,
    sells: 0,
    tradingVolume: 0,
    dividends: 0,
    feesTaxes: 0,
    commissions: 0,
    stockLendingIncome: 0,
    stockLendingEvents: 0,
    monthsPresent: 0,
    monthsExpected: 0
  };

  activities.forEach(tx => {
    const month = tx.date.slice(0, 7);
    if (!months.has(month)) {
      months.set(month, { month, present: true, contributions: 0, buys: 0, sells: 0, dividends: 0 });
    }
    const bucket = months.get(month);
    const cad = amountCad(tx.amount, tx.currency);

    if (tx.transaction === "MONEY_MOVEMENT" && cad > 0) {
      totals.contributions += cad;
      bucket.contributions += cad;
    }
    if (tx.transaction === "MONEY_MOVEMENT" && cad < 0) {
      totals.withdrawals += cad;
    }
    if (tx.transaction === "TRADE_BUY") {
      totals.buys += Math.abs(cad);
      bucket.buys += Math.abs(cad);
      const item = traded.get(tx.symbol) || { symbol: displaySymbol(tx.symbol), transactions: 0, buys: 0, sells: 0 };
      item.transactions += 1;
      item.buys += Math.abs(cad);
      traded.set(tx.symbol, item);
    }
    if (tx.transaction === "TRADE_SELL") {
      totals.sells += Math.abs(cad);
      bucket.sells += Math.abs(cad);
      const item = traded.get(tx.symbol) || { symbol: displaySymbol(tx.symbol), transactions: 0, buys: 0, sells: 0 };
      item.transactions += 1;
      item.sells += Math.abs(cad);
      traded.set(tx.symbol, item);
    }
    if (["DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(tx.transaction)) {
      totals.dividends += cad;
      bucket.dividends += cad;
      if (tx.transaction === "STOCK_LENDING_INCOME") totals.stockLendingIncome += cad;
      const item = income.get(tx.symbol) || { symbol: displaySymbol(tx.symbol), transactions: 0, dividends: 0 };
      item.transactions += 1;
      item.dividends += cad;
      income.set(tx.symbol, item);
    }
    if (["FEE", "NRT", "TAX"].includes(tx.transaction)) totals.feesTaxes += cad;
    if (tx.commission) totals.commissions += Math.abs(amountCad(tx.commission, tx.currency));
  });

  totals.netContributions = totals.contributions + totals.withdrawals;
  totals.tradingVolume = totals.buys + totals.sells;
  totals.monthsPresent = months.size;
  totals.monthsExpected = months.size;

  statementData = {
    source: "activities-export",
    coverage: { start: activities[0]?.date || "-", end: activities.at(-1)?.date || "-", missing: [] },
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    totals,
    topTraded: [...traded.values()].sort((a, b) => (b.buys + b.sells) - (a.buys + a.sells)),
    topIncome: [...income.values()].sort((a, b) => b.dividends - a.dividends),
    recent: [...activities].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12),
    transactions: activities
  };
}

function drawDonut(canvas, items) {
  if (!canvas) return;
  if (canvas.clientWidth < 24) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const height = 360;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, height);
  const total = items.reduce((sum, item) => sum + item.value, 0);
  const cx = canvas.clientWidth / 2;
  const cy = height / 2;
  const radius = Math.max(1, Math.min(cx - 8, 150));
  let start = -Math.PI / 2;
  items.forEach((item, index) => {
    const angle = total ? (item.value / total) * Math.PI * 2 : 0;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = colors[index % colors.length];
    ctx.fill();
    start += angle;
  });
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.58, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#f8fafc";
  ctx.font = "800 20px Outfit, system-ui";
  ctx.textAlign = "center";
  ctx.fillText(money(total), cx, cy - 2);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px Outfit, system-ui";
  ctx.fillText("estimated CAD", cx, cy + 20);
}

function drawReturnBars(canvas) {
  if (!canvas) return;
  const mode = document.querySelector("#returnMode")?.value || "absolute";
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const height = 360;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, height);
  const data = activeHoldings().map(row => ({
    label: row.display,
    value: mode === "percent" ? row.returnPct : row.unrealizedCad
  })).sort((a, b) => b.value - a.value);
  const max = Math.max(...data.map(item => Math.abs(item.value)), 1);
  const left = 78;
  const right = mode === "percent" ? 120 : 150;
  const width = canvas.clientWidth - left - right;
  const mid = left + width / 2;
  const barH = Math.max(12, Math.min(22, 290 / Math.max(data.length, 1)));
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(mid, 34);
  ctx.lineTo(mid, 330);
  ctx.stroke();
  data.forEach((item, index) => {
    const y = 40 + index * (barH + 6);
    const barW = Math.abs(item.value) / max * (width / 2 - 8);
    ctx.fillStyle = item.value >= 0 ? "#10b981" : "#ef4444";
    ctx.fillRect(item.value >= 0 ? mid : mid - barW, y, barW, barH);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "700 12px Outfit, system-ui";
    ctx.textAlign = "right";
    ctx.fillText(item.label, left - 8, y + barH - 2);
    ctx.fillStyle = "#94a3b8";
    ctx.textAlign = item.value >= 0 ? "left" : "right";
    const label = mode === "percent" ? pct(item.value) : money(item.value);
    const x = item.value >= 0 ? Math.min(mid + barW + 6, canvas.clientWidth - 12) : Math.max(mid - barW - 6, 12);
    ctx.fillText(label, x, y + barH - 2);
  });
}

function drawTimeline(canvas) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const height = 280;
  const end = latestDate();
  const start = periodStartDate(selectedPeriod, end);
  const portfolioIndex = activeTwrIndexSeries(selectedPeriod);
  const startBenchmark = priceAt("^GSPC", start);
  const benchmarkPoints = portfolioIndex.map(point => {
    const price = priceAt("^GSPC", point.date);
    return { date: point.date, value: startBenchmark && price ? safeDiv(price.close, startBenchmark.close) : null };
  }).filter(point => point.value);
  const step = Math.max(1, Math.floor(portfolioIndex.length / 90));
  const points = portfolioIndex.filter((_, index) => index % step === 0 || index === portfolioIndex.length - 1);
  const bench = benchmarkPoints.filter((_, index) => index % step === 0 || index === benchmarkPoints.length - 1);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, height);
  if (points.length < 2) {
    document.querySelector("#timelineStatus").textContent = "Needs daily prices";
    return;
  }
  const pad = 42;
  const combined = [...points, ...bench].map(point => point.value).filter(Number.isFinite);
  const min = Math.min(...combined) * 0.96;
  const max = Math.max(...combined) * 1.04;
  const x = index => pad + (index / (points.length - 1)) * (canvas.clientWidth - pad * 2);
  const y = value => 230 - ((value - min) / Math.max(max - min, 1)) * 180;
  if (bench.length > 1) {
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    bench.forEach((point, index) => index ? ctx.lineTo(x(index), y(point.value)) : ctx.moveTo(x(index), y(point.value)));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 3;
  ctx.beginPath();
  points.forEach((point, index) => index ? ctx.lineTo(x(index), y(point.value)) : ctx.moveTo(x(index), y(point.value)));
  ctx.stroke();
  ctx.fillStyle = "#3b82f6";
  ctx.fillRect(pad, 18, 14, 4);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 12px Outfit, system-ui";
  ctx.textAlign = "left";
  ctx.fillText(portfolioViewMode === "stocks" ? "Stock-picking TWR" : "Portfolio TWR", pad + 20, 23);
  ctx.fillStyle = "#f59e0b";
  ctx.fillRect(pad + 136, 18, 14, 4);
  ctx.fillStyle = "#94a3b8";
  ctx.fillText("S&P 500", pad + 156, 23);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 12px Outfit, system-ui";
  ctx.textAlign = "left";
  ctx.fillText(points[0].date, pad, 258);
  ctx.textAlign = "right";
  ctx.fillText(points.at(-1).date, canvas.clientWidth - pad, 258);
  document.querySelector("#timelineStatus").textContent = `${portfolioIndex.length} daily ${portfolioViewMode === "stocks" ? "stock-picking" : "portfolio"} TWR points`;
}

function drawActivityChart(canvas) {
  if (!canvas || !statementData) return;
  const data = statementData.months;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const height = 300;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, height);
  const left = 44;
  const base = 218;
  const width = canvas.clientWidth - left - 18;
  const barW = Math.max(7, width / data.length - 6);
  const max = Math.max(...data.flatMap(month => [month.contributions, month.sells, month.dividends, month.buys]), 1);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(left, base);
  ctx.lineTo(canvas.clientWidth - 18, base);
  ctx.stroke();
  data.forEach((month, index) => {
    const x = left + index * (width / data.length);
    const positive = month.contributions + month.sells + month.dividends;
    const posH = positive / max * 150;
    const negH = month.buys / max * 150;
    ctx.fillStyle = "#10b981";
    ctx.fillRect(x, base - posH, barW, posH);
    ctx.fillStyle = "#ef4444";
    ctx.fillRect(x, base + 2, barW, negH);
    if (index % 3 === 0) {
      ctx.save();
      ctx.translate(x + barW / 2, 280);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "700 10px Outfit, system-ui";
      ctx.textAlign = "right";
      ctx.fillText(month.month, 0, 0);
      ctx.restore();
    }
  });
}

function drawIncomeChart(canvas) {
  if (!canvas) return;
  const data = monthlyIncomeRows();
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const height = 260;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, height);
  if (!data.length) return;
  const left = 44;
  const base = 198;
  const width = canvas.clientWidth - left - 18;
  const barW = Math.max(7, width / data.length - 6);
  const max = Math.max(...data.map(row => row.total), 1);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(left, base);
  ctx.lineTo(canvas.clientWidth - 18, base);
  ctx.stroke();
  data.forEach((row, index) => {
    const x = left + index * (width / data.length);
    let y = base;
    const divH = row.dividends / max * 150;
    const intH = row.interest / max * 150;
    const lendH = row.lending / max * 150;
    ctx.fillStyle = "#10b981";
    ctx.fillRect(x, y - divH, barW, divH);
    y -= divH;
    ctx.fillStyle = "#3b82f6";
    ctx.fillRect(x, y - intH, barW, intH);
    y -= intH;
    ctx.fillStyle = "#f59e0b";
    ctx.fillRect(x, y - lendH, barW, lendH);
    if (index % 3 === 0) {
      ctx.save();
      ctx.translate(x + barW / 2, 242);
      ctx.rotate(-Math.PI / 4);
      ctx.fillStyle = "#94a3b8";
      ctx.font = "700 10px Outfit, system-ui";
      ctx.textAlign = "right";
      ctx.fillText(row.month, 0, 0);
      ctx.restore();
    }
  });
}


function isIndividualStock(rowOrSymbol) {
  const symbol = typeof rowOrSymbol === "string" ? rowOrSymbol : rowOrSymbol?.symbol;
  const display = displaySymbol(symbol).toUpperCase();
  const meta = metadataFor(symbol);
  const assetClass = String(meta.assetClass || "").toLowerCase();
  const bucket = typeof rowOrSymbol === "string" ? targetBucketFor({ symbol }) : targetBucketFor(rowOrSymbol);

  if (!looksLikeIndividualStockSymbol(symbol)) return false;
  if (isExplicitlyExcludedFromStockPicking(symbol)) return false;
  if (bucket === "Cash/T-Bill" || bucket === "Core ETF") return false;
  if (assetClass.includes("etf") || assetClass.includes("fund") || assetClass.includes("trust")) return false;

  // Normal metadata path.
  if (assetClass === "stock" || assetClass === "stock/etf") return true;

  // Sold-only fallback: if not explicitly excluded and it traded like a normal ticker, treat as stock.
  return looksLikeIndividualStockSymbol(symbol);
}

function activeHoldings() {
  return portfolioViewMode === "stocks"
    ? holdings.filter(row => isIndividualStock(row))
    : holdings;
}

function activeActivities() {
  if (portfolioViewMode !== "stocks") return activities;
  const activeSymbols = new Set(activeHoldings().map(row => canonicalSymbol(row.symbol)));
  return activities.filter(tx => {
    if (tx.symbol === "Cash") return false;
    return activeSymbols.has(canonicalSymbol(tx.symbol));
  });
}

function activeTotals() {
  const rows = activeHoldings();
  const totalCad = rows.reduce((sum, row) => sum + row.marketCad, 0);
  const costCad = rows.reduce((sum, row) => sum + row.costCad, 0);
  const byCurrency = rows.reduce((acc, row) => {
    acc[row.marketCurrency] = (acc[row.marketCurrency] || 0) + row.marketValue;
    return acc;
  }, {});
  return { totalCad, costCad, returnCad: totalCad - costCad, byCurrency };
}

function activeIncomeTotal() {
  if (portfolioViewMode !== "stocks") return statementData?.totals.dividends || 0;
  const activeSymbols = new Set(activeHoldings().map(row => canonicalSymbol(row.symbol)));
  return activities
    .filter(tx => ["DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(tx.transaction))
    .filter(tx => activeSymbols.has(canonicalSymbol(tx.symbol)))
    .reduce((sum, tx) => sum + amountCad(tx.amount, tx.currency), 0);
}




const nonStockSymbols = new Set([
  "CASH", "VCN", "VFV", "XQQ",
  "CASH.TO", "VCN.TO", "VFV.TO", "XQQ.TO"
]);

function isExplicitlyExcludedFromStockPicking(symbol) {
  const canonical = canonicalSymbol(symbol);
  const display = displaySymbol(canonical).toUpperCase();
  return nonStockSymbols.has(canonical) || nonStockSymbols.has(display);
}

function looksLikeIndividualStockSymbol(symbol) {
  const canonical = canonicalSymbol(symbol);
  const display = displaySymbol(canonical).toUpperCase();
  if (!canonical || canonical === "Cash") return false;
  if (isExplicitlyExcludedFromStockPicking(canonical)) return false;
  if (/\b\d{6}[CP]\d+\b/i.test(display)) return false; // options
  return true;
}

function allIndividualStockSymbolsEver() {
  const symbols = new Set();

  activities
    .filter(tx => tx.symbol && tx.symbol !== "Cash")
    .filter(tx => ["TRADE_BUY", "TRADE_SELL", "DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(tx.transaction))
    .forEach(tx => {
      const symbol = canonicalSymbol(tx.symbol);
      if (looksLikeIndividualStockSymbol(symbol) && isIndividualStock(symbol)) symbols.add(symbol);
    });

  holdings.filter(row => isIndividualStock(row)).forEach(row => symbols.add(canonicalSymbol(row.symbol)));

  return symbols;
}

function firstStockOnlyDate() {
  const key = "firstStockOnlyDate";
  if (stockPerformanceCache.has(key)) return stockPerformanceCache.get(key);

  const symbols = allIndividualStockSymbolsEver();

  const dates = activities
    .filter(tx => symbols.has(canonicalSymbol(tx.symbol)))
    .filter(tx => tx.transaction === "TRADE_BUY")
    .map(tx => tx.date)
    .sort();

  const first = dates[0] || latestDate();
  stockPerformanceCache.set(key, first);
  return first;
}

function activePeriodStartDate(period, end = latestDate()) {
  const rawStart = periodStartDate(period, end);

  if (portfolioViewMode !== "stocks") return rawStart;

  const firstStockDate = firstStockOnlyDate();

  if (period === "MAX") return firstStockDate;

  return rawStart < firstStockDate ? firstStockDate : rawStart;
}

function stockOnlySymbols() {
  return allIndividualStockSymbolsEver();
}

function stockOnlyTransactions(untilDate = "9999-12-31") {
  const symbols = stockOnlySymbols();
  return activities
    .filter(tx => tx.date <= untilDate)
    .filter(tx => symbols.has(canonicalSymbol(tx.symbol)))
    .filter(tx => ["TRADE_BUY", "TRADE_SELL", "DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(tx.transaction));
}

function stockOnlyReplayPositions(untilDate = "9999-12-31") {
  const map = new Map();
  const symbols = stockOnlySymbols();

  const ensure = tx => {
    const key = canonicalSymbol(tx.symbol);
    const item = map.get(key) || {
      symbol: key,
      name: tx.name || displaySymbol(key),
      quantity: 0,
      costCad: 0,
      currency: tx.currency || "CAD"
    };
    if (tx.name) item.name = tx.name;
    if (tx.currency) item.currency = tx.currency;
    map.set(key, item);
    return item;
  };

  activities
    .filter(tx => tx.date <= untilDate)
    .filter(tx => symbols.has(canonicalSymbol(tx.symbol)))
    .filter(tx => ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction))
    .forEach(tx => {
      const item = ensure(tx);
      const qty = Math.abs(tx.quantity);
      if (!qty) return;

      if (tx.transaction === "TRADE_BUY") {
        const cost = Math.abs(amountCad(tx.amount, tx.currency, tx.date));
        item.quantity += qty;
        item.costCad += cost;
      }

      if (tx.transaction === "TRADE_SELL") {
        const matched = Math.min(qty, Math.max(item.quantity, 0));
        const avgCost = item.quantity ? item.costCad / item.quantity : 0;
        item.quantity -= matched;
        item.costCad -= avgCost * matched;
      }
    });

  return [...map.values()].filter(item => Math.abs(item.quantity) > 0.000001);
}

function stockOnlyValueAt(date) {
  const key = `stockValue|${date}|${portfolioViewMode}`;
  if (stockPerformanceCache.has(key)) return stockPerformanceCache.get(key);

  const value = stockOnlyReplayPositions(date).reduce((sum, position) => {
    const valued = valuePosition(position, date, {
      allowSnapshotPriceFallback: Boolean(holdingsCurrentAsOf && date >= holdingsCurrentAsOf),
      snapshot: holdingsSnapshotMap.get(canonicalSymbol(position.symbol))
    });
    return sum + valued.marketCad;
  }, 0);

  stockPerformanceCache.set(key, value);
  return value;
}

function stockOnlyFlowAmount(tx) {
  const cad = amountCad(tx.amount, tx.currency, tx.date);
  if (tx.transaction === "TRADE_BUY") return Math.abs(cad);
  if (tx.transaction === "TRADE_SELL") return -Math.abs(cad);
  return 0;
}

function stockOnlyFlowsBetween(start, end, includeStart = false) {
  const symbols = stockOnlySymbols();
  return activities
    .filter(tx => (includeStart ? tx.date >= start : tx.date > start) && tx.date <= end)
    .filter(tx => symbols.has(canonicalSymbol(tx.symbol)))
    .filter(tx => ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction))
    .reduce((sum, tx) => sum + stockOnlyFlowAmount(tx), 0);
}

function activeAccountValueAt(date) {
  return portfolioViewMode === "stocks" ? stockOnlyValueAt(date) : accountValueAt(date);
}

function activeCurrentValue() {
  return portfolioViewMode === "stocks" ? activeTotals().totalCad : currentOfficialAccountValue();
}

function activeFlowsBetween(start, end, includeStart = false) {
  return portfolioViewMode === "stocks"
    ? stockOnlyFlowsBetween(start, end, includeStart)
    : externalFlowsBetween(start, end, includeStart);
}

function activePeriodReturn(period) {
  if (portfolioViewMode !== "stocks") return periodReturn(period);

  const key = `stockPeriod|${period}`;
  if (stockPerformanceCache.has(key)) return stockPerformanceCache.get(key);

  const end = latestDate();
  const start = activePeriodStartDate(period, end);
  if (!start || start >= end) return null;

  const isMax = period === "MAX";
  const startValue = isMax ? 0 : activeAccountValueAt(start);
  const endValue = activeCurrentValue();
  const netFlows = activeFlowsBetween(start, end, isMax);
  const gain = endValue - startValue - netFlows;
  const denominator = isMax ? Math.max(netFlows, 0) : startValue + Math.max(netFlows, 0);
  const simple = startValue ? safeDiv(endValue - startValue, startValue) : null;
  const result = { period, start, end, startValue, endValue, netFlows, gain, denominator, simple, value: safeDiv(gain, denominator) };

  stockPerformanceCache.set(key, result);
  return result;
}

function activeDailyAccountSeries(start = periodStartDate("MAX", latestDate()), end = latestDate()) {
  if (portfolioViewMode !== "stocks") return dailyAccountSeries(start, end);

  const key = `stockDaily|${start}|${end}`;
  if (stockPerformanceCache.has(key)) return stockPerformanceCache.get(key);

  const series = valuationDates(start, end)
    .map(date => ({ date, value: activeAccountValueAt(date) }))
    .filter(point => Number.isFinite(point.value) && point.value > 0);

  if (series.length && end === latestDate()) {
    series[series.length - 1] = { date: end, value: activeCurrentValue() };
  }

  stockPerformanceCache.set(key, series);
  return series;
}

function activeTwrIndexSeries(period = selectedPeriod) {
  if (portfolioViewMode !== "stocks") return twrIndexSeries(period);

  const key = `stockTwrSeries|${period}`;
  if (stockPerformanceCache.has(key)) return stockPerformanceCache.get(key);

  const end = latestDate();
  const start = activePeriodStartDate(period, end);
  const points = activeDailyAccountSeries(start, end).filter(point => point.value > 0);
  if (points.length < 2) return [];

  const series = [{ date: points[0].date, value: 1 }];
  let previous = points[0];
  let index = 1;

  for (const point of points.slice(1)) {
    const flow = activeFlowsBetween(previous.date, point.date, false);
    if (previous.value > 0) {
      const subReturn = (point.value - flow) / previous.value - 1;
      if (Number.isFinite(subReturn)) index *= 1 + subReturn;
      series.push({ date: point.date, value: index });
    }
    previous = point;
  }

  stockPerformanceCache.set(key, series);
  return series;
}

function activeTimeWeightedReturn(period = selectedPeriod) {
  if (portfolioViewMode !== "stocks") return timeWeightedReturn(period);

  // In stock-only mode, use selected-period contribution-adjusted return.
  // This changes with 1D / 1M / 3M / 6M / YTD / 1Y / 2Y / MAX.
  // Do not use reconstructed stock-sleeve TWR here because it can inflate
  // returns when large buys/sells happen inside the period.
  const periodResult = activePeriodReturn(period);
  if (!periodResult) return null;

  return {
    start: periodResult.start,
    end: periodResult.end,
    value: periodResult.value,
    method: "selected-period-contribution-adjusted"
  };
}

function activeDailyTwrReturns(period = selectedPeriod) {
  const series = activeTwrIndexSeries(period);
  return series.slice(1).map((point, index) => ({
    date: point.date,
    value: safeDiv(point.value, series[index].value) - 1
  })).filter(row => Number.isFinite(row.value));
}

function activeRiskMetrics(period = selectedPeriod) {
  if (portfolioViewMode !== "stocks") return riskMetrics(period);

  const portfolio = activeDailyTwrReturns(period);
  const benchmark = benchmarkDailyReturns("^GSPC", period);
  const values = portfolio.map(row => row.value);
  const paired = pairedReturns(portfolio, benchmark);
  const pairedPortfolio = paired.map(row => row.portfolio);
  const pairedBenchmark = paired.map(row => row.benchmark);
  const dailyStd = stddev(values);
  const downsideStd = stddev(values.filter(value => value < 0));
  const benchmarkVariance = stddev(pairedBenchmark) ** 2;
  const beta = benchmarkVariance ? covariance(pairedPortfolio, pairedBenchmark) / benchmarkVariance : null;
  const correlationDenom = stddev(pairedPortfolio) * stddev(pairedBenchmark);

  return {
    observations: values.length,
    volatility: dailyStd * Math.sqrt(252),
    sharpe: dailyStd ? mean(values) / dailyStd * Math.sqrt(252) : null,
    sortino: downsideStd ? mean(values) / downsideStd * Math.sqrt(252) : null,
    beta,
    correlation: correlationDenom ? covariance(pairedPortfolio, pairedBenchmark) / correlationDenom : null,
    maxDrawdown: maxDrawdown(activeTwrIndexSeries(period))
  };
}

function renderSummary() {
  const summary = activeTotals();
  const viewHoldings = activeHoldings();
  const usdCad = viewHoldings.filter(row => row.marketCurrency === "USD").reduce((sum, row) => sum + row.marketCad, 0);
  const cashLikeRows = portfolioViewMode === "stocks" ? [] : viewHoldings.filter(row => targetBucketFor(row) === "Cash/T-Bill" || metadataFor(row.symbol).sector === "Cash");
  const cashLikeCad = cashLikeRows.reduce((sum, row) => sum + row.marketCad, 0);

  const investableStocks = viewHoldings.filter(row => {
    const meta = metadataFor(row.symbol);
    const assetClass = String(meta.assetClass || "").toLowerCase();
    const bucket = targetBucketFor(row);
    return assetClass === "stock" && bucket !== "Cash/T-Bill";
  });

  const largestStock = investableStocks[0] || viewHoldings.find(row => targetBucketFor(row) !== "Cash/T-Bill") || viewHoldings[0] || null;
  const mainCashLike = cashLikeRows[0];

  const holdingsSuffix = holdingsCurrentAsOf ? `; holdings as of ${holdingsCurrentAsOf}` : "";
  document.querySelector("#asOf").textContent = `Activities through ${activities.at(-1)?.date || "-"}; prices through ${priceRows.map(row => row.date).sort().at(-1) || latestDate()}${holdingsSuffix}`;
  document.querySelector("#totalValue").textContent = money(summary.totalCad);
  document.querySelector("#totalCost").textContent = money(summary.costCad);
  document.querySelector("#totalReturn").textContent = money(summary.returnCad);
  document.querySelector("#totalReturn").className = summary.returnCad >= 0 ? "positive" : "negative";
  document.querySelector("#totalReturnPct").textContent = `${pct(safeDiv(summary.returnCad, summary.costCad))} on reconstructed cost`;
  document.querySelector("#totalDividends").textContent = money(activeIncomeTotal());
  document.querySelector("#holdingCount").textContent = viewHoldings.length;
  document.querySelector("#currencySplit").textContent = Object.entries(summary.byCurrency).map(([cur, value]) => `${money(value, cur)} ${cur}`).join(" + ") || "-";
  document.querySelector("#usdExposure").textContent = pct(safeDiv(usdCad, summary.totalCad));

  document.querySelector("#topHolding").textContent = largestStock?.display || "-";
  document.querySelector("#topHoldingDetail").textContent = largestStock
    ? `${money(largestStock.marketCad)} / ${pct(safeDiv(largestStock.marketCad, summary.totalCad))}`
    : "-";

  document.querySelector("#concentrationScore").textContent = pct(safeDiv(cashLikeCad, summary.totalCad));
  const concentrationCard = document.querySelector("#concentrationScore")?.closest("article");
  const concentrationDetail = concentrationCard?.querySelector("small");
  if (concentrationDetail) {
    concentrationDetail.textContent = portfolioViewMode === "stocks"
      ? "ETFs / trusts / funds excluded from stock-picking mode"
      : mainCashLike
        ? `${money(cashLikeCad)} mostly ${mainCashLike.display}`
        : "Cash / T-bill allocation";
  }
}

function yearlyPortfolioReturnRows() {
  const firstDate = activities[0]?.date;
  const lastDate = latestDate();
  if (!firstDate || !lastDate) return [];

  const firstYear = Number(firstDate.slice(0, 4));
  const lastYear = Number(lastDate.slice(0, 4));
  const rows = [];

  for (let year = lastYear; year >= firstYear; year -= 1) {
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const start = year === firstYear ? firstDate : yearStart;
    const end = year === lastYear ? lastDate : yearEnd;

    if (start >= end) continue;

    const points = dailyAccountSeries(start, end).filter(point => point.value > 0);
    if (points.length < 2) continue;

    let previous = points[0];
    let index = 1;

    for (const point of points.slice(1)) {
      const flow = externalFlowsBetween(previous.date, point.date, false);
      if (previous.value > 0) {
        const subReturn = (point.value - flow) / previous.value - 1;
        if (Number.isFinite(subReturn)) index *= 1 + subReturn;
      }
      previous = point;
    }

    rows.push({
      year,
      start: points[0].date,
      end: points.at(-1).date,
      value: index - 1,
      points: points.length,
      partial: year === firstYear || year === lastYear
    });
  }

  return rows;
}

function renderYearlyPortfolioReturns() {
  const panel = document.querySelector("#yearlyReturnsPanel");
  const body = document.querySelector("#yearlyReturnsBody");
  if (!panel || !body) return;

  panel.style.display = portfolioViewMode === "stocks" ? "none" : "";

  const rows = yearlyPortfolioReturnRows();

  body.innerHTML = rows.map(row => `
    <tr>
      <td>${row.year}</td>
      <td class="${row.value >= 0 ? "positive" : "negative"}">${pct(row.value)}</td>
      <td>${row.start} to ${row.end}${row.partial ? " · partial year" : ""}</td>
    </tr>
  `).join("") || `<tr><td colspan="3">Needs activity and price history.</td></tr>`;
}

function renderPerformance() {
  const selected = activePeriodReturn(selectedPeriod);
  const selectedTwr = portfolioViewMode === "stocks" ? activePeriodReturn(selectedPeriod) : activeTimeWeightedReturn(selectedPeriod);
  const flows = activeBuildXirrFlows();
  const irr = flows ? xirr(flows) : null;
  const breakdown = portfolioViewMode === "stocks" ? activeRealizedBreakdown() : returnBreakdown();
  const periodMove = document.querySelector("#periodMove");
  const periodLabel = document.querySelector("#periodLabel");
  const cashNode = document.querySelector("#cashAdjustedReturn");
  const cashLabel = document.querySelector("#cashAdjustedLabel");
  if (selected) {
    periodMove.textContent = `${money(selected.gain)} (${pct(selectedTwr?.value ?? selected.value)})`;
    periodMove.className = selected.gain >= 0 ? "positive" : "negative";
    periodLabel.textContent = portfolioViewMode === "stocks"
      ? `${selected.start} to ${selected.end}; stock-pick flows ${money(selected.netFlows)}`
      : `${selected.start} to ${selected.end}; net cash flow ${money(selected.netFlows)}`;
    cashNode.textContent = `${pct(selectedTwr?.value ?? selected.value)} TWR / ${money(selected.gain)} gain`;
    cashNode.className = (selectedTwr?.value ?? selected.value) >= 0 ? "positive" : "negative";
    cashLabel.textContent = portfolioViewMode === "stocks"
      ? "Individual-stock selected-period return; excludes ETFs, trusts, funds, options, and cash-like holdings"
      : "Excludes deposits and withdrawals";
  } else {
    periodMove.textContent = "Needs data";
    periodLabel.textContent = "Need activities and prices for this period";
    cashNode.textContent = "Needs data";
  }

  const simpleNode = document.querySelector("#perfSimple");
  if (simpleNode) {
    simpleNode.textContent = selected?.simple === null ? "N/A" : pct(selected?.simple);
    simpleNode.className = selected?.simple >= 0 ? "positive" : selected?.simple < 0 ? "negative" : "";
  }
  const twrNode = document.querySelector("#perfTwr");
  if (twrNode) {
    twrNode.textContent = selectedTwr ? pct(selectedTwr.value) : "Needs data";
    twrNode.className = selectedTwr?.value >= 0 ? "positive" : selectedTwr ? "negative" : "";
  }
  const xirrNode = document.querySelector("#perfXirr");
  if (xirrNode) {
    xirrNode.textContent = irr === null ? "Needs cash flows" : `${pct(irr)} annualized`;
    xirrNode.className = irr >= 0 ? "positive" : irr < 0 ? "negative" : "";
  }
  const gainNode = document.querySelector("#perfAdjustedGain");
  if (gainNode) {
    gainNode.textContent = selected ? money(selected.gain) : "Needs data";
    gainNode.className = selected?.gain >= 0 ? "positive" : selected ? "negative" : "";
  }
  const totalReturnNode = document.querySelector("#perfTotalReturn");
  if (totalReturnNode) {
    totalReturnNode.textContent = money(breakdown.total);
    totalReturnNode.className = breakdown.total >= 0 ? "positive" : "negative";
  }
  const returnBreakdownNode = document.querySelector("#returnBreakdown");
  if (returnBreakdownNode) {
    returnBreakdownNode.innerHTML = [
      ["Realized gains", breakdown.realized],
      ["Unrealized gains", breakdown.unrealized],
      ["Dividends / interest", breakdown.income],
      ["Fees / taxes", breakdown.fees]
    ].map(([label, value]) => `
      <div class="metric-row">
        <span>${label}</span>
        <strong class="${value >= 0 ? "positive" : "negative"}">${money(value)}</strong>
      </div>
    `).join("");
  }

  ["1M", "3M", "6M", "YTD", "1Y", "2Y", "MAX"].forEach(period => {
    const result = activePeriodReturn(period);
    const twr = activeTimeWeightedReturn(period);
    const node = document.querySelector(`#return${period}`);
    const benchNode = document.querySelector(`#bench${period}`);
    if (node) {
      const returnValue = twr?.value ?? result?.value;
      node.textContent = result ? `${pct(returnValue)} / ${money(result.gain)}` : "Needs data";
      node.className = returnValue >= 0 ? "positive" : result ? "negative" : "";
    }
    if (benchNode) {
      const bench = selectedBenchmarkReturn(period);
      const excess = bench === null || !twr ? null : twr.value - bench;
      const label = selectedBenchmarkConfig().shortLabel;
      benchNode.textContent = bench === null ? `${label}: needs prices` : `${label} ${pct(bench)}${excess === null ? "" : ` / excess ${pct(excess)}`}`;
      benchNode.className = excess === null ? "muted" : excess >= 0 ? "positive" : "negative";
    }
  });
  document.querySelector("#performanceStatus").textContent = "TWR + XIRR";
}


const benchmarkConfigs = {
  SP500: {
    label: "S&P 500",
    shortLabel: "S&P 500",
    description: "US large-cap index benchmark",
    type: "single",
    symbol: "^GSPC"
  },
  VFV: {
    label: "VFV",
    shortLabel: "VFV",
    description: "Canadian-listed S&P 500 ETF proxy",
    type: "single",
    symbol: "VFV.TO"
  },
  VEQT: {
    label: "VEQT",
    shortLabel: "VEQT",
    description: "Global all-equity ETF proxy",
    type: "single",
    symbol: "VEQT.TO"
  },
  XQQ: {
    label: "XQQ / Nasdaq 100",
    shortLabel: "XQQ",
    description: "Canadian-listed Nasdaq 100 ETF proxy",
    type: "single",
    symbol: "XQQ.TO"
  },
  VFV_CASH_70_30: {
    label: "70/30 VFV-CASH",
    shortLabel: "70/30 VFV-CASH",
    description: "Simple blended benchmark: 70% VFV, 30% cash-like ETF",
    type: "blend",
    parts: [
      { symbol: "VFV.TO", weight: 0.70 },
      { symbol: "CASH.TO", weight: 0.30 }
    ]
  }
};

function selectedBenchmarkConfig() {
  return benchmarkConfigs[selectedBenchmark] || benchmarkConfigs.SP500;
}


function benchmarkReturnBetween(symbol, start, end) {
  const startPrice = priceAt(symbol, start);
  const endPrice = priceAt(symbol, end);
  if (!startPrice || !endPrice || startPrice.date === endPrice.date) return null;
  return safeDiv(endPrice.close - startPrice.close, startPrice.close);
}

function selectedBenchmarkReturnBetween(start, end) {
  const config = selectedBenchmarkConfig();

  if (config.type === "single") {
    return benchmarkReturnBetween(config.symbol, start, end);
  }

  if (config.type === "blend") {
    let total = 0;
    let usedWeight = 0;

    for (const part of config.parts) {
      const value = benchmarkReturnBetween(part.symbol, start, end);
      if (value === null || !Number.isFinite(value)) continue;
      total += value * part.weight;
      usedWeight += part.weight;
    }

    return usedWeight > 0 ? total / usedWeight : null;
  }

  return null;
}

function selectedBenchmarkReturn(period) {
  const end = latestDate();
  const start = portfolioViewMode === "stocks"
    ? activePeriodStartDate(period, end)
    : periodStartDate(period, end);

  return selectedBenchmarkReturnBetween(start, end);
}

function renderBenchmarkComparison() {
  const period = selectedPeriod;
  const end = latestDate();
  const actualStart = portfolioViewMode === "stocks" ? activePeriodStartDate(period, end) : periodStartDate(period, end);
  const twr = activeTimeWeightedReturn(period);
  const config = selectedBenchmarkConfig();
  const bench = selectedBenchmarkReturnBetween(actualStart, end);
  const body = document.querySelector("#benchmarkBody");
  if (!body) return;

  const labelMap = {
    "1D": "1D",
    "1M": "1M",
    "3M": "3M",
    "6M": "6M",
    "YTD": "YTD",
    "1Y": "1Y",
    "2Y": "2Y",
    "MAX": "All-time"
  };

  const periodLabel = labelMap[period] || period;
  const viewLabel = portfolioViewMode === "stocks" ? "Stock Picks" : "Portfolio";
  const viewDescription = portfolioViewMode === "stocks" ? "individual-stock" : "portfolio";
  const excess = bench === null || !twr ? null : twr.value - bench;
  const outcome = excess === null ? "-" : excess >= 0 ? "Outperformed" : "Underperformed";

  const title = document.querySelector("#benchmarkTitle");
  if (title) title.textContent = `${periodLabel} ${viewLabel} vs ${config.shortLabel}`;

  const subtitle = document.querySelector("#benchmarkSubtitle");
  if (subtitle) {
    let measuredText = "";
    if (portfolioViewMode === "stocks") {
      measuredText = period === "MAX"
        ? ` Measured from ${actualStart} because that is when the individual-stock sleeve actually starts.`
        : ` Measured from ${actualStart}, the selected period start.`;
    }
    subtitle.textContent = `Your ${viewDescription} ${periodLabel} return compared with ${config.label}.${measuredText}`;
  }

  body.innerHTML = `
    <tr>
      <td colspan="4">
        <div class="benchmark-cards">
          <article>
            <span>Your return</span>
            <strong class="${twr === null ? "" : twr.value >= 0 ? "positive" : "negative"}">${twr === null ? "Needs data" : pct(twr.value)}</strong>
            <small>${portfolioViewMode === "stocks" ? `${actualStart} to ${end}` : `${viewLabel} ${periodLabel} return`}</small>
          </article>
          <article>
            <span>${escapeHtml(config.shortLabel)}</span>
            <strong class="${bench === null ? "" : bench >= 0 ? "positive" : "negative"}">${bench === null ? "Needs data" : pct(bench)}</strong>
            <small>${escapeHtml(config.description)}</small>
          </article>
          <article>
            <span>Difference</span>
            <strong class="${excess === null ? "" : excess >= 0 ? "positive" : "negative"}">${excess === null ? "-" : pct(excess)}</strong>
            <small>${outcome}</small>
          </article>
        </div>
      </td>
    </tr>
  `;

  const status = document.querySelector("#benchmarkStatus");
  if (status) status.textContent = portfolioViewMode === "stocks"
    ? `${actualStart} to ${end}`
    : `${periodLabel} ${viewLabel.toLowerCase()} return vs ${config.shortLabel}`;

  const selectedNode = document.querySelector("#selectedPeriodBenchmark");
  if (selectedNode) {
    selectedNode.textContent = bench === null || !twr
      ? `${config.shortLabel} benchmark needs ${periodLabel} data`
      : excess >= 0
        ? `${viewLabel} outperformed ${config.shortLabel} by ${pct(excess)}`
        : `${viewLabel} underperformed ${config.shortLabel} by ${pct(Math.abs(excess))}`;
    selectedNode.className = `benchmark-summary ${excess === null ? "" : excess >= 0 ? "positive" : "negative"}`;
  }
}
function renderAllocation() {
  const mode = document.querySelector("#allocationMode")?.value || "symbol";
  const keyFns = {
    symbol: row => row.display,
    securityType: row => metadataFor(row.symbol).assetClass,
    currency: row => row.marketCurrency,
    exchange: row => row.symbol.includes(".TO") || row.symbol.includes(".CN") ? "Canada" : "US",
    sector: row => metadataFor(row.symbol).sector,
    country: row => metadataFor(row.symbol).country,
    theme: row => metadataFor(row.symbol).theme,
    riskBucket: row => metadataFor(row.symbol).riskBucket,
    targetBucket: row => targetBucketFor(row)
  };
  const data = grouped(activeHoldings(), keyFns[mode]);
  drawDonut(document.querySelector("#allocationChart"), data);
  const total = data.reduce((sum, item) => sum + item.value, 0);
  document.querySelector("#allocationLegend").innerHTML = data.slice(0, 10).map((item, index) => `
    <div class="legend-item">
      <span class="swatch" style="background:${colors[index % colors.length]}"></span>
      <span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
      <strong>${pct(safeDiv(item.value, total))}</strong>
    </div>
  `).join("");
}

function renderMatrix() {
  const mode = document.querySelector("#matrixMode")?.value || "currency";
  const keyFns = {
    currency: row => row.marketCurrency,
    securityType: row => metadataFor(row.symbol).assetClass,
    exchange: row => row.symbol.includes(".TO") || row.symbol.includes(".CN") ? "Canada" : "US",
    sector: row => metadataFor(row.symbol).sector,
    country: row => metadataFor(row.symbol).country,
    theme: row => metadataFor(row.symbol).theme,
    riskBucket: row => metadataFor(row.symbol).riskBucket,
    targetBucket: row => targetBucketFor(row)
  };
  const data = grouped(activeHoldings(), keyFns[mode]);
  const total = data.reduce((sum, item) => sum + item.value, 0);
  document.querySelector("#exposureMatrix").innerHTML = data.map((item, index) => `
    <div class="matrix-row">
      <strong>${escapeHtml(item.label)}</strong>
      <div class="bar"><span style="width:${Math.max(safeDiv(item.value, total) * 100, 1)}%;background:${colors[index % colors.length]}"></span></div>
      <span>${pct(safeDiv(item.value, total))}</span>
    </div>
  `).join("");
}

function visibleHoldings() {
  const query = document.querySelector("#searchBox")?.value.trim().toLowerCase() || "";
  const sortBy = document.querySelector("#sortBy")?.value || "valueDesc";
  const rows = activeHoldings().filter(row => [row.display, row.name, row.symbol, row.marketCurrency].some(value => String(value).toLowerCase().includes(query)));
  const sorters = {
    valueDesc: (a, b) => b.marketCad - a.marketCad,
    returnDesc: (a, b) => b.unrealizedCad - a.unrealizedCad,
    returnAsc: (a, b) => a.unrealizedCad - b.unrealizedCad,
    weightDesc: (a, b) => b.marketCad - a.marketCad,
    symbolAsc: (a, b) => a.display.localeCompare(b.display)
  };
  return rows.sort(sorters[sortBy] || sorters.valueDesc);
}


function holdingDaysHeld(symbol, asOf = latestDate()) {
  const target = canonicalSymbol(symbol);
  let quantity = 0;
  let weightedDateMs = 0;

  activities
    .filter(tx => canonicalSymbol(tx.symbol) === target)
    .filter(tx => tx.date <= asOf)
    .filter(tx => ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction))
    .sort((a, b) => a.date.localeCompare(b.date))
    .forEach(tx => {
      const qty = Math.abs(tx.quantity);
      if (!qty) return;

      if (tx.transaction === "TRADE_BUY") {
        const dateMs = new Date(`${tx.date}T00:00:00`).getTime();
        weightedDateMs += dateMs * qty;
        quantity += qty;
      }

      if (tx.transaction === "TRADE_SELL" && quantity > 0) {
        const sold = Math.min(qty, quantity);
        const remainingRatio = safeDiv(quantity - sold, quantity);
        weightedDateMs *= Math.max(remainingRatio, 0);
        quantity -= sold;
      }
    });

  if (!quantity || !weightedDateMs) return null;

  const averageDateMs = weightedDateMs / quantity;
  const averageDate = new Date(averageDateMs).toISOString().slice(0, 10);
  const heldDays = Math.max(0, Math.round(daysBetween(averageDate, asOf)));

  return {
    days: heldDays,
    since: averageDate
  };
}

function renderTable() {
  const total = activeTotals().totalCad;
  document.querySelector("#holdingsBody").innerHTML = visibleHoldings().map(row => {
    const weight = safeDiv(row.marketCad, total);
    const pnlValue = Number.isFinite(row.nativeUnrealized) && row.nativeUnrealizedCurrency ? row.nativeUnrealized : row.unrealizedCad;
    const pnlCurrency = Number.isFinite(row.nativeUnrealized) && row.nativeUnrealizedCurrency ? row.nativeUnrealizedCurrency : "CAD";
    const pnlPct = row.nativeReturnPct !== null && row.nativeReturnPct !== undefined ? row.nativeReturnPct : row.returnPct;
    return `
      <tr>
        <td class="symbol">${escapeHtml(row.display)}</td>
        <td class="name-cell" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</td>
        <td>${row.symbol.includes(".TO") || row.symbol.includes(".CN") ? "CAD LISTED" : "US LISTED"}</td>
        <td>${number(row.quantity, 4)}</td>
        <td>${money(row.price, row.marketCurrency)} <small>${escapeHtml(row.priceDate)}</small></td>
        <td>${money(row.marketValue, row.marketCurrency)}</td>
        <td>${money(row.marketCad)}</td>
        <td>${pct(weight)}<div class="bar"><span style="width:${Math.max(weight * 100, 1)}%"></span></div></td>
        <td class="${pnlValue >= 0 ? "positive" : "negative"}">${money(pnlValue, pnlCurrency)} / ${pct(pnlPct)}</td>
        <td>${holdingDaysHeld(row.symbol)?.days ?? "-"}<small>${holdingDaysHeld(row.symbol)?.since ? `since ${holdingDaysHeld(row.symbol).since}` : ""}</small></td>
      </tr>
    `;
  }).join("");
}

function renderRiskConsole() {
  const summary = activeTotals();
  const metrics = activeRiskMetrics(selectedPeriod);
  const breakdown = portfolioViewMode === "stocks" ? activeRealizedBreakdown() : returnBreakdown();
  const balances = cashBalancesByCurrency();
  const viewHoldings = activeHoldings();
  const weights = viewHoldings.map(row => safeDiv(row.marketCad, summary.totalCad));
  const hhi = weights.reduce((sum, weight) => sum + weight * weight, 0);
  const negatives = viewHoldings.filter(row => row.unrealizedCad < 0);
  const winners = viewHoldings.filter(row => row.unrealizedCad > 0);
  const worst = [...negatives].sort((a, b) => a.unrealizedCad - b.unrealizedCad)[0];
  const cadListed = viewHoldings.filter(row => row.symbol.includes(".TO") || row.symbol.includes(".CN")).reduce((sum, row) => sum + row.marketCad, 0);
  const cashLike = portfolioViewMode === "stocks" ? 0 : viewHoldings.filter(row => targetBucketFor(row) === "Cash/T-Bill").reduce((sum, row) => sum + row.marketCad, 0);
  const topRisk = viewHoldings[0] ? `${viewHoldings[0].display} ${pct(safeDiv(viewHoldings[0].marketCad, summary.totalCad))}` : "-";
  document.querySelector("#riskConsole").innerHTML = `
    <div class="metric-row"><span>Diversification index</span><strong>${hhi ? number(1 / hhi, 1) : "-"} effective positions</strong></div>
    <div class="metric-row"><span>Volatility</span><strong>${metrics.observations ? pct(metrics.volatility) : "-"}</strong></div>
    <div class="metric-row"><span>Max drawdown</span><strong class="${metrics.maxDrawdown?.value < 0 ? "negative" : ""}">${metrics.maxDrawdown ? `${pct(metrics.maxDrawdown.value)} (${metrics.maxDrawdown.peakDate} to ${metrics.maxDrawdown.troughDate})` : "-"}</strong></div>
    <div class="metric-row"><span>Sharpe / Sortino</span><strong>${metrics.sharpe === null ? "-" : number(metrics.sharpe, 2)} / ${metrics.sortino === null ? "-" : number(metrics.sortino, 2)}</strong></div>
    <div class="metric-row"><span>Beta / correlation vs S&P 500</span><strong>${metrics.beta === null ? "-" : number(metrics.beta, 2)} / ${metrics.correlation === null ? "-" : number(metrics.correlation, 2)}</strong></div>
    <div class="metric-row"><span>Largest position</span><strong>${topRisk}</strong></div>
    <div class="metric-row"><span>CAD-listed exposure</span><strong>${pct(safeDiv(cadListed, summary.totalCad))}</strong></div>
    <div class="metric-row"><span>${portfolioViewMode === "stocks" ? "Excluded cash / funds" : "Cash-like sleeve"}</span><strong>${pct(safeDiv(cashLike, summary.totalCad))}</strong></div>
    <div class="metric-row"><span>Realized P/L</span><strong class="${breakdown.realized >= 0 ? "positive" : "negative"}">${money(breakdown.realized)}</strong></div>
    <div class="metric-row"><span>Residual cash</span><strong>${money(balances.CAD, "CAD")} CAD + ${money(balances.USD, "USD")} USD</strong></div>
    <div class="metric-row"><span>Above cost / below cost</span><strong>${winners.length} / ${negatives.length}</strong></div>
    <div class="metric-row"><span>Largest open drawdown</span><strong class="negative">${worst ? `${worst.display} ${money(worst.unrealizedCad)}` : "-"}</strong></div>
  `;
}

function renderHeatmap() {
  document.querySelector("#heatmap").innerHTML = [...activeHoldings()].sort((a, b) => b.returnPct - a.returnPct).map(row => {
    const intensity = Math.min(Math.abs(row.returnPct), 0.9);
    const color = row.returnPct >= 0 ? `rgba(16,185,129,${0.45 + intensity * 0.6})` : `rgba(239,68,68,${0.45 + intensity * 0.6})`;
    return `<div class="heat-tile" style="background:${color}"><span>${escapeHtml(row.display)}</span><small>${pct(row.returnPct)}</small></div>`;
  }).join("");
}

function renderInsights() {
  const total = activeTotals().totalCad;
  const concentrationNode = document.querySelector("#concentrationList");
  if (!concentrationNode) return;
  concentrationNode.innerHTML = activeHoldings().slice(0, 5).map((row, index) => `
    <div class="rank-item">
      <strong>${index + 1}</strong>
      <span>${escapeHtml(row.display)} - ${escapeHtml(row.name)}</span>
      <strong>${pct(safeDiv(row.marketCad, total))}</strong>
    </div>
  `).join("");
}

function renderStatementAnalytics() {
  if (!statementData) return;
  document.querySelector("#statementCoverage").textContent = `${statementData.coverage.start} to ${statementData.coverage.end}. Source: ${loadedActivityFilename || "activities export"}.`;
  document.querySelector("#statementStatus").textContent = `${statementData.transactions.length} rows - ${statementData.source}`;
  document.querySelector("#statementContributions").textContent = money(statementData.totals.contributions);
  document.querySelector("#statementNetContributions").textContent = money(statementData.totals.netContributions);
  document.querySelector("#statementBuys").textContent = money(statementData.totals.buys);
  document.querySelector("#statementSells").textContent = money(statementData.totals.sells);
  const volumeNode = document.querySelector("#statementVolume");
  if (volumeNode) volumeNode.textContent = money(statementData.totals.tradingVolume ?? (statementData.totals.buys + statementData.totals.sells));
  document.querySelector("#statementIncome").textContent = `${money(statementData.totals.dividends)} income / ${money(statementData.totals.stockLendingIncome)} lending / ${money(statementData.totals.feesTaxes)} fees-tax`;
  document.querySelector("#statementLending").textContent = money(statementData.totals.stockLendingIncome);
  drawActivityChart(document.querySelector("#activityChart"));
  document.querySelector("#topTradedList").innerHTML = statementData.topTraded.slice(0, 8).map(item => {
    const net = item.buys - item.sells;
    const volume = item.buys + item.sells;
    const netLabel = net >= 0 ? `net buy ${money(net)}` : `net sell ${money(Math.abs(net))}`;
    return `
      <div class="rank-item">
        <strong>${escapeHtml(item.symbol)}</strong>
        <span>${number(item.transactions, 0)} tx / buys ${money(item.buys)} / sells ${money(item.sells)} / ${netLabel}</span>
        <strong title="Gross trading volume">${money(volume)}</strong>
      </div>
    `;
  }).join("");

  document.querySelector("#incomeLeaders").innerHTML = statementData.topIncome.slice(0, 8).map(item => `
    <div class="rank-item">
      <strong>${escapeHtml(item.symbol)}</strong>
      <span>${number(item.transactions, 0)} income rows</span>
      <strong class="positive">${money(item.dividends)}</strong>
    </div>
  `).join("");
  document.querySelector("#recentTransactions").innerHTML = statementData.recent.map(item => `
    <div class="transaction-item">
      <strong>${escapeHtml(item.date)}</strong>
      <strong>${escapeHtml(item.transaction)}</strong>
      <span title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      <strong class="${item.amount >= 0 ? "positive" : "negative"}">${money(item.amount, item.currency)}</strong>
    </div>
  `).join("");
}

function renderIncomeDashboard() {
  const summary = activeTotals();
  const trailing = portfolioViewMode === "stocks" ? activeIncomeTotal() : trailingIncome(12);
  const monthly = monthlyIncomeRows();
  const recentMonths = monthly.slice(-6);
  const forward = mean(recentMonths.map(row => row.total)) * 12;
  const yieldCurrent = safeDiv(trailing, summary.totalCad);
  const yieldCost = safeDiv(trailing, summary.costCad);
  const node = document.querySelector("#incomeDashboard");
  if (node) {
    node.innerHTML = `
      <div class="metric-row"><span>Trailing 12M income</span><strong class="positive">${money(trailing)}</strong></div>
      <div class="metric-row"><span>Forward run-rate</span><strong>${money(forward)}</strong></div>
      <div class="metric-row"><span>Yield on current value</span><strong>${pct(yieldCurrent)}</strong></div>
      <div class="metric-row"><span>Yield on cost</span><strong>${pct(yieldCost)}</strong></div>
      <div class="metric-row"><span>Best income month</span><strong>${monthly.length ? `${monthly.reduce((best, row) => row.total > best.total ? row : best, monthly[0]).month} ${money(monthly.reduce((best, row) => row.total > best.total ? row : best, monthly[0]).total)}` : "-"}</strong></div>
    `;
  }
  drawIncomeChart(document.querySelector("#incomeChart"));
}




const realizedStockModeExclusions = new Set([
  "CASH", "CASH.TO",
  "VCN", "VCN.TO",
  "VFV", "VFV.TO",
  "XQQ", "XQQ.TO",
]);

function isRealizedStockModeSymbol(symbol) {
  const raw = String(symbol || "").trim();
  const canonical = canonicalSymbol(raw);
  const display = displaySymbol(canonical).toUpperCase();

  if (!raw || raw === "Cash" || canonical === "Cash") return false;
  if (realizedStockModeExclusions.has(raw.toUpperCase())) return false;
  if (realizedStockModeExclusions.has(canonical.toUpperCase())) return false;
  if (realizedStockModeExclusions.has(display)) return false;

  // Exclude option-looking symbols like AAPL 260102C00237500
  if (/\b\d{6}[CP]\d+\b/i.test(raw)) return false;
  if (/\b\d{6}[CP]\d+\b/i.test(display)) return false;

  const meta = metadataFor(canonical);
  const assetClass = String(meta.assetClass || "").toLowerCase();
  const bucket = targetBucketFor({ symbol: canonical });

  if (bucket === "Cash/T-Bill" || bucket === "Core ETF") return false;
  if (assetClass.includes("etf") || assetClass.includes("fund") || assetClass.includes("trust")) return false;

  // If not explicitly excluded, treat normal sold-only tickers as stocks.
  return true;
}

function activeRealizedBreakdown() {
  const breakdown = returnBreakdown();

  // Total portfolio mode = no filter. Full realized gains/trade journal.
  if (portfolioViewMode !== "stocks") return breakdown;

  // Individual stock mode = exclude ETFs, trusts, funds, options, and cash-like holdings.
  const realizedRows = breakdown.realizedRows.filter(row => isRealizedStockModeSymbol(row.symbol));
  const realizedTrades = breakdown.realizedTrades.filter(row => isRealizedStockModeSymbol(row.symbol));
  const realizedTotal = realizedRows.reduce((sum, row) => sum + row.amount, 0);

  return {
    ...breakdown,
    realized: realizedTotal,
    realizedRows,
    realizedTrades,
    total: realizedTotal + activeTotals().returnCad + activeIncomeTotal() + (breakdown.fees || 0)
  };
}


function isDividendFundedBuy(tx) {
  if (!tx || tx.transaction !== "TRADE_BUY") return false;
  if (!tx.symbol || tx.symbol === "Cash") return false;

  const buyCad = Math.abs(amountCad(tx.amount, tx.currency));
  if (!buyCad) return false;

  const txDate = new Date(`${tx.date}T00:00:00`);
  const txSymbol = canonicalSymbol(tx.symbol);

  return activities.some(other => {
    if (!["DIVIDEND", "INTEREST", "STOCK_LENDING_INCOME"].includes(other.transaction)) return false;
    if (canonicalSymbol(other.symbol) !== txSymbol) return false;

    const incomeCad = Math.abs(amountCad(other.amount, other.currency));
    if (!incomeCad) return false;

    const otherDate = new Date(`${other.date}T00:00:00`);
    const days = Math.abs((txDate - otherDate) / 86400000);

    if (days > 3) return false;

    // Case 1: exact DRIP / auto-buy, e.g. BDT +7.66 then -7.66.
    const nearExact = Math.abs(buyCad - incomeCad) <= Math.max(1, incomeCad * 0.03);

    // Case 2: partial reinvestment, e.g. an income row followed by a smaller reinvestment.
    const fundedByIncome = buyCad <= incomeCad + Math.max(1, incomeCad * 0.03);

    return nearExact || fundedByIncome;
  });
}
function isRealStockBuy(tx) {
  if (!tx || tx.transaction !== "TRADE_BUY") return false;
  if (isDividendFundedBuy(tx)) return false;
  return isRealizedStockModeSymbol(tx.symbol);
}

function stockBuyingStats() {
  const buys = activities
    .filter(isRealStockBuy)
    .sort((a, b) => a.date.localeCompare(b.date));

  const byYear = new Map();

  buys.forEach(tx => {
    const year = tx.date.slice(0, 4);
    const row = byYear.get(year) || {
      year,
      count: 0,
      symbols: new Set(),
      cad: 0
    };

    row.count += 1;
    row.symbols.add(displaySymbol(tx.symbol));
    row.cad += Math.abs(amountCad(tx.amount, tx.currency));

    byYear.set(year, row);
  });

  const years = [...byYear.values()]
    .map(row => ({
      year: row.year,
      count: row.count,
      symbols: [...row.symbols].sort(),
      symbolCount: row.symbols.size,
      cad: row.cad
    }))
    .sort((a, b) => b.year.localeCompare(a.year));

  const thisYear = String(new Date(`${latestDate()}T00:00:00`).getFullYear());
  const currentYear = years.find(row => row.year === thisYear) || {
    year: thisYear,
    count: 0,
    symbols: [],
    symbolCount: 0,
    cad: 0
  };

  const lastBuy = buys.at(-1) || null;
  const daysSinceLastBuy = lastBuy ? Math.max(0, Math.round(daysBetween(lastBuy.date, latestDate()))) : null;

  return {
    buys,
    totalBuys: buys.length,
    totalSymbols: new Set(buys.map(tx => displaySymbol(tx.symbol))).size,
    totalCad: buys.reduce((sum, tx) => sum + Math.abs(amountCad(tx.amount, tx.currency)), 0),
    years,
    currentYear,
    lastBuy,
    daysSinceLastBuy
  };
}

function renderStockBuyingActivityMetrics() {
  const node = document.querySelector("#stockBuyingActivity");
  if (!node) return;

  const stats = stockBuyingStats();
  const modeText = "Real stock buys only; dividend reinvestment / auto-buy rows excluded";

  node.innerHTML = `
    <div class="metric-row"><span>Mode</span><strong>${escapeHtml(modeText)}</strong></div>
    <div class="metric-row"><span>Stocks bought this year</span><strong>${number(stats.currentYear.symbolCount, 0)} symbols / ${number(stats.currentYear.count, 0)} buys</strong></div>
    <div class="metric-row"><span>Total stock buys</span><strong>${number(stats.totalSymbols, 0)} symbols / ${number(stats.totalBuys, 0)} buys</strong></div>
    <div class="metric-row"><span>Total real stock-buy dollars</span><strong>${money(stats.totalCad)}</strong></div>
    <div class="metric-row"><span>Days since last stock buy</span><strong>${stats.lastBuy ? `${number(stats.daysSinceLastBuy, 0)} days` : "-"}</strong></div>
    <div class="metric-row"><span>Last stock bought</span><strong>${stats.lastBuy ? `${displaySymbol(stats.lastBuy.symbol)} on ${stats.lastBuy.date}` : "-"}</strong></div>
    <div class="metric-row"><span>Stocks bought by year</span><strong>${stats.years.length ? stats.years.map(row => `${row.year}: ${row.symbolCount} symbols / ${row.count} buys`).join(" · ") : "-"}</strong></div>
  `;
}

function renderRealizedGains() {
  const breakdown = activeRealizedBreakdown();
  const realizedRows = breakdown.realizedRows || [];
  const realizedTradeRows = breakdown.realizedTrades || [];
  const realizedReturnFor = row => safeDiv(row.amount, row.costBasis);
  const annualizedReturnFor = row => {
    const realizedReturn = realizedReturnFor(row);
    const days = row.averageHoldingDays || row.holdingDays || 0;
    if (!Number.isFinite(realizedReturn) || realizedReturn <= -1 || days <= 0) return null;
    return Math.pow(1 + realizedReturn, 365 / days) - 1;
  };
  const signedPct = value => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${pct(value)}` : "-";
  const body = document.querySelector("#realizedBody");
  const summaryNode = document.querySelector("#realizedSummary");
  const holdVsSoldNode = document.querySelector("#holdVsSoldBody");
  const holdVsSoldSummaryNode = document.querySelector("#holdVsSoldSummary");
  const holdVsSoldRows = realizedRows
    .map(row => {
      const price = latestPrice(row.symbol);
      if (!price || !row.quantity) return null;
      const holdValue = amountCad(row.quantity * price.close, price.currency, price.date);
      const sellAdvantage = row.proceeds - holdValue;
      return {
        ...row,
        holdValue,
        sellAdvantage,
        latestPriceDate: price.date
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.sellAdvantage - b.sellAdvantage);

  if (summaryNode) {
    const totalPnl = realizedRows.reduce((sum, row) => sum + row.amount, 0);
    const totalCostBasis = realizedRows.reduce((sum, row) => sum + row.costBasis, 0);
    const avgReturn = safeDiv(
      realizedRows.reduce((sum, row) => sum + realizedReturnFor(row) * row.costBasis, 0),
      totalCostBasis
    );
    const bestReturn = realizedRows.length
      ? [...realizedRows].sort((a, b) => realizedReturnFor(b) - realizedReturnFor(a))[0]
      : null;
    const worstReturn = realizedRows.length
      ? [...realizedRows].sort((a, b) => realizedReturnFor(a) - realizedReturnFor(b))[0]
      : null;
    const avgHoldingDays = safeDiv(
      realizedRows.reduce((sum, row) => sum + (row.averageHoldingDays || 0) * row.quantity, 0),
      realizedRows.reduce((sum, row) => sum + row.quantity, 0)
    );
    const winRate = safeDiv(realizedTradeRows.filter(row => row.amount > 0).length, realizedTradeRows.length);

    summaryNode.innerHTML = `
      <article><span>Total realized P/L</span><strong class="${totalPnl >= 0 ? "positive" : "negative"}">${money(totalPnl)}</strong><small>${number(realizedRows.length, 0)} closed symbols</small></article>
      <article><span>Avg realized return</span><strong class="${avgReturn >= 0 ? "positive" : "negative"}">${signedPct(avgReturn)}</strong><small>Weighted by cost basis</small></article>
      <article><span>Best realized return</span><strong class="${bestReturn && realizedReturnFor(bestReturn) >= 0 ? "positive" : "negative"}">${bestReturn ? `${bestReturn.symbol} ${signedPct(realizedReturnFor(bestReturn))}` : "-"}</strong><small>${bestReturn ? money(bestReturn.amount) : "No closed gains"}</small></article>
      <article><span>Worst realized return</span><strong class="${worstReturn && realizedReturnFor(worstReturn) >= 0 ? "positive" : "negative"}">${worstReturn ? `${worstReturn.symbol} ${signedPct(realizedReturnFor(worstReturn))}` : "-"}</strong><small>${worstReturn ? money(worstReturn.amount) : "No closed losses"}</small></article>
      <article><span>Realized win rate</span><strong>${pct(winRate)}</strong><small>${number(realizedTradeRows.length, 0)} closed trades</small></article>
      <article><span>Avg holding period</span><strong>${number(avgHoldingDays, 0)} days</strong><small>Weighted by shares sold</small></article>
    `;
  }

  if (holdVsSoldSummaryNode) {
    const bestSellTiming = holdVsSoldRows.length
      ? [...holdVsSoldRows].sort((a, b) => b.sellAdvantage - a.sellAdvantage)[0]
      : null;
    const mostLeftUpside = holdVsSoldRows[0] || null;
    const totalSellAdvantage = holdVsSoldRows.reduce((sum, row) => sum + row.sellAdvantage, 0);

    holdVsSoldSummaryNode.innerHTML = `
      <div class="metric-row"><span>Net sell advantage</span><strong class="${totalSellAdvantage >= 0 ? "positive" : "negative"}">${money(totalSellAdvantage)}</strong></div>
      <div class="metric-row"><span>Best sell timing</span><strong class="${bestSellTiming && bestSellTiming.sellAdvantage >= 0 ? "positive" : "negative"}">${bestSellTiming ? `${bestSellTiming.symbol} ${money(bestSellTiming.sellAdvantage)}` : "-"}</strong></div>
      <div class="metric-row"><span>Most upside left</span><strong class="${mostLeftUpside && mostLeftUpside.sellAdvantage >= 0 ? "positive" : "negative"}">${mostLeftUpside ? `${mostLeftUpside.symbol} ${money(mostLeftUpside.sellAdvantage)}` : "-"}</strong></div>
    `;
  }

  if (holdVsSoldNode) {
    holdVsSoldNode.innerHTML = holdVsSoldRows.slice(0, 10).map(row => `
      <tr>
        <td>${escapeHtml(row.symbol)}</td>
        <td>${money(row.proceeds)}</td>
        <td>${money(row.holdValue)}</td>
        <td class="${row.sellAdvantage >= 0 ? "positive" : "negative"}">${money(row.sellAdvantage)}</td>
      </tr>
    `).join("") || `<tr><td colspan="4">Need latest prices for closed symbols.</td></tr>`;
  }

  if (body) {
    const emptyText = portfolioViewMode === "stocks"
      ? "No realized individual-stock sales yet."
      : "No realized sales yet.";

    body.innerHTML = realizedRows.slice(0, 12).map(row => {
      const realizedReturn = realizedReturnFor(row);
      const annualizedReturn = annualizedReturnFor(row);
      const returnClass = realizedReturn >= 0 ? "positive" : "negative";
      const annualizedClass = annualizedReturn === null ? "" : annualizedReturn >= 0 ? "positive" : "negative";

      return `
        <tr>
          <td>${escapeHtml(row.symbol)}</td>
          <td>${number(row.quantity, 4)}</td>
          <td>${money(row.proceeds)}</td>
          <td>${money(row.costBasis)}</td>
          <td class="${row.amount >= 0 ? "positive" : "negative"}">${money(row.amount)}</td>
          <td class="${returnClass}">${signedPct(realizedReturn)}</td>
          <td class="${annualizedClass}">${annualizedReturn === null ? "-" : signedPct(annualizedReturn)}</td>
          <td>${number(row.averageHoldingDays, 0)} days</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="8">${emptyText}</td></tr>`;
  }

  const tradeNode = document.querySelector("#tradeJournal");
  if (tradeNode) {
    const trades = breakdown.realizedTrades;
    const best = [...trades].sort((a, b) => b.amount - a.amount)[0];
    const worst = [...trades].sort((a, b) => a.amount - b.amount)[0];

    const bySymbol = new Map();

    activities
      .filter(tx => ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction))
      .filter(tx => tx.transaction !== "TRADE_BUY" || !isDividendFundedBuy(tx))
      .filter(tx => portfolioViewMode !== "stocks" || isRealizedStockModeSymbol(tx.symbol))
      .forEach(tx => {
        const item = bySymbol.get(tx.symbol) || {
          symbol: displaySymbol(tx.symbol),
          count: 0,
          buyValue: 0,
          buyQty: 0,
          sellValue: 0,
          sellQty: 0
        };

        item.count += 1;

        if (tx.transaction === "TRADE_BUY") {
          item.buyValue += Math.abs(amountCad(tx.amount, tx.currency));
          item.buyQty += Math.abs(tx.quantity);
        } else {
          item.sellValue += Math.abs(amountCad(tx.amount, tx.currency));
          item.sellQty += Math.abs(tx.quantity);
        }

        bySymbol.set(tx.symbol, item);
      });

    const most = [...bySymbol.values()].sort((a, b) => b.count - a.count)[0];
    const winRate = safeDiv(trades.filter(row => row.amount > 0).length, trades.length);

    tradeNode.innerHTML = `
      <div class="metric-row"><span>Mode</span><strong>${portfolioViewMode === "stocks" ? "Individual stocks only" : "Total portfolio"}</strong></div>
      <div class="metric-row"><span>Best realized trade</span><strong class="positive">${best ? `${best.symbol} ${money(best.amount)}` : "-"}</strong></div>
      <div class="metric-row"><span>Worst closed trade</span><strong class="negative">${worst ? `${worst.symbol} ${money(worst.amount)}` : "-"}</strong></div>
      <div class="metric-row"><span>Most actively traded symbol</span><strong>${most ? `${most.symbol} (${most.count} real trades)` : "-"}</strong></div>
      <div class="metric-row"><span>Dividend reinvestment buys excluded</span><strong>${number(activities.filter(isDividendFundedBuy).length, 0)}</strong></div>
      <div class="metric-row"><span>Average buy / sell</span><strong>${most ? `${money(safeDiv(most.buyValue, most.buyQty))} / ${money(safeDiv(most.sellValue, most.sellQty))}` : "-"}</strong></div>
      <div class="metric-row"><span>Realized win rate</span><strong>${pct(winRate)}</strong></div>
      <div class="metric-row"><span>Manual notes</span><strong>${manualNotes.length}</strong></div>
    `;
  }
}

function renderQualityAndAlerts() {
  const scoreNode = document.querySelector("#qualityScores");
  if (scoreNode) {
    scoreNode.innerHTML = qualityScores().map(row => `
      <div class="score-row">
        <div>
          <strong>${escapeHtml(row.label)}</strong>
          <small>${escapeHtml(row.detail)}</small>
        </div>
        <span>${number(row.score, 0)}</span>
      </div>
    `).join("");
  }
  const alertNode = document.querySelector("#alertsList");
  if (alertNode) {
    const rows = alertRows();
    alertNode.innerHTML = rows.map(row => `
      <div class="alert-item ${row.severity}">${escapeHtml(row.label)}</div>
    `).join("") || `<p class="muted">No alerts at current thresholds.</p>`;
  }
}

function renderRebalancing() {
  const body = document.querySelector("#rebalanceBody");
  if (!body) return;
  body.innerHTML = rebalancingRows().map(row => `
    <tr>
      <td>${escapeHtml(row.bucket)}</td>
      <td>${pct(row.actualWeight)}</td>
      <td>${pct(row.targetWeight)}</td>
      <td class="${row.differenceWeight >= 0 ? "positive" : "negative"}">${pct(row.differenceWeight)}</td>
      <td class="${row.differenceValue >= 0 ? "positive" : "negative"}">${row.differenceValue >= 0 ? "Buy" : "Sell"} ${money(Math.abs(row.differenceValue))}</td>
    </tr>
  `).join("");
}

function renderScenarios() {
  const node = document.querySelector("#scenarioList");
  if (!node) return;
  node.innerHTML = scenarioRows().map(row => `
    <div class="metric-row">
      <span>${escapeHtml(row.label)}<small>${escapeHtml(row.detail)}</small></span>
      <strong class="${row.value >= 0 ? "positive" : "negative"}">${row.value === 0 ? "Reallocation" : money(row.value)}</strong>
    </div>
  `).join("");
}

function renderDataCompleteness() {
  const equityRows = dailyAccountSeries().length;
  const missingPrices = holdings.filter(row => !latestPrice(row.symbol)).map(row => row.display);
  const snapshotPriceFallback = holdings.filter(row => row.usedSnapshotPriceFallback).map(row => row.display);
  const quantityMismatches = holdings.filter(row => row.snapshotQuantity !== null && Math.abs(row.quantityReconciliationDiff) > 0.0001).map(row => row.display);
  const bookMismatches = holdings.filter(row => row.snapshotBookCad !== null && Math.abs(row.bookReconciliationDiff) > 0.01).map(row => row.display);
  const reconstructedSymbols = new Set(holdings.map(row => canonicalSymbol(row.symbol)));
  const snapshotOnlySymbols = [...holdingsSnapshotMap.keys()].filter(symbol => !reconstructedSymbols.has(canonicalSymbol(symbol))).map(displaySymbol);
  const historical = missingHistoricalPriceSymbols();
  const missingHistorical = historical.missing || [];
  const ignoredHistorical = historical.ignored || [];
  document.querySelector("#snapshotCount").textContent = number(holdings.length, 0);
  document.querySelector("#transactionCount").textContent = number(activities.length, 0);
  document.querySelector("#priceRowCount").textContent = number(priceRows.filter(row => !benchmarkSymbols.includes(row.symbol)).length, 0);
  document.querySelector("#benchmarkRowCount").textContent = number(priceRows.filter(row => benchmarkSymbols.includes(row.symbol)).length, 0);
  // FX row count and latest FX
  const historicalFxRows = priceRows.filter(row => ["CAD=X", "USDCAD", "USD/CAD"].includes(row.symbol));
  document.querySelector("#fxRowCount").textContent = historicalFxRows.length ? `${number(historicalFxRows.length, 0)} rows / latest ${fx().toFixed(4)}` : "Manual input";
  document.querySelector("#dataStatus").textContent = activities.length && priceRows.length && !missingPrices.length && !missingHistorical.length && !quantityMismatches.length && !bookMismatches.length && !snapshotOnlySymbols.length ? "Good" : "Partial";
  const statusNode = document.querySelector("#statusPanel");
  if (statusNode) {
    statusNode.innerHTML = `
      <div class="metric-row"><span>Activities export loaded</span><strong>${activities.length ? "Yes" : "No"}</strong></div>
      <div class="metric-row"><span>Prices loaded</span><strong>${priceRows.length ? "Yes" : "No"}</strong></div>
      <div class="metric-row"><span>Latest price date</span><strong>${latestDate()}</strong></div>
      <div class="metric-row"><span>Missing current prices</span><strong>${missingPrices.length ? missingPrices.join(", ") : "None"}</strong></div>
      <div class="metric-row"><span>Snapshot price fallback</span><strong>${snapshotPriceFallback.length ? snapshotPriceFallback.join(", ") : "None"}</strong></div>
      <div class="metric-row"><span>Missing historical prices</span><strong>${missingHistorical.length ? missingHistorical.slice(0, 10).join(", ") : "None"}</strong></div>
      <div class="metric-row"><span>Ignored unpriced instruments</span><strong>${ignoredHistorical.length ? ignoredHistorical.slice(0, 10).join(", ") : "None"}</strong></div>
      <div class="metric-row"><span>Quantity reconciliation</span><strong>${quantityMismatches.length ? quantityMismatches.join(", ") : "Matched"}</strong></div>
      <div class="metric-row"><span>Book-value reconciliation</span><strong>${bookMismatches.length ? bookMismatches.join(", ") : "Matched"}</strong></div>
      <div class="metric-row"><span>Snapshot-only symbols</span><strong>${snapshotOnlySymbols.length ? snapshotOnlySymbols.join(", ") : "None"}</strong></div>
      <div class="metric-row"><span>Daily equity rows</span><strong>${number(equityRows, 0)}</strong></div>
      <div class="metric-row"><span>Metadata / target rows</span><strong>${symbolMetadata.size || Object.keys(fallbackMetadata).length} / ${targets.length}</strong></div>
    `;
  }
}


function portfolioModeLabel() {
  return portfolioViewMode === "stocks" ? "Individual stocks only" : "Total portfolio";
}

function applyPortfolioViewMode() {
  const isStocks = portfolioViewMode === "stocks";

  document.body.classList.toggle("stock-mode", isStocks);
  document.body.classList.toggle("total-mode", !isStocks);

  document.querySelectorAll(".view-toggle").forEach(button => {
    button.classList.toggle("active", button.dataset.view === portfolioViewMode);
  });

  const notice = document.querySelector("#modeNotice");
  if (notice) {
    notice.innerHTML = isStocks
      ? `<strong>Stock-picking mode</strong><span>Excludes ETFs, trusts, funds, cash-like holdings, and cash. Performance is recalculated as a separate stock-picking portfolio.</span>`
      : `<strong>Total portfolio mode</strong><span>Includes ETFs, stocks, cash-like holdings, and imported activity history.</span>`;
  }

  const totalValueLabel = document.querySelector("#totalValue")?.closest("article")?.querySelector("span");
  const totalCostLabel = document.querySelector("#totalCost")?.closest("article")?.querySelector("span");
  const totalReturnLabel = document.querySelector("#totalReturn")?.closest("article")?.querySelector("span");
  const totalDividendsLabel = document.querySelector("#totalDividends")?.closest("article")?.querySelector("span");
  const holdingsLabel = document.querySelector("#holdingCount")?.closest("article")?.querySelector("span");
  const topHoldingLabel = document.querySelector("#topHolding")?.closest("article")?.querySelector("span");

  if (totalValueLabel) totalValueLabel.textContent = isStocks ? "Stock picks value" : "Total value";
  if (totalCostLabel) totalCostLabel.textContent = isStocks ? "Stock picks cost" : "Total cost";
  if (totalReturnLabel) totalReturnLabel.textContent = isStocks ? "Stock picks P/L" : "Unrealized P/L";
  if (totalDividendsLabel) totalDividendsLabel.textContent = isStocks ? "Stock dividends" : "Total Dividends";
  if (holdingsLabel) holdingsLabel.textContent = isStocks ? "Individual stocks" : "Holdings";
  if (topHoldingLabel) topHoldingLabel.textContent = isStocks ? "Largest stock pick" : "Largest stock holding";

  const benchmarkTitle = document.querySelector("#benchmarkTitle");
  if (benchmarkTitle && isStocks) {
    const periodLabel = selectedPeriod === "MAX" ? "All-time" : selectedPeriod;
    benchmarkTitle.textContent = `${periodLabel} Stock Picks vs S&P 500`;
  }
}


function stockOnlyRealizedPnl() {
  const stockSymbols = new Set(
    holdings
      .filter(row => isIndividualStock(row))
      .map(row => canonicalSymbol(row.symbol))
  );

  const books = new Map();
  const realized = [];
  const ensureBook = symbol => {
    const key = canonicalSymbol(symbol);
    if (!books.has(key)) books.set(key, { quantity: 0, cost: 0 });
    return books.get(key);
  };

  activities
    .filter(tx => stockSymbols.has(canonicalSymbol(tx.symbol)))
    .filter(tx => ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction))
    .forEach(tx => {
      const symbol = canonicalSymbol(tx.symbol);
      const book = ensureBook(symbol);
      const qty = Math.abs(tx.quantity);
      if (!qty) return;

      if (tx.transaction === "TRADE_BUY") {
        book.quantity += qty;
        book.cost += Math.abs(amountCad(tx.amount, tx.currency, tx.date));
        return;
      }

      const matched = Math.min(qty, Math.max(book.quantity, 0));
      const avgCost = book.quantity ? book.cost / book.quantity : 0;
      const costBasis = avgCost * matched;
      const proceeds = Math.abs(amountCad(tx.amount, tx.currency, tx.date));
      const pnl = proceeds - costBasis;

      if (matched > 0) {
        book.quantity -= matched;
        book.cost -= costBasis;
      }

      realized.push({
        date: tx.date,
        symbol,
        display: displaySymbol(symbol),
        proceeds,
        costBasis,
        pnl,
        quantity: matched
      });
    });

  const bySymbol = new Map();
  realized.forEach(row => {
    const item = bySymbol.get(row.symbol) || {
      symbol: row.symbol,
      display: row.display,
      pnl: 0,
      proceeds: 0,
      costBasis: 0,
      quantity: 0,
      trades: 0
    };
    item.pnl += row.pnl;
    item.proceeds += row.proceeds;
    item.costBasis += row.costBasis;
    item.quantity += row.quantity;
    item.trades += 1;
    bySymbol.set(row.symbol, item);
  });

  const rows = [...bySymbol.values()].sort((a, b) => b.pnl - a.pnl);
  return {
    total: rows.reduce((sum, row) => sum + row.pnl, 0),
    rows,
    trades: realized.sort((a, b) => b.date.localeCompare(a.date))
  };
}

function stockPickingAttributionRows() {
  const openRows = activeHoldings().map(row => ({
    symbol: row.symbol,
    display: row.display,
    name: row.name,
    unrealized: row.unrealizedCad,
    realized: 0,
    total: row.unrealizedCad,
    marketCad: row.marketCad,
    returnPct: row.returnPct,
    isOpen: true
  }));

  const realized = activeRealizedBreakdown();
  const map = new Map(openRows.map(row => [canonicalSymbol(row.symbol), row]));

  (realized.realizedRows || []).forEach(row => {
    const key = canonicalSymbol(row.symbol);
    const realizedPnl = row.amount ?? row.pnl ?? 0;
    const existing = map.get(key);
    if (existing) {
      existing.realized += realizedPnl;
      existing.total += realizedPnl;
    } else {
      map.set(key, {
        symbol: row.symbol,
        display: displaySymbol(row.symbol),
        name: displaySymbol(row.symbol),
        unrealized: 0,
        realized: realizedPnl,
        total: realizedPnl,
        marketCad: 0,
        returnPct: null,
        isOpen: false
      });
    }
  });

  return [...map.values()].sort((a, b) => b.total - a.total);
}


function pickBenchmarkRows() {
  const config = selectedBenchmarkConfig();

  return activeHoldings()
    .map(row => {
      const held = holdingDaysHeld(row.symbol, latestDate());
      if (!held?.since) return null;

      const bench = selectedBenchmarkReturnBetween(held.since, latestDate());
      const stockReturn = row.nativeReturnPct !== null && row.nativeReturnPct !== undefined ? row.nativeReturnPct : row.returnPct;
      const alpha = bench === null || !Number.isFinite(bench) ? null : stockReturn - bench;

      return {
        symbol: row.display,
        name: row.name,
        since: held.since,
        days: held.days,
        stockReturn,
        benchmarkReturn: bench,
        alpha,
        pnl: row.unrealizedCad,
        benchmarkLabel: config.shortLabel
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.alpha ?? -999) - (a.alpha ?? -999));
}

function renderPickVsBenchmark() {
  const node = document.querySelector("#pickBenchmarkRows");
  if (!node) return;

  if (portfolioViewMode !== "stocks") {
    node.innerHTML = "";
    return;
  }

  const rows = pickBenchmarkRows();

  node.innerHTML = rows.map(row => {
    const alphaClass = row.alpha === null ? "" : row.alpha >= 0 ? "positive" : "negative";
    const pnlClass = row.pnl >= 0 ? "positive" : "negative";
    const width = Math.max(Math.min(Math.abs(row.alpha ?? 0) * 100, 100), 2);

    return `
      <div class="pick-benchmark-row">
        <div>
          <strong>${escapeHtml(row.symbol)}</strong>
          <small>${escapeHtml(row.name)} · since ${row.since} · ${number(row.days, 0)} days</small>
        </div>

        <div class="pick-benchmark-metrics">
          <span>
            <small>Stock</small>
            <strong class="${row.stockReturn >= 0 ? "positive" : "negative"}">${pct(row.stockReturn)}</strong>
          </span>
          <span>
            <small>${escapeHtml(row.benchmarkLabel)}</small>
            <strong class="${row.benchmarkReturn === null ? "" : row.benchmarkReturn >= 0 ? "positive" : "negative"}">${row.benchmarkReturn === null ? "-" : pct(row.benchmarkReturn)}</strong>
          </span>
          <span>
            <small>Alpha</small>
            <strong class="${alphaClass}">${row.alpha === null ? "-" : pct(row.alpha)}</strong>
          </span>
          <span>
            <small>P/L</small>
            <strong class="${pnlClass}">${money(row.pnl)}</strong>
          </span>
        </div>

        <div class="pick-alpha-bar">
          <span class="${alphaClass}" style="width:${width}%"></span>
        </div>
      </div>
    `;
  }).join("") || `<p class="muted">No stock-pick benchmark rows available.</p>`;
}

function renderStockPickingAnalysis() {
  const section = document.querySelector("#stockPickingAnalysis");
  if (!section) return;

  const isStocks = portfolioViewMode === "stocks";
  section.style.display = isStocks ? "" : "none";
  if (!isStocks) return;

  renderPickVsBenchmark();

  const rows = stockPickingAttributionRows();
  const openRows = activeHoldings();
  const realized = activeRealizedBreakdown();
  const summary = activeTotals();

  const openWinners = openRows.filter(row => row.unrealizedCad > 0);
  const openDrawdownPositions = openRows.filter(row => row.unrealizedCad < 0);
  const realizedTrades = (realized.realizedTrades || realized.trades || []).map(row => ({
    ...row,
    pnl: row.pnl ?? row.amount ?? 0
  }));
  const realizedWinningTrades = realizedTrades.filter(row => row.pnl > 0);
  const realizedLosingTrades = realizedTrades.filter(row => row.pnl < 0);

  const grossOpenGains = openRows.filter(row => row.unrealizedCad > 0).reduce((sum, row) => sum + row.unrealizedCad, 0);
  const grossOpenLosses = Math.abs(openRows.filter(row => row.unrealizedCad < 0).reduce((sum, row) => sum + row.unrealizedCad, 0));
  const grossRealizedGains = realizedTrades.filter(row => row.pnl > 0).reduce((sum, row) => sum + row.pnl, 0);
  const grossRealizedLosses = Math.abs(realizedTrades.filter(row => row.pnl < 0).reduce((sum, row) => sum + row.pnl, 0));

  const grossGains = grossOpenGains + grossRealizedGains;
  const grossLosses = grossOpenLosses + grossRealizedLosses;
  const netPnl = summary.returnCad + realized.realized;
  const winners = rows.filter(row => row.total > 0);
  const best = rows[0];
  const worst = [...rows].sort((a, b) => a.total - b.total)[0];
  const topWinnerShare = grossGains ? safeDiv(Math.max(best?.total || 0, 0), grossGains) : null;
  const topThreeShare = grossGains
    ? safeDiv(rows.filter(row => row.total > 0).slice(0, 3).reduce((sum, row) => Math.max(row.total, 0) + sum, 0), grossGains)
    : null;
  const profitFactor = grossLosses ? grossGains / grossLosses : null;
  const largestOpen = [...openRows].sort((a, b) => b.marketCad - a.marketCad)[0];

  const scorecard = document.querySelector("#stockPickingScorecard");
  if (scorecard) {
    scorecard.innerHTML = `
      <article><span>Stock-pick value</span><strong>${money(summary.totalCad)}</strong><small>${openRows.length} open individual stocks</small></article>
      <article><span>Open stock P/L</span><strong class="${summary.returnCad >= 0 ? "positive" : "negative"}">${money(summary.returnCad)}</strong><small>${pct(safeDiv(summary.returnCad, summary.costCad))} on open cost</small></article>
      <article><span>Realized stock P/L</span><strong class="${realized.realized >= 0 ? "positive" : "negative"}">${money(realized.realized)}</strong><small>Closed individual-stock trades</small></article>
      <article><span>Total stock P/L</span><strong class="${netPnl >= 0 ? "positive" : "negative"}">${money(netPnl)}</strong><small>Unrealized open P/L + realized stock P/L</small></article>
      <article><span>Open positions above cost</span><strong>${openWinners.length} / ${openRows.length}</strong><small>${pct(safeDiv(openWinners.length, openRows.length))} current mark-to-market only</small></article>
      <article><span>Profit factor</span><strong>${profitFactor === null ? "No losses" : number(profitFactor, 2)}</strong><small>Open + realized gross gains / drawdowns</small></article>
      <article><span>Best current/closed pick</span><strong class="positive">${best ? `${best.display} ${money(best.total)}` : "-"}</strong><small>${best?.isOpen ? "Open/unrealized" : "Closed/realized"}</small></article>
      <article><span>Largest current/closed drawdown</span><strong class="negative">${worst ? `${worst.display} ${money(worst.total)}` : "-"}</strong><small>${worst?.isOpen ? "Open/unrealized" : "Closed/realized"}</small></article>
      <article><span>Winner dependence</span><strong>${topWinnerShare === null ? "-" : pct(topWinnerShare)}</strong><small>Top winner share of gains</small></article>
      <article><span>Top 3 dependence</span><strong>${topThreeShare === null ? "-" : pct(topThreeShare)}</strong><small>Top 3 winners share of gains</small></article>
      <article><span>Largest open stock</span><strong>${largestOpen ? largestOpen.display : "-"}</strong><small>${largestOpen ? `${money(largestOpen.marketCad)} / ${pct(safeDiv(largestOpen.marketCad, summary.totalCad))}` : "-"}</small></article>
      <article><span>Open drawdown positions</span><strong>${openDrawdownPositions.length} / ${openRows.length}</strong><small>${grossOpenLosses ? `${money(grossOpenLosses)} unrealized drawdowns, not locked-in losses` : "No open paper losses"}</small></article>
      <article><span>Realized losing trades</span><strong>${realizedLosingTrades.length}</strong><small>${grossRealizedLosses ? `${money(grossRealizedLosses)} locked-in realized losses` : "No closed stock losses"}</small></article>
      <article><span>Realized win rate</span><strong>${realizedTrades.length ? pct(safeDiv(realizedWinningTrades.length, realizedTrades.length)) : "No closed stock sales"}</strong><small>${realizedTrades.length} closed individual-stock sales</small></article>
    `;
  }

  const attribution = document.querySelector("#stockPickingAttribution");
  if (attribution) {
    const maxAbs = Math.max(...rows.map(row => Math.abs(row.total)), 1);
    attribution.innerHTML = rows.map(row => {
      const width = Math.max(Math.abs(row.total) / maxAbs * 100, 2);
      const cls = row.total >= 0 ? "positive" : "negative";
      return `
        <div class="stock-attr-row">
          <div>
            <strong>${escapeHtml(row.display)}</strong>
            <small>${escapeHtml(row.name || row.display)} · ${row.isOpen ? "open" : "closed"}</small>
          </div>
          <div class="stock-attr-bar">
            <span class="${cls}" style="width:${width}%"></span>
          </div>
          <div class="stock-attr-values">
            <strong class="${cls}">${money(row.total)}</strong>
            <small>open ${money(row.unrealized)} / realized ${money(row.realized)}</small>
          </div>
        </div>
      `;
    }).join("");
  }
}


function findPointOnOrBefore(series, date) {
  if (!series?.length || !date) return null;
  let best = null;
  for (const point of series) {
    if (point.date <= date) best = point;
    else break;
  }
  return best;
}

function addMonthsIso(date, months) {
  const d = new Date(`${date}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function daysBetweenIso(start, end) {
  if (!start || !end) return null;
  return Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / 86400000);
}

function rollingReturnRows() {
  const fullSeries = activeTwrIndexSeries("MAX");
  if (fullSeries.length < 2) return [];

  const windows = [
    { label: "3M", months: -3 },
    { label: "6M", months: -6 },
    { label: "1Y", months: -12 }
  ];

  return windows.map(window => {
    const rolling = [];

    for (const endPoint of fullSeries) {
      const targetStart = addMonthsIso(endPoint.date, window.months);
      const startPoint = findPointOnOrBefore(fullSeries, targetStart);
      if (!startPoint || startPoint.date === endPoint.date) continue;

      const portfolioReturn = safeDiv(endPoint.value, startPoint.value) - 1;
      const benchmarkReturnValue = selectedBenchmarkReturnBetween(startPoint.date, endPoint.date);
      if (!Number.isFinite(portfolioReturn) || benchmarkReturnValue === null || !Number.isFinite(benchmarkReturnValue)) continue;

      rolling.push({
        start: startPoint.date,
        end: endPoint.date,
        portfolioReturn,
        benchmarkReturn: benchmarkReturnValue,
        alpha: portfolioReturn - benchmarkReturnValue
      });
    }

    const latest = rolling.at(-1) || null;
    const alphas = rolling.map(row => row.alpha).filter(Number.isFinite);

    return {
      label: window.label,
      latest,
      observations: rolling.length,
      winRate: rolling.length ? safeDiv(rolling.filter(row => row.alpha > 0).length, rolling.length) : null,
      bestAlpha: alphas.length ? Math.max(...alphas) : null,
      worstAlpha: alphas.length ? Math.min(...alphas) : null
    };
  });
}

function brinsonStyleAttributionRows() {
  const rows = activeHoldings();
  const totalValue = rows.reduce((sum, row) => sum + row.marketCad, 0);
  const benchmark = selectedBenchmarkReturn(selectedPeriod);
  if (!totalValue || benchmark === null || !Number.isFinite(benchmark)) return [];

  const sectors = new Map();
  rows.forEach(row => {
    const sector = metadataFor(row.symbol).sector || "Unclassified";
    const item = sectors.get(sector) || { sector, value: 0, weightedReturn: 0 };
    item.value += row.marketCad;
    item.weightedReturn += row.marketCad * (row.returnPct || 0);
    sectors.set(sector, item);
  });

  const sectorCount = Math.max(sectors.size, 1);
  const neutralWeight = 1 / sectorCount;

  return [...sectors.values()].map(row => {
    const weight = safeDiv(row.value, totalValue);
    const sectorReturn = safeDiv(row.weightedReturn, row.value);
    const allocationEffect = (weight - neutralWeight) * benchmark;
    const selectionEffect = neutralWeight * (sectorReturn - benchmark);
    const interactionEffect = (weight - neutralWeight) * (sectorReturn - benchmark);

    return {
      ...row,
      weight,
      sectorReturn,
      allocationEffect,
      selectionEffect,
      interactionEffect,
      totalEffect: allocationEffect + selectionEffect + interactionEffect
    };
  }).sort((a, b) => Math.abs(b.totalEffect) - Math.abs(a.totalEffect));
}

function currencyDecompositionRows() {
  return activeHoldings()
    .map(row => {
      const localReturn = Number.isFinite(row.nativeReturnPct) ? row.nativeReturnPct : row.returnPct;
      const cadReturn = row.returnPct;
      const fxEffect = Number.isFinite(localReturn) && Number.isFinite(cadReturn) ? cadReturn - localReturn : null;
      return {
        symbol: row.display,
        currency: row.nativeMarketCurrency || row.marketCurrency || row.currency || "CAD",
        localReturn,
        cadReturn,
        fxEffect,
        pnl: row.unrealizedCad || 0
      };
    })
    .sort((a, b) => Math.abs(b.fxEffect || 0) - Math.abs(a.fxEffect || 0));
}

function drawdownRecoveryRows() {
  const series = activeTwrIndexSeries("MAX");
  if (series.length < 2) return [];

  const rows = [];
  let peak = series[0];
  let trough = null;
  let inDrawdown = false;

  for (const point of series.slice(1)) {
    if (point.value >= peak.value) {
      if (inDrawdown && trough) {
        rows.push({
          peakDate: peak.date,
          troughDate: trough.date,
          recoveryDate: point.date,
          drawdown: safeDiv(trough.value - peak.value, peak.value),
          daysToRecover: daysBetweenIso(peak.date, point.date),
          recovered: true
        });
      }
      peak = point;
      trough = null;
      inDrawdown = false;
      continue;
    }

    inDrawdown = true;
    if (!trough || point.value < trough.value) trough = point;
  }

  if (inDrawdown && trough) {
    rows.push({
      peakDate: peak.date,
      troughDate: trough.date,
      recoveryDate: null,
      drawdown: safeDiv(trough.value - peak.value, peak.value),
      daysToRecover: daysBetweenIso(peak.date, latestDate()),
      recovered: false
    });
  }

  return rows
    .filter(row => row.drawdown < -0.005)
    .sort((a, b) => a.drawdown - b.drawdown)
    .slice(0, 8);
}

function renderAdvancedAttribution() {
  const rollingBody = document.querySelector("#rollingReturnsBody");
  if (rollingBody) {
    const rows = rollingReturnRows();
    rollingBody.innerHTML = rows.map(row => {
      const latest = row.latest;
      const alpha = latest ? latest.alpha : null;
      const alphaClass = alpha === null ? "" : alpha >= 0 ? "positive" : "negative";
      return `
        <tr>
          <td>${row.label}</td>
          <td class="${latest?.portfolioReturn >= 0 ? "positive" : "negative"}">${latest ? pct(latest.portfolioReturn) : "-"}</td>
          <td>${latest ? pct(latest.benchmarkReturn) : "-"}</td>
          <td class="${alphaClass}">${alpha === null ? "-" : pct(alpha)}</td>
          <td>${row.winRate === null ? "-" : pct(row.winRate)}</td>
          <td>${row.bestAlpha === null ? "-" : `${pct(row.bestAlpha)} / ${pct(row.worstAlpha)}`}</td>
        </tr>
      `;
    }).join("") || `<tr><td colspan="6">Needs more price history.</td></tr>`;
  }

  const brinsonBody = document.querySelector("#brinsonBody");
  if (brinsonBody) {
    const rows = brinsonStyleAttributionRows();
    brinsonBody.innerHTML = rows.map(row => `
      <tr>
        <td>${escapeHtml(row.sector)}</td>
        <td>${pct(row.weight)}</td>
        <td class="${row.sectorReturn >= 0 ? "positive" : "negative"}">${pct(row.sectorReturn)}</td>
        <td class="${row.allocationEffect >= 0 ? "positive" : "negative"}">${pct(row.allocationEffect)}</td>
        <td class="${row.selectionEffect >= 0 ? "positive" : "negative"}">${pct(row.selectionEffect)}</td>
        <td class="${row.interactionEffect >= 0 ? "positive" : "negative"}">${pct(row.interactionEffect)}</td>
      </tr>
    `).join("") || `<tr><td colspan="6">Needs holdings and benchmark data.</td></tr>`;
  }

  const currencyBody = document.querySelector("#currencyDecompositionBody");
  if (currencyBody) {
    const rows = currencyDecompositionRows();
    currencyBody.innerHTML = rows.map(row => `
      <tr>
        <td>${escapeHtml(row.symbol)}</td>
        <td>${escapeHtml(row.currency)}</td>
        <td class="${row.localReturn >= 0 ? "positive" : "negative"}">${pct(row.localReturn)}</td>
        <td class="${row.cadReturn >= 0 ? "positive" : "negative"}">${pct(row.cadReturn)}</td>
        <td class="${(row.fxEffect || 0) >= 0 ? "positive" : "negative"}">${row.fxEffect === null ? "-" : pct(row.fxEffect)}</td>
        <td class="${row.pnl >= 0 ? "positive" : "negative"}">${money(row.pnl)}</td>
      </tr>
    `).join("") || `<tr><td colspan="6">No holdings available.</td></tr>`;
  }

  const drawdownBody = document.querySelector("#drawdownRecoveryBody");
  if (drawdownBody) {
    const rows = drawdownRecoveryRows();
    drawdownBody.innerHTML = rows.map(row => `
      <tr>
        <td>${row.peakDate}</td>
        <td>${row.troughDate}</td>
        <td class="negative">${pct(row.drawdown)}</td>
        <td>${row.recovered ? row.recoveryDate : "Open"}</td>
        <td>${row.daysToRecover === null ? "-" : number(row.daysToRecover, 0)}</td>
      </tr>
    `).join("") || `<tr><td colspan="5">No material drawdowns detected.</td></tr>`;
  }
}


function updateModeVisualBadge() {
  const badge = document.querySelector("#modeVisualBadge");
  if (!badge) return;

  const strong = badge.querySelector("strong");
  const small = badge.querySelector("small");

  if (portfolioViewMode === "stocks") {
    if (strong) strong.textContent = "Individual Stocks Only Mode";
    if (small) small.textContent = "ETFs, trusts, funds, options, and cash excluded";
  } else {
    if (strong) strong.textContent = "Total Portfolio Mode";
    if (small) small.textContent = "All holdings included";
  }
}


function syncPortfolioViewClasses() {
  document.body.classList.toggle("view-stocks", portfolioViewMode === "stocks");
  document.body.classList.toggle("stock-mode", portfolioViewMode === "stocks");
  document.body.classList.toggle("view-total", portfolioViewMode !== "stocks");
  updateModeVisualBadge();
}


// ═══════════════════════════════════════════════════════════════════════
//  ADVANCED ANALYTICS — Correlation, Monte Carlo, Tax-Loss Harvesting,
//  What-If, Forward Dividends, Position Sizing, DCA, Rolling Chart
// ═══════════════════════════════════════════════════════════════════════

function holdingDailyReturns(symbol, period = selectedPeriod) {
  const end = latestDate();
  const start = periodStartDate(period, end);
  const rows = (priceBySymbol.get(canonicalSymbol(symbol)) || [])
    .filter(r => r.date >= start && r.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows.slice(1).map((r, i) => ({
    date: r.date,
    value: safeDiv(r.close - rows[i].close, rows[i].close)
  })).filter(r => Number.isFinite(r.value));
}

function correlationMatrix(period = selectedPeriod) {
  const rows = activeHoldings().filter(r => {
    const prices = priceBySymbol.get(canonicalSymbol(r.symbol)) || [];
    return prices.length >= 20;
  });
  const symbols = rows.map(r => r.symbol);
  const returns = new Map();
  symbols.forEach(s => returns.set(s, holdingDailyReturns(s, period)));
  const matrix = [];
  for (let i = 0; i < symbols.length; i++) {
    const row = [];
    for (let j = 0; j < symbols.length; j++) {
      if (i === j) { row.push(1); continue; }
      const rA = returns.get(symbols[i]);
      const rB = returns.get(symbols[j]);
      const paired = pairedReturns(rA, rB);
      if (paired.length < 10) { row.push(null); continue; }
      const a = paired.map(p => p.portfolio);
      const b = paired.map(p => p.benchmark);
      const denom = stddev(a) * stddev(b);
      row.push(denom ? covariance(a, b) / denom : null);
    }
    matrix.push(row);
  }
  return { symbols: symbols.map(displaySymbol), matrix };
}

function renderCorrelationMatrix() {
  const container = document.querySelector("#correlationHeatmap");
  if (!container) return;
  const data = correlationMatrix(selectedPeriod);
  if (data.symbols.length < 2) {
    container.innerHTML = '<p class="muted">Need ≥2 holdings with 20+ daily prices.</p>';
    return;
  }
  const size = Math.min(48, Math.max(28, Math.floor(600 / data.symbols.length)));
  const labelW = 60;
  let html = '<div style="overflow-x:auto;">';
  html += `<div style="display:flex;align-items:flex-end;padding-left:${labelW}px;">`;
  data.symbols.forEach(s => {
    html += `<div style="width:${size}px;text-align:center;font-size:10px;transform:rotate(-45deg);transform-origin:center;white-space:nowrap;overflow:hidden;height:${size}px;line-height:${size}px;color:#94a3b8;font-weight:600;">${escapeHtml(s)}</div>`;
  });
  html += '</div>';
  data.matrix.forEach((row, i) => {
    html += '<div style="display:flex;align-items:center;">';
    html += `<div style="width:${labelW}px;font-size:11px;font-weight:600;text-align:right;padding-right:6px;overflow:hidden;white-space:nowrap;">${escapeHtml(data.symbols[i])}</div>`;
    row.forEach((val, j) => {
      const bg = val === null ? 'rgba(255,255,255,0.04)' : val >= 0 ? `rgba(16,185,129,${Math.abs(val) * 0.8})` : `rgba(239,68,68,${Math.abs(val) * 0.8})`;
      const text = val === null ? '' : (val * 100).toFixed(0);
      html += `<div style="width:${size}px;height:${size}px;background:${bg};display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;border:1px solid rgba(0,0,0,0.15);border-radius:2px;cursor:default;transition:transform 0.12s ease;" title="${data.symbols[i]} × ${data.symbols[j]}: ${val === null ? 'N/A' : val.toFixed(3)}">${text}</div>`;
    });
    html += '</div>';
  });
  html += '</div>';
  html += '<div style="display:flex;align-items:center;gap:12px;margin-top:12px;font-size:11px;"><span style="display:flex;align-items:center;gap:4px;"><span style="width:14px;height:14px;background:rgba(239,68,68,0.7);border-radius:2px;"></span> Negative</span><span style="display:flex;align-items:center;gap:4px;"><span style="width:14px;height:14px;background:rgba(255,255,255,0.06);border-radius:2px;"></span> Zero</span><span style="display:flex;align-items:center;gap:4px;"><span style="width:14px;height:14px;background:rgba(16,185,129,0.7);border-radius:2px;"></span> Positive</span></div>';
  const pairs = [];
  for (let i = 0; i < data.symbols.length; i++) {
    for (let j = i + 1; j < data.symbols.length; j++) {
      if (data.matrix[i][j] !== null) pairs.push({ a: data.symbols[i], b: data.symbols[j], corr: data.matrix[i][j] });
    }
  }
  pairs.sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr));
  if (pairs.length) {
    html += '<div style="margin-top:16px;"><strong style="font-size:12px;">Highest correlated pairs</strong>';
    pairs.slice(0, 5).forEach(p => {
      const cls = p.corr >= 0.7 ? 'negative' : p.corr <= -0.3 ? 'positive' : '';
      html += `<div class="metric-row" style="padding:4px 0;"><span>${escapeHtml(p.a)} × ${escapeHtml(p.b)}</span><strong class="${cls}">${(p.corr * 100).toFixed(1)}%</strong></div>`;
    });
    html += '</div>';
  }
  container.innerHTML = html;
}

function monteCarloSimulation(months = 12, trials = 800) {
  const dailyReturns = dailyTwrReturns("1Y");
  if (dailyReturns.length < 20) return null;
  const values = dailyReturns.map(r => r.value);
  const mu = mean(values);
  const sigma = stddev(values);
  const currentValue = activeCurrentValue();
  const tradingDays = months * 21;
  function randn() {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  const finalValues = [];
  const paths = [];
  const sampleCount = Math.min(trials, 8);
  for (let t = 0; t < trials; t++) {
    let value = currentValue;
    const path = t < sampleCount ? [value] : null;
    for (let d = 0; d < tradingDays; d++) {
      value *= (1 + mu + sigma * randn());
      if (path) path.push(value);
    }
    finalValues.push(value);
    if (path) paths.push(path);
  }
  finalValues.sort((a, b) => a - b);
  const percentile = p => finalValues[Math.floor(p * finalValues.length)];
  return {
    currentValue, months, trials, tradingDays, mu, sigma,
    median: percentile(0.5), p10: percentile(0.10), p25: percentile(0.25),
    p75: percentile(0.75), p90: percentile(0.90), p5: percentile(0.05), p95: percentile(0.95),
    mean: mean(finalValues), paths,
    probGain: finalValues.filter(v => v > currentValue).length / trials,
    probLoss20: finalValues.filter(v => v < currentValue * 0.8).length / trials
  };
}

function drawMonteCarlo(canvas) {
  if (!canvas) return;
  const months = parseInt(document.querySelector("#mcMonths")?.value || "12");
  const sim = monteCarloSimulation(months, 800);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const height = 320;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = height * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, height);
  if (!sim) {
    ctx.fillStyle = "#94a3b8"; ctx.font = "14px Outfit, system-ui";
    ctx.fillText("Need ≥20 daily TWR points (1Y period)", 40, 100);
    return;
  }
  const pad = { left: 70, right: 20, top: 30, bottom: 40 };
  const w = canvas.clientWidth - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const steps = sim.paths[0].length;
  const allVals = sim.paths.flat();
  const minV = Math.min(...allVals) * 0.95;
  const maxV = Math.max(...allVals) * 1.05;
  const x = i => pad.left + (i / (steps - 1)) * w;
  const y = v => pad.top + (1 - (v - minV) / (maxV - minV)) * h;
  const pathColors = ['rgba(59,130,246,0.15)','rgba(16,185,129,0.15)','rgba(245,158,11,0.15)','rgba(239,68,68,0.15)','rgba(139,92,246,0.15)','rgba(6,182,212,0.15)','rgba(132,204,22,0.15)','rgba(249,115,22,0.15)'];
  sim.paths.forEach((path, idx) => {
    ctx.strokeStyle = pathColors[idx % pathColors.length]; ctx.lineWidth = 1; ctx.beginPath();
    path.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
    ctx.stroke();
  });
  ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(pad.left, y(sim.currentValue)); ctx.lineTo(pad.left + w, y(sim.currentValue)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = "#f8fafc"; ctx.font = "800 13px Outfit, system-ui"; ctx.textAlign = "left"; ctx.fillText("Now", pad.left, y(sim.currentValue) - 8);
  ctx.fillStyle = "#94a3b8"; ctx.font = "11px Outfit, system-ui"; ctx.textAlign = "left"; ctx.fillText("Today", pad.left, height - 10);
  ctx.textAlign = "right"; ctx.fillText(`${sim.months}M ahead`, pad.left + w, height - 10);
  ctx.textAlign = "right"; ctx.font = "700 10px Outfit, system-ui";
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const v = minV + (maxV - minV) * (i / yTicks);
    ctx.fillText(money(v), pad.left - 6, y(v) + 4);
    ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, y(v)); ctx.lineTo(pad.left + w, y(v)); ctx.stroke();
  }
  const statsNode = document.querySelector("#mcStats");
  if (statsNode) {
    statsNode.innerHTML = `
      <div class="metric-row"><span>Current value</span><strong>${money(sim.currentValue)}</strong></div>
      <div class="metric-row"><span>Median outcome (${sim.months}M)</span><strong>${money(sim.median)}</strong></div>
      <div class="metric-row"><span>10th percentile (bear)</span><strong class="negative">${money(sim.p10)}</strong></div>
      <div class="metric-row"><span>25th percentile</span><strong>${money(sim.p25)}</strong></div>
      <div class="metric-row"><span>75th percentile</span><strong>${money(sim.p75)}</strong></div>
      <div class="metric-row"><span>90th percentile (bull)</span><strong class="positive">${money(sim.p90)}</strong></div>
      <div class="metric-row"><span>Probability of gain</span><strong class="${sim.probGain >= 0.5 ? "positive" : "negative"}">${pct(sim.probGain)}</strong></div>
      <div class="metric-row"><span>Probability of 20%+ loss</span><strong class="${sim.probLoss20 > 0.1 ? "negative" : ""}">${pct(sim.probLoss20)}</strong></div>
      <div class="metric-row"><span>Daily μ / σ</span><strong>${(sim.mu * 100).toFixed(4)}% / ${(sim.sigma * 100).toFixed(4)}%</strong></div>
      <div class="metric-row"><span>Trials</span><strong>${number(sim.trials, 0)}</strong></div>`;
  }
}

function rollingReturnsChart(windowDays = 63) {
  const series = twrIndexSeries("MAX");
  if (series.length < windowDays + 1) return [];
  const results = [];
  for (let i = windowDays; i < series.length; i++) {
    const startVal = series[i - windowDays].value;
    if (startVal > 0) results.push({ date: series[i].date, value: series[i].value / startVal - 1 });
  }
  return results;
}

function drawRollingChart(canvas) {
  if (!canvas) return;
  const windowDays = parseInt(document.querySelector("#rollingChartWindow")?.value || "63");
  const data = rollingReturnsChart(windowDays);
  const ctx = canvas.getContext("2d"); const dpr = window.devicePixelRatio || 1; const height = 260;
  canvas.width = canvas.clientWidth * dpr; canvas.height = height * dpr; ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, canvas.clientWidth, height);
  if (data.length < 2) { ctx.fillStyle = "#94a3b8"; ctx.font = "14px Outfit, system-ui"; ctx.fillText("Need more price history for rolling chart", 40, 80); return; }
  const pad = { left: 60, right: 20, top: 20, bottom: 35 };
  const w = canvas.clientWidth - pad.left - pad.right; const h = height - pad.top - pad.bottom;
  const vals = data.map(d => d.value);
  const maxAbs = Math.max(Math.abs(Math.min(...vals)), Math.abs(Math.max(...vals)), 0.01);
  const minV = -maxAbs * 1.1; const maxV = maxAbs * 1.1;
  const x = i => pad.left + (i / (data.length - 1)) * w;
  const y = v => pad.top + (1 - (v - minV) / (maxV - minV)) * h;
  ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pad.left, y(0)); ctx.lineTo(pad.left + w, y(0)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x(0), y(0));
  data.forEach((d, i) => ctx.lineTo(x(i), y(d.value)));
  ctx.lineTo(x(data.length - 1), y(0)); ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + h);
  grad.addColorStop(0, "rgba(16,185,129,0.25)"); grad.addColorStop(0.5, "rgba(255,255,255,0.02)"); grad.addColorStop(1, "rgba(239,68,68,0.25)");
  ctx.fillStyle = grad; ctx.fill();
  ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2; ctx.beginPath();
  data.forEach((d, i) => i ? ctx.lineTo(x(i), y(d.value)) : ctx.moveTo(x(i), y(d.value))); ctx.stroke();
  ctx.fillStyle = "#94a3b8"; ctx.font = "700 10px Outfit, system-ui"; ctx.textAlign = "right";
  for (let tick = -maxAbs; tick <= maxAbs; tick += maxAbs / 2) ctx.fillText(pct(tick), pad.left - 6, y(tick) + 4);
  ctx.textAlign = "left"; ctx.fillText(data[0].date, pad.left, height - 8);
  ctx.textAlign = "right"; ctx.fillText(data.at(-1).date, pad.left + w, height - 8);
  const avgReturn = mean(vals); const positiveRatio = vals.filter(v => v > 0).length / vals.length;
  const node = document.querySelector("#rollingChartStats");
  if (node) node.innerHTML = `<span>Avg ${pct(avgReturn)} · Positive ${pct(positiveRatio)} of the time · Window ${windowDays} days</span>`;
}

function taxLossHarvestingCandidates() {
  const today = latestDate(); const todayMs = new Date(`${today}T00:00:00`).getTime(); const thirtyDays = 30 * 86400000;
  return activeHoldings().filter(r => r.unrealizedCad < -50).map(row => {
    const recentBuys = activities
      .filter(tx => canonicalSymbol(tx.symbol) === canonicalSymbol(row.symbol) && tx.transaction === "TRADE_BUY")
      .filter(tx => Math.abs(new Date(`${tx.date}T00:00:00`).getTime() - todayMs) <= thirtyDays);
    const superficialRisk = recentBuys.length > 0;
    const held = holdingDaysHeld(row.symbol);
    const taxSavingsEstimate = Math.abs(row.unrealizedCad) * 0.25;
    return {
      symbol: row.display, name: row.name, quantity: row.quantity, costCad: row.costCad,
      marketCad: row.marketCad, unrealizedLoss: row.unrealizedCad, lossPct: row.returnPct,
      superficialRisk, recentBuyDates: recentBuys.map(tx => tx.date),
      daysHeld: held?.days || null, taxSavingsEstimate,
      weight: safeDiv(row.marketCad, activeTotals().totalCad)
    };
  }).sort((a, b) => a.unrealizedLoss - b.unrealizedLoss);
}

function renderTaxLossHarvesting() {
  const node = document.querySelector("#taxLossBody");
  if (!node) return;
  const candidates = taxLossHarvestingCandidates();
  if (!candidates.length) { node.innerHTML = '<tr><td colspan="7">No positions with unrealized losses &gt;$50.</td></tr>'; return; }
  const totalLoss = candidates.reduce((s, c) => s + c.unrealizedLoss, 0);
  const totalSavings = candidates.reduce((s, c) => s + c.taxSavingsEstimate, 0);
  node.innerHTML = candidates.map(c => `<tr>
    <td class="symbol">${escapeHtml(c.symbol)}</td>
    <td class="negative">${money(c.unrealizedLoss)}</td><td class="negative">${pct(c.lossPct)}</td>
    <td>${pct(c.weight)}</td><td>${c.daysHeld !== null ? `${number(c.daysHeld, 0)}d` : "-"}</td>
    <td class="${c.superficialRisk ? "negative" : "positive"}">${c.superficialRisk ? `⚠ Yes (${c.recentBuyDates.join(", ")})` : "Clear"}</td>
    <td class="positive">~${money(c.taxSavingsEstimate)}</td></tr>`).join("") +
    `<tr style="border-top:2px solid rgba(255,255,255,0.15);font-weight:700;"><td>Total harvestable</td><td class="negative">${money(totalLoss)}</td><td colspan="4"></td><td class="positive">~${money(totalSavings)}</td></tr>`;
  const summary = document.querySelector("#taxLossSummary");
  if (summary) summary.innerHTML = `
    <div class="metric-row"><span>Harvestable losses</span><strong class="negative">${money(totalLoss)}</strong></div>
    <div class="metric-row"><span>Est. tax savings (25% rate)</span><strong class="positive">~${money(totalSavings)}</strong></div>
    <div class="metric-row"><span>Candidates</span><strong>${candidates.length} positions</strong></div>
    <div class="metric-row"><span>Superficial loss risk</span><strong class="${candidates.some(c => c.superficialRisk) ? "negative" : "positive"}">${candidates.filter(c => c.superficialRisk).length} positions</strong></div>`;
}

function whatIfBenchmark(symbol, label) {
  const firstDate = activities[0]?.date; const end = latestDate();
  if (!firstDate) return null;
  const startPrice = priceAt(symbol, firstDate); const endPrice = priceAt(symbol, end);
  if (!startPrice || !endPrice) return null;
  let units = 0;
  activities.filter(tx => tx.transaction === "MONEY_MOVEMENT").forEach(tx => {
    const flow = amountCad(tx.amount, tx.currency); const price = priceAt(symbol, tx.date);
    if (price?.close) units += flow / price.close;
  });
  const benchmarkValue = units * endPrice.close; const actualValue = currentOfficialAccountValue();
  return { label, benchmarkValue, actualValue, difference: actualValue - benchmarkValue, outperformed: actualValue > benchmarkValue };
}

function renderWhatIf() {
  const node = document.querySelector("#whatIfResults");
  if (!node) return;
  const scenarios = [whatIfBenchmark("VEQT.TO", "Everything in VEQT"), whatIfBenchmark("VFV.TO", "Everything in VFV")].filter(Boolean);
  if (!scenarios.length) { node.innerHTML = '<p class="muted">Need VEQT.TO and/or VFV.TO price history.</p>'; return; }
  node.innerHTML = scenarios.map(s => `<div style="border:1px solid rgba(148,163,184,0.14);padding:20px;margin-bottom:0;">
    <h3 style="font-size:1rem;font-weight:700;margin:0 0 12px;font-style:italic;">"${escapeHtml(s.label)}?"</h3>
    <div class="metric-row"><span>Benchmark value</span><strong>${money(s.benchmarkValue)}</strong></div>
    <div class="metric-row"><span>Your actual value</span><strong>${money(s.actualValue)}</strong></div>
    <div class="metric-row"><span>Difference</span><strong class="${s.difference >= 0 ? "positive" : "negative"}">${money(s.difference)}</strong></div>
    <div class="metric-row"><span>Verdict</span><strong class="${s.outperformed ? "positive" : "negative"}">${s.outperformed ? "You beat it" : "It beat you"}</strong></div>
  </div>`).join("");
}

function forwardDividendCalendar() {
  const symbolDivHistory = new Map();
  activities.filter(tx => tx.transaction === "DIVIDEND").forEach(tx => {
    const sym = canonicalSymbol(tx.symbol);
    if (!symbolDivHistory.has(sym)) symbolDivHistory.set(sym, []);
    symbolDivHistory.get(sym).push({ date: tx.date, amount: amountCad(tx.amount, tx.currency) });
  });
  const projections = []; const today = new Date(`${latestDate()}T00:00:00`);
  symbolDivHistory.forEach((divs, sym) => {
    if (divs.length < 2) return;
    divs.sort((a, b) => a.date.localeCompare(b.date));
    const gaps = [];
    for (let i = 1; i < divs.length; i++) gaps.push(daysBetween(divs[i - 1].date, divs[i].date));
    const avgGap = mean(gaps);
    const frequency = avgGap < 45 ? "Monthly" : avgGap < 100 ? "Quarterly" : avgGap < 200 ? "Semi-annual" : "Annual";
    const lastDiv = divs.at(-1); const recentAvg = mean(divs.slice(-4).map(d => d.amount));
    const nextDate = new Date(`${lastDiv.date}T00:00:00`); nextDate.setDate(nextDate.getDate() + Math.round(avgGap));
    const holding = activeHoldings().find(h => canonicalSymbol(h.symbol) === sym);
    const annualized = (365 / avgGap) * recentAvg;
    projections.push({
      symbol: displaySymbol(sym), frequency, lastDate: lastDiv.date, recentAvg,
      nextEstimatedDate: nextDate.toISOString().slice(0, 10),
      daysUntilNext: Math.max(0, Math.round((nextDate - today) / 86400000)),
      annualizedIncome: annualized, currentHolding: holding ? holding.marketCad : 0,
      yieldEstimate: holding ? safeDiv(annualized, holding.marketCad) : null
    });
  });
  return projections.sort((a, b) => a.daysUntilNext - b.daysUntilNext);
}

function renderDividendCalendar() {
  const node = document.querySelector("#dividendCalendarBody");
  if (!node) return;
  const rows = forwardDividendCalendar();
  if (!rows.length) { node.innerHTML = '<tr><td colspan="7">No dividend history to project.</td></tr>'; return; }
  const totalAnnual = rows.reduce((s, r) => s + r.annualizedIncome, 0);
  node.innerHTML = rows.map(r => `<tr>
    <td class="symbol">${escapeHtml(r.symbol)}</td><td>${r.frequency}</td><td>${r.lastDate}</td>
    <td class="positive">${money(r.recentAvg)}</td><td>${r.nextEstimatedDate} <small>(${r.daysUntilNext}d)</small></td>
    <td class="positive">${money(r.annualizedIncome)}</td><td>${r.yieldEstimate !== null ? pct(r.yieldEstimate) : "-"}</td>
  </tr>`).join("") + `<tr style="border-top:2px solid rgba(255,255,255,0.15);font-weight:700;"><td>Total projected annual</td><td colspan="4"></td><td class="positive">${money(totalAnnual)}</td><td></td></tr>`;
}

function positionSizingAnalysis() {
  const breakdown = activeRealizedBreakdown();
  const trades = (breakdown.realizedTrades || []).map(t => ({ ...t, pnl: t.pnl ?? t.amount ?? 0 }));
  if (trades.length < 5) return null;
  const wins = trades.filter(t => t.pnl > 0); const losses = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length ? mean(wins.map(t => t.pnl)) : 0;
  const avgLoss = losses.length ? mean(losses.map(t => Math.abs(t.pnl))) : 1;
  const b = avgLoss ? avgWin / avgLoss : 1; const p = winRate; const q = 1 - p;
  const kellyFull = (b * p - q) / b; const kellyHalf = kellyFull / 2;
  return {
    trades: trades.length, winRate, avgWin, avgLoss, winLossRatio: b,
    kellyFull: Math.max(0, kellyFull), kellyHalf: Math.max(0, kellyHalf),
    optimalPositionSize: activeCurrentValue() * Math.max(0, kellyHalf),
    expectancy: winRate * avgWin - (1 - winRate) * avgLoss,
    profitFactor: avgLoss ? (winRate * avgWin) / ((1 - winRate) * avgLoss) : null
  };
}

function renderPositionSizing() {
  const node = document.querySelector("#positionSizing");
  if (!node) return;
  const data = positionSizingAnalysis();
  if (!data) { node.innerHTML = '<p class="muted">Need ≥5 realized trades.</p>'; return; }
  node.innerHTML = `
    <div class="metric-row"><span>Realized trades</span><strong>${data.trades}</strong></div>
    <div class="metric-row"><span>Win rate</span><strong class="${data.winRate >= 0.5 ? "positive" : "negative"}">${pct(data.winRate)}</strong></div>
    <div class="metric-row"><span>Avg win</span><strong class="positive">${money(data.avgWin)}</strong></div>
    <div class="metric-row"><span>Avg loss</span><strong class="negative">${money(data.avgLoss)}</strong></div>
    <div class="metric-row"><span>Win/loss ratio</span><strong>${number(data.winLossRatio, 2)}</strong></div>
    <div class="metric-row"><span>Trade expectancy</span><strong class="${data.expectancy >= 0 ? "positive" : "negative"}">${money(data.expectancy)}</strong></div>
    <div class="metric-row"><span>Profit factor</span><strong>${data.profitFactor !== null ? number(data.profitFactor, 2) : "-"}</strong></div>
    <div class="metric-row"><span>Kelly criterion (full)</span><strong>${pct(data.kellyFull)}</strong></div>
    <div class="metric-row"><span>Half-Kelly (recommended)</span><strong>${pct(data.kellyHalf)}</strong></div>
    <div class="metric-row"><span>Optimal next position</span><strong>${money(data.optimalPositionSize)}</strong></div>`;
}

function dcaEvolution(symbol) {
  const canonical = canonicalSymbol(symbol);
  const txs = activities.filter(tx => canonicalSymbol(tx.symbol) === canonical && ["TRADE_BUY", "TRADE_SELL"].includes(tx.transaction)).sort((a, b) => a.date.localeCompare(b.date));
  let quantity = 0; let totalCost = 0; const points = [];
  txs.forEach(tx => {
    const qty = Math.abs(tx.quantity); if (!qty) return;
    if (tx.transaction === "TRADE_BUY") { quantity += qty; totalCost += Math.abs(amountCad(tx.amount, tx.currency)); }
    else { const avg = quantity ? totalCost / quantity : 0; const sold = Math.min(qty, quantity); quantity -= sold; totalCost -= avg * sold; }
    if (quantity > 0) points.push({ date: tx.date, avgCost: totalCost / quantity, quantity, totalCost, action: tx.transaction === "TRADE_BUY" ? "BUY" : "SELL" });
  });
  return points;
}

function renderDcaTracker() {
  const select = document.querySelector("#dcaSymbol"); const node = document.querySelector("#dcaChart");
  if (!select || !node) return;
  const symbols = activeHoldings().map(r => r.symbol);
  if (select.options.length <= 1) symbols.forEach(s => { const opt = document.createElement("option"); opt.value = s; opt.textContent = displaySymbol(s); select.appendChild(opt); });
  const symbol = select.value;
  if (!symbol) { node.innerHTML = '<p class="muted">Select a symbol to see DCA evolution.</p>'; return; }
  const points = dcaEvolution(symbol);
  if (points.length < 2) { node.innerHTML = '<p class="muted">Need ≥2 trades.</p>'; return; }
  const latest = points.at(-1); const currentPrice = latestPrice(symbol)?.close;
  const currentPriceCad = currentPrice ? amountCad(currentPrice, latestPrice(symbol)?.currency) : null;
  node.innerHTML = `<div style="margin-bottom:12px;">
    <div class="metric-row"><span>Current avg cost (CAD)</span><strong>${money(latest.avgCost)}</strong></div>
    <div class="metric-row"><span>Current price (CAD)</span><strong>${currentPriceCad ? money(currentPriceCad) : "-"}</strong></div>
    <div class="metric-row"><span>Shares held</span><strong>${number(latest.quantity, 4)}</strong></div>
    <div class="metric-row"><span>Total invested (CAD)</span><strong>${money(latest.totalCost)}</strong></div></div>
    <div class="table-wrap compact-table" style="max-height:300px;overflow-y:auto;"><table>
    <thead><tr><th>Date</th><th>Action</th><th>Shares</th><th>Avg Cost</th><th>Total Cost</th></tr></thead>
    <tbody>${points.map(p => `<tr><td>${p.date}</td><td class="${p.action === "BUY" ? "positive" : "negative"}">${p.action}</td><td>${number(p.quantity, 4)}</td><td>${money(p.avgCost)}</td><td>${money(p.totalCost)}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderAdvancedAnalytics() {
  try {
    renderCorrelationMatrix();
    renderTaxLossHarvesting();
    renderWhatIf();
    renderDividendCalendar();
    renderPositionSizing();
    renderDcaTracker();
    drawRollingChart(document.querySelector("#rollingChartCanvas"));
    drawMonteCarlo(document.querySelector("#mcChart"));
  } catch (e) { console.error("Advanced analytics error:", e); }
}

function render() {
  syncPortfolioViewClasses();
  applyPortfolioViewMode();
  buildHoldings();
  buildStatementData();
  renderSummary();
  renderPerformance();
  renderBenchmarkComparison();
  renderAdvancedAttribution();
  renderYearlyPortfolioReturns();
  renderAllocation();
  drawReturnBars(document.querySelector("#returnChart"));
  drawTimeline(document.querySelector("#timelineChart"));
  renderMatrix();
  renderRiskConsole();
  renderHeatmap();
  renderTable();
  renderInsights();
  renderStatementAnalytics();
  renderIncomeDashboard();
  renderRealizedGains();
  renderStockBuyingActivityMetrics();
  renderQualityAndAlerts();
  renderDataCompleteness();
  renderStockPickingAnalysis();
  renderAdvancedAnalytics();
}

async function loadDefaultData() {
  const optionalText = path => fetch(path, { cache: "no-store" }).then(response => response.ok ? response.text() : null).catch(() => null);
  const findLatestActivitiesFile = async () => {
    const formatDate = date => date.toISOString().slice(0, 10);
    const today = new Date();
    const candidates = [];
    for (let i = 0; i <= 90; i += 1) {
      const candidate = new Date(today);
      candidate.setDate(today.getDate() - i);
      candidates.push(`activities-export-${formatDate(candidate)}.csv`);
    }

    for (const name of [...new Set(candidates)]) {
      try {
        const response = await fetch(`./data/${name}`, { cache: "no-store" });
        if (response.ok) return name;
      } catch (error) {
        // Keep probing candidate filenames.
      }
    }
    return null;
  };
  const activityFilename = await findLatestActivitiesFile();
  if (!activityFilename) throw new Error("Missing activities export");
  loadedActivityFilename = activityFilename;

  const [activityText, priceText] = await Promise.all([
    fetch(`./data/${activityFilename}`, { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error(`Missing ${activityFilename}`);
      return response.text();
    }),
    fetch("./data/prices.csv", { cache: "no-store" }).then(response => {
      if (!response.ok) throw new Error("Missing prices.csv");
      return response.text();
    })
  ]);
  const [metadataText, targetText, notesText, holdingsText] = await Promise.all([
    optionalText("./data/symbol-metadata.csv"),
    optionalText("./data/targets.csv"),
    optionalText("./data/manual-notes.csv"),
    optionalText("./data/holdings-current.csv").then(text => text || optionalText("./data/holdings.csv"))
  ]);
  symbolMetadata = metadataText ? parseMetadata(metadataText) : new Map();
  targets = targetText ? parseTargets(targetText) : fallbackTargets;
  manualNotes = notesText ? parseManualNotes(notesText) : [];
  holdingsCurrentRows = holdingsText ? toObjects(holdingsText) : [];
  holdingsCurrentAsOf = holdingsText ? parseHoldingsAsOf(holdingsText) : null;
  holdingsSnapshotMap = holdingsCurrentRows.length ? parseHoldingsSnapshotMap(holdingsCurrentRows, holdingsCurrentAsOf) : new Map();
  activities = parseActivities(activityText);
  priceRows = parsePrices(priceText);
  clearPerformanceCaches();
  render();
}

document.querySelectorAll(".period").forEach(button => {
  button.addEventListener("click", () => {
    const nextPeriod = button.dataset.period;
    if (!nextPeriod || nextPeriod === selectedPeriod) return;
    selectedPeriod = nextPeriod;
    clearPerformanceCaches();
    document.querySelectorAll(".period").forEach(item => {
      item.classList.toggle("active", item.dataset.period === selectedPeriod);
    });
    document.body.classList.add("is-calculating");
    requestAnimationFrame(() => {
      try {
        renderPerformance();
        renderBenchmarkComparison();
        applyPortfolioViewMode();
        renderRiskConsole();
        drawTimeline(document.querySelector("#timelineChart"));
      } finally {
        document.body.classList.remove("is-calculating");
      }
    });
  });
});


document.addEventListener("click", event => {
  const button = event.target.closest(".view-toggle");
  if (!button) return;

  const nextView = button.dataset.view;
  if (!nextView || nextView === portfolioViewMode) return;

  portfolioViewMode = nextView;
  clearPerformanceCaches();
  render();

  console.log("Portfolio view mode:", portfolioViewMode);
});


document.querySelector("#benchmarkSelect")?.addEventListener("change", event => {
  selectedBenchmark = event.target.value || "SP500";
  renderBenchmarkComparison();
});

document.querySelector("#fxRate")?.addEventListener("input", () => {
  clearPerformanceCaches();
  render();
});
document.querySelector("#allocationMode")?.addEventListener("change", renderAllocation);
document.querySelector("#returnMode")?.addEventListener("change", () => drawReturnBars(document.querySelector("#returnChart")));
document.querySelector("#matrixMode")?.addEventListener("change", renderMatrix);
document.querySelector("#searchBox")?.addEventListener("input", renderTable);
document.querySelector("#sortBy")?.addEventListener("change", renderTable);
document.querySelector("#csvInput")?.addEventListener("change", event => {
  const files = [...event.target.files];
  Promise.all(files.map(file => file.text())).then(texts => {
    const parsed = texts.flatMap(parseActivities);
    if (parsed.length) activities = parsed.sort((a, b) => a.date.localeCompare(b.date));
    clearPerformanceCaches();
    render();
  });
});
document.querySelector("#priceInput")?.addEventListener("change", event => {
  const files = [...event.target.files];
  Promise.all(files.map(file => file.text())).then(texts => {
    priceRows = texts.flatMap(parsePrices).sort((a, b) => a.date.localeCompare(b.date));
    priceBySymbol = new Map();
    priceRows.forEach(row => {
      if (!priceBySymbol.has(row.symbol)) priceBySymbol.set(row.symbol, []);
      priceBySymbol.get(row.symbol).push(row);
    });
    clearPerformanceCaches();
    render();
  });
});
window.addEventListener("resize", render);

document.querySelector("#rollingChartWindow")?.addEventListener("change", () => drawRollingChart(document.querySelector("#rollingChartCanvas")));
document.querySelector("#mcMonths")?.addEventListener("change", () => drawMonteCarlo(document.querySelector("#mcChart")));
document.querySelector("#mcRun")?.addEventListener("click", () => drawMonteCarlo(document.querySelector("#mcChart")));
document.querySelector("#dcaSymbol")?.addEventListener("change", renderDcaTracker);

loadDefaultData().catch(error => {
  console.error(error);
  document.querySelector("#asOf").textContent = "Could not load latest activities export and prices.csv. Use the import buttons.";
});


window.stockPickingStartDate = () => firstStockOnlyDate();
window.stockPickingSymbolsEver = () => [...allIndividualStockSymbolsEver()].map(displaySymbol).sort();


window.stockPickingRealizedDebug = () => {
  const allowed = allIndividualStockSymbolsEver();
  const breakdown = returnBreakdown();
  return breakdown.realizedRows.map(row => ({
    symbol: row.symbol,
    canonical: canonicalSymbol(row.symbol),
    allowed: allowed.has(canonicalSymbol(row.symbol)),
    individual: isIndividualStock(row.symbol),
    amount: row.amount
  }));
};
