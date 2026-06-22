# Portfolio Tracker Showcase

A static portfolio tracker demo that reconstructs holdings, allocation, returns, income, risk, and trade activity from CSV files.

This public version ships with synthetic demo data only. It is intended as a template for people who want to build their own personal tracker without publishing private brokerage exports.

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

## Notes

The app is browser-only: HTML, CSS, JavaScript, and CSV files. No backend is required unless you choose to run the optional price refresh script.
