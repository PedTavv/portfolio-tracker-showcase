# Portfolio Tracker Showcase

A static portfolio tracker demo that reconstructs holdings, allocation, returns, income, risk, and trade activity from CSV files. It runs entirely in the browser with plain HTML, CSS, JavaScript, and local CSV files.

This public version ships with synthetic demo data only. It is intended as a template for people who want to build their own personal tracker without publishing private brokerage exports.

## Features

- Reconstructs positions from an activity ledger.
- Shows current holdings, cost basis, unrealized gains, realized gains, income, and trading activity.
- Compares selected-period performance against benchmarks.
- Breaks down allocation by symbol, asset class, currency, sector, country, theme, risk bucket, or target bucket.
- Includes risk, concentration, drawdown, heatmap, return attribution, rebalancing, scenario, and Monte Carlo views.
- Supports optional symbol metadata, target allocation buckets, manual notes, and synthetic price history.

## Run

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173/`.

You can also run the helper script:

```bash
./portfolio.command
```

The helper starts the app on port `8081` and opens the browser.

## Data Files

- `data/activities-export-2026-06-01.csv` is a fake transaction ledger.
- `data/holdings-current.csv` and `data/holdings.csv` are fake current holdings snapshots.
- `data/prices.csv` contains synthetic price history for the demo symbols and benchmarks.
- `data/symbol-metadata.csv` classifies symbols by sector, country, asset class, theme, and risk bucket.
- `data/targets.csv` defines target allocation buckets.
- `data/manual-notes.csv` adds optional trade notes.

## Use Your Own Data Privately

Do not commit real brokerage exports, account numbers, statements, or full trading history to a public repository.

For private use, place your own export files in `data/` using the same column formats, then run the local server. Keep real files ignored or outside the repo.

The included `.gitignore` blocks common real export filenames by default while allowing the synthetic demo files to remain committed.

## Notes

No backend is required unless you choose to run the optional price refresh script. The refresh script expects internet access because it fetches historical prices from Yahoo Finance.
