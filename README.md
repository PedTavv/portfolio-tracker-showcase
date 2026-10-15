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
python3 -m http.server 4173 --bind 127.0.0.1
```

Open `http://127.0.0.1:4173/`. Binding to `127.0.0.1` keeps the server (and your data files) off your local network.

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

For private use, put your own files in `data/private/` (create it if needed) using the same filenames and column formats as the demo files in `data/`. That folder is git-ignored, so nothing in it can be committed by accident.

When `data/private/` contains an `activities-export-YYYY-MM-DD.csv` from the last 90 days, the app loads all of its data from that folder (activities, `prices.csv`, and the optional metadata, targets, notes, and holdings files). Otherwise it falls back to the synthetic demo data in `data/`. Copy any demo files you want to reuse (for example `symbol-metadata.csv` or `targets.csv`) into `data/private/`. To refresh prices for your private data, run `python3 scripts/update_prices_auto.py --data-dir data/private`.

Never save real data over the demo filenames in `data/`: those files are tracked and would be committed. The `.gitignore` also blocks common real export filenames in `data/` as a backstop.

## Notes

No backend is required unless you choose to run the optional price refresh script. The refresh script expects internet access because it fetches historical prices from Yahoo Finance.
