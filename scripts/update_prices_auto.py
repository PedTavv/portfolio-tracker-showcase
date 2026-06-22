#!/usr/bin/env python3
"""
Auto-generate data/prices.csv for the portfolio dashboard.

What this does:
- Finds the newest activities-export-*.csv automatically.
- Reads symbols from that export.
- Maps brokerage/export symbols to Yahoo Finance tickers.
- Fetches historical daily prices from Yahoo Finance.
- Uses regular close for portfolio market value.
- Keeps adjusted close separately for total-return style calculations.
- Writes data/prices.csv.

Run from the project root:
    python3 update_prices_auto.py

Optional:
    python3 update_prices_auto.py --data-dir data
    python3 scripts/update_prices_auto.py --activity activities-export-2026-06-01.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

BENCHMARKS = ["^GSPC", "^GSPTSE", "VFV.TO", "VCN.TO", "XQQ.TO", "CASH.TO", "CAD=X"]

ALIASES = {
    # Extend this map with whatever symbols your broker exports differently.
    "AAPL": "AAPL",
    "CASH": "CASH.TO",
    "SHOP": "SHOP.TO",
    "VCN": "VCN.TO",
    "VFV": "VFV.TO",
    "XQQ": "XQQ.TO",
}

VALID_ACTIVITY_TYPES = {
    "TRADE",
    "DIVIDEND",
    "INTEREST",
    "STOCKLENDING",
    "STOCK_LENDING",
    "OPTIONEXPIRY",
    "OPTION_EXPIRY",
    "LEGACYCORPORATEACTION",
    "LEGACY_CORPORATE_ACTION",
}


def project_root() -> Path:
    # If the script is in scripts/, project root is parent. If it is already in root, root is script folder.
    here = Path(__file__).resolve().parent
    if here.name.lower() in {"scripts", "bin"}:
        return here.parent
    return here


def normalize_type(value: str | None) -> str:
    return "".join(ch if ch.isalnum() else "_" for ch in str(value or "").upper()).strip("_")


def is_probably_option_symbol(symbol: str) -> bool:
    # Some broker option rows can look like: AAPL 260102C00237500
    clean = str(symbol or "").strip().upper()
    return " " in clean and any(ch in clean for ch in ["C", "P"])


def yahoo_symbol(symbol: str | None) -> str | None:
    clean = str(symbol or "").strip().upper()
    if not clean or clean in {"CAD", "USD", "CASH", "N/A"}:
        return None
    if is_probably_option_symbol(clean):
        return None
    if clean.startswith("^") or clean.endswith((".TO", ".CN", ".NE")):
        return clean
    return ALIASES.get(clean, clean)


def display_symbol(yahoo: str) -> str:
    return yahoo.replace(".TO", "").replace(".CN", "").replace("U-UN", "U.UN")


def currency_for(symbol: str) -> str:
    upper = symbol.upper()
    if upper == "CAD=X":
        return "FX"
    if upper.endswith((".TO", ".CN", ".NE")):
        return "CAD"
    return "USD"


def find_latest_activities_csv(data_dir: Path, explicit: str | None = None) -> Path:
    candidates: list[Path] = []

    if explicit:
        p = Path(explicit).expanduser()
        if not p.is_absolute():
            # Accept either project-root-relative or data-dir-relative paths.
            candidates.extend([project_root() / p, data_dir / p])
        else:
            candidates.append(p)
    else:
        search_dirs = [data_dir, project_root(), Path.cwd()]
        for d in search_dirs:
            if d.exists():
                candidates.extend(d.glob("activities-export-*.csv"))

    seen = set()
    unique = []
    for p in candidates:
        rp = p.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        if rp.exists() and rp.is_file():
            unique.append(rp)

    if not unique:
        raise FileNotFoundError(
            "No activities-export-*.csv found. Put your brokerage export in ./data/ or the project root."
        )

    dated_candidates = []
    undated_candidates = []

    for path in unique:
        match = re.search(r"activities-export-(\d{4}-\d{2}-\d{2})", path.name)
        if match:
            dated_candidates.append((match.group(1), path))
        else:
            undated_candidates.append(path)

    if dated_candidates:
        return max(dated_candidates, key=lambda item: item[0])[1]

    # Fallback for manually named files without a date in the filename.
    return max(undated_candidates, key=lambda p: (p.stat().st_mtime, p.name))


def refresh_latest_holdings_file(data_dir):
    dated_candidates = []

    for path in data_dir.glob("holdings-report-*.csv"):
        match = re.search(r"holdings-report-(\d{4}-\d{2}-\d{2})", path.name)
        if not match:
            continue
        dated_candidates.append((match.group(1), path))

    if not dated_candidates:
        print("no holdings-report-*.csv found; keeping existing holdings-current.csv")
        return None

    latest_date, latest = max(dated_candidates, key=lambda item: item[0])

    shutil.copy2(latest, data_dir / "holdings-current.csv")
    shutil.copy2(latest, data_dir / "holdings.csv")
    print(f"refreshed holdings-current.csv and holdings.csv from {latest.name}")
    return latest


def symbols_from_activities(activity_file: Path) -> set[str]:
    symbols = set(BENCHMARKS)

    with activity_file.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        for row in reader:
            activity_type = normalize_type(row.get("activity_type"))
            if activity_type not in VALID_ACTIVITY_TYPES:
                continue

            for key in ("symbol", "underlying symbol"):
                mapped = yahoo_symbol(row.get(key))
                if mapped:
                    symbols.add(mapped)

    return symbols


def yahoo_chart(symbol: str, start: datetime, end: datetime) -> list[dict]:
    p1 = int(start.replace(tzinfo=timezone.utc).timestamp())
    p2 = int(end.replace(tzinfo=timezone.utc).timestamp())
    encoded = urllib.parse.quote(symbol, safe="")
    url = (
        f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}"
        f"?period1={p1}&period2={p2}&interval=1d&events=history&includeAdjustedClose=true"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read().decode("utf-8"))

    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        return []

    timestamps = result.get("timestamp") or []
    quote = (result.get("indicators", {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    adj = ((result.get("indicators", {}).get("adjclose") or [{}])[0]).get("adjclose") or []
    meta = result.get("meta", {}) or {}
    regular_market_price = meta.get("regularMarketPrice")
    regular_market_time = meta.get("regularMarketTime")

    rows = []
    for i, ts in enumerate(timestamps):
        close = closes[i] if i < len(closes) else None
        adj_close = adj[i] if i < len(adj) else None
        if close is None and adj_close is None:
            continue

        rows.append({
            "date": datetime.fromtimestamp(ts, timezone.utc).date().isoformat(),
            "symbol": symbol.upper(),
            "display_symbol": display_symbol(symbol.upper()),
            "close": round(float(close if close is not None else adj_close), 6),
            "adj_close": round(float(adj_close), 6) if adj_close is not None else "",
            "currency": currency_for(symbol),
            "source": "yahoo_chart",
        })

    # Add live/current quote row if Yahoo supplies it and it is newer or equal to the latest daily row.
    # This is the closest Yahoo value to a current market price, but it can still be delayed.
    if regular_market_price is not None:
        if regular_market_time:
            quote_date = datetime.fromtimestamp(int(regular_market_time), timezone.utc).date().isoformat()
        else:
            quote_date = datetime.now(timezone.utc).date().isoformat()
        live_row = {
            "date": quote_date,
            "symbol": symbol.upper(),
            "display_symbol": display_symbol(symbol.upper()),
            "close": round(float(regular_market_price), 6),
            "adj_close": "",
            "currency": currency_for(symbol),
            "source": "yahoo_regular_market_price",
        }
        # Replace same-date row with the live quote; otherwise append it.
        rows = [r for r in rows if not (r["date"] == quote_date and r["symbol"] == symbol.upper())]
        rows.append(live_row)

    return rows


def write_prices(rows: Iterable[dict], out_file: Path) -> None:
    out_file.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["date", "symbol", "display_symbol", "close", "adj_close", "currency", "source"]
    sorted_rows = sorted(rows, key=lambda r: (r["symbol"], r["date"], r.get("source", "")))
    with out_file.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(sorted_rows)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", default=str(project_root() / "data"))
    parser.add_argument("--activity", default=None, help="Optional exact activity CSV path. Usually unnecessary.")
    parser.add_argument("--days", type=int, default=920)
    parser.add_argument("--sleep", type=float, default=0.25)
    args = parser.parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve()
    refresh_latest_holdings_file(data_dir)
    activity_file = find_latest_activities_csv(data_dir, args.activity)
    out_file = data_dir / "prices.csv"

    end = datetime.now(timezone.utc) + timedelta(days=1)
    start = end - timedelta(days=max(args.days, 30))
    symbols = sorted(symbols_from_activities(activity_file))

    print(f"activity file: {activity_file}")
    print(f"output file:   {out_file}")
    print(f"fetching {len(symbols)} symbols")

    all_rows: list[dict] = []
    failures: list[str] = []

    for symbol in symbols:
        try:
            rows = yahoo_chart(symbol, start, end)
            if rows:
                all_rows.extend(rows)
                print(f"{symbol}: {len(rows)} rows")
            else:
                failures.append(symbol)
                print(f"{symbol}: no rows")
        except Exception as e:
            failures.append(symbol)
            print(f"{symbol}: failed - {e}")
        time.sleep(args.sleep)

    write_prices(all_rows, out_file)
    print(f"wrote {out_file} ({len(all_rows)} rows)")

    if failures:
        print("missing symbols:", ", ".join(failures))
        print("If a symbol is wrong, add it to ALIASES in update_prices_auto.py.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
