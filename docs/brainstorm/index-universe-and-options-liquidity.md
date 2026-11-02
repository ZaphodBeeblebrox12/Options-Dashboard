# Brainstorm: Index Universe, Stock Selection & Derivatives Liquidity

**Status:** Brainstorm / design notes only. Nothing in this document is implemented or approved for production.

## Objective

When the user has a directional view on an index (initially NIFTY 50 or BANK NIFTY), identify constituent stocks that may offer attractive, tradable options exposure. The system must work within a constrained Angel One WebSocket subscription budget (approximately 1,000–3,000 instrument tokens in total, subject to current account/API limits and other dashboard subscriptions).

The goal is not to subscribe to every F&O option contract. Screen broadly using end-of-day data, then spend live subscriptions on a smaller, ranked shortlist.

## Phase 1 scope

- Support **NIFTY 50** and **NIFTY BANK (BANK NIFTY)** initially.
- Keep the design index-agnostic so additional NSE/BSE indices can be added later by configuration/data rather than rewriting the scanner.
- Maintain a single canonical stock/security record with many-to-many index membership. A stock can belong to multiple indices.
- Keep index membership separate from F&O eligibility. Leaving an index must not automatically remove a stock from the F&O universe.
- Combine selected indices by taking the union of their constituents and de-duplicating securities.
- When an F&O-only universe is requested, intersect the selected constituents with the current F&O-eligible securities list.

## Index membership data and settings UX

Proposed Settings area: **Index Universe**.

Two complementary views:
1. **Index → constituents:** choose NIFTY 50 or BANK NIFTY and view its current constituents.
2. **Stock → indices:** search a symbol and show every index containing it.

Provide bulk universe selection:
- Select one index or combine multiple indices.
- Preview constituent count and unique-stock count.
- Optionally restrict to F&O-eligible stocks.
- Save named universes (examples: “NIFTY 50 F&O”, “BANK NIFTY F&O”, “NIFTY + BANK NIFTY”).

Initial source approach:
- Retrieve official constituent CSV/download files from NSE Indices (and BSE Indices if/when BSE indices are added).
- Prefer direct HTTP downloads of published files over browser automation or HTML scraping.
- Preserve source URL, retrieval timestamp, effective/as-of date and file checksum/version.
- Validate downloaded data before replacing the last-known-good snapshot. A failed/empty download must never be interpreted as an empty index.
- Corporate-action/rebalance announcement parsing is explicitly **deferred** for a later phase. The current phase can establish current membership from constituent snapshots and compare successive snapshots; announcement monitoring and parsing need separate design and testing.

## Daily after-market F&O liquidity screening

### Proposed source

Use the official NSE derivatives **UDiFF Common Bhavcopy Final** daily report (downloadable file/ZIP from NSE's derivatives reports page) as the initial end-of-day source.

The file is expected to provide contract-level derivatives records, including fields needed to identify symbol, expiry, strike, option type, volume/traded quantity, turnover, closing price and open interest. Before implementation, inspect current file samples/schema and confirm exact field names, units, contract multipliers and whether the required fields are present for every relevant contract.

Do not rely on older discontinued F&O bhavcopy formats.

### Daily workflow

After market close / when the final report is published:
1. Download the official daily derivatives report using ordinary HTTP requests where permitted and technically supported.
2. Validate HTTP status, file type, date, size and expected schema.
3. Parse and normalize contract records.
4. Filter to stock options for the current NIFTY 50 and BANK NIFTY constituent union.
5. Group by underlying, expiry, strike and CE/PE.
6. Store raw source file metadata and normalized daily contract observations.
7. Calculate per-stock and per-contract liquidity metrics.
8. Maintain rolling 5-session and 20-session histories/rankings.

No additional Angel One WebSocket tokens are needed for this end-of-day screening step.

### Liquidity measures

Evaluate options liquidity independently from futures liquidity. A stock can have liquid futures and illiquid options, or vice versa.

Candidate options measures:
- Traded quantity / volume.
- Premium turnover (be explicit that options premium turnover is not the same as underlying notional turnover).
- Open interest and change in OI.
- Activity and consistency across recent sessions.
- Activity concentrated around ATM and nearby strikes, rather than indiscriminately summing every distant strike.

For each underlying, assess the relevant near expiries and an ATM-centred strike window (exact window and expiry selection to be calibrated). Do not let a burst in a far-OTM contract make the whole stock appear liquid.

Maintain separate:
- **Options liquidity ranking**
- **Futures liquidity ranking**

A preliminary scoring model was discussed, but is not finalized:
- Options traded value: 35%
- Options volume: 25%
- ATM/nearby OI: 20%
- 20-session consistency: 20%

Weights, normalization, minimum thresholds and treatment of expiry-day effects must be tested against real data before adoption. OI alone is not a measure of executable liquidity.

## Next-session live verification and token allocation

Use the previous session's ranking as a shortlist, not as a guarantee of current liquidity.

During market hours:
1. Prioritize shortlisted stocks according to the user's selected directional index view and other approved ranking signals.
2. Allocate live subscriptions only to the shortlisted contracts/instruments that fit the available token budget.
3. Use Angel One live market data to verify bid/ask spread, bid/ask quantities/depth, live activity and execution quality.
4. Reassess or demote contracts when live liquidity deteriorates.
5. Keep token accounting at the **instrument-token** level (including strikes and expiries), not merely stock count.

Do not assume futures liquidity implies options liquidity. Do not subscribe to every strike or expiry by default.

## Directional stock opportunity ranking: terminology

Keep the following concepts distinct:

- **Beta:** historical sensitivity of a stock's returns to a benchmark's returns. For a NIFTY 50 thesis, compare against NIFTY 50; for a BANK NIFTY thesis, compare against BANK NIFTY. Beta is estimated from rolling return observations and is not a guaranteed multiplier for the next move.
- **Jensen's alpha:** risk-adjusted excess return relative to a benchmark and risk-free rate, estimated over a defined historical window. It can be calculated on a rolling basis; it is historical/estimated, not a forward prediction.
- **Relative strength:** whether the stock is outperforming or underperforming its relevant index over a chosen period. This is distinct from Jensen's alpha.
- **Momentum:** price trend/acceleration measures over explicitly defined windows.
- **Options liquidity / execution quality:** whether the specific option contract is practical to trade.

Potential future scanner sequence:
1. User selects a directional view: NIFTY bullish/bearish or BANK NIFTY bullish/bearish.
2. Retrieve that index's constituents.
3. Rank constituents using benchmark-appropriate Beta, rolling alpha, relative strength and momentum.
4. Apply the prior-session options-liquidity screen.
5. Shortlist candidates within token constraints.
6. Verify the actual option contract's live spread and depth before presenting it as tradable.

Do not equate high Beta with positive expected returns. Do not treat historical alpha or relative strength as a prediction. Do not make an options recommendation based only on underlying-stock metrics.

## Proposed dashboard sections

Within Settings / scanner configuration:
- **Index Universe:** supported indices, constituent views and bulk selection.
- **Stock Membership:** reverse lookup from stock to all indices.
- **Options Liquidity:** daily ranking, rolling history and screening thresholds.
- **Futures Liquidity:** separate ranking.
- **Live Monitoring:** currently subscribed instrument tokens and allocation.
- **Historical Rankings:** compare daily and rolling liquidity scores.

Potential later opportunity view:
- Selected index and directional thesis.
- Candidate underlying, index memberships and F&O eligibility.
- Beta, rolling Jensen's alpha, relative strength and momentum.
- Options liquidity score and relevant expiry/strike.
- Live bid/ask spread, depth and freshness.
- Clear reasons for inclusion/exclusion.

## Non-goals / safeguards for this brainstorm

- No changes to the existing GEX calculation cadence or GEX engine.
- No broad all-F&O live subscription.
- No assumption that a stock's futures liquidity proves its options are liquid.
- No automatic removal from the F&O universe when index membership changes.
- No production thresholds until backtested/calibrated.
- No announcement PDF parser in this initial phase.
- No assumption that public availability of exchange files grants unrestricted commercial redistribution rights. Check NSE/BSE licensing and permitted use before exposing data to TradeThesis members.

## Open verification and implementation questions

1. Confirm current NSE UDiFF Bhavcopy download endpoint, file schema, publication timing, field definitions and historical availability.
2. Confirm whether Angel One REST endpoints can provide any useful broad-market/EOD fallback without excessive rate-limit or token cost; do not assume they can replace NSE bhavcopy.
3. Confirm current Angel One WebSocket token/subscription limits and existing dashboard token consumption.
4. Define ATM-centred strike/expiry windows and score normalization.
5. Test daily rankings over a meaningful historical sample, including expiry sessions and unusual volume spikes.
6. Confirm exchange data licensing for commercial use and redistribution.
7. Later phase: design announcement monitoring, document extraction, announced-vs-effective status and reconciliation against constituent snapshots.

**Decision captured:** Phase 1 starts with NIFTY 50 and BANK NIFTY; after-market NSE derivatives bhavcopy screening creates the shortlist; live Angel One subscriptions are reserved for shortlisted contracts and used to validate actual execution liquidity.


## Future development: Index lead–lag / early-warning scanner

**Status:** Future research item only. Not part of the initial index-universe and options-liquidity work. No implementation is authorized by this note.

### Idea

Investigate whether particular heavyweight constituents tend to move ahead of their benchmark index, potentially providing an early indication of an impending index move or breakout. The initial benchmarks are NIFTY 50 and BANK NIFTY.

This is a lead–lag hypothesis to test, not an assumption that an individual stock reliably predicts the index. A stock may move first because of stock-specific news, may react to the same information as the index, or may lead only in certain market regimes.

### Research questions / candidate measurements

- **Lead horizon:** Test whether a constituent's returns or breakout activity precede index movement at horizons such as 1, 2, 5 and 10 minutes.
- **Conditional follow-through:** After a defined stock move or breakout, measure how often the benchmark subsequently moves in the same direction within each horizon.
- **Magnitude:** Measure the distribution of subsequent index returns, not just the percentage of times direction matched.
- **Stability:** Test across different dates, volatility regimes, trend/range conditions and market sessions; avoid selecting leaders from one isolated period.
- **Volume confirmation:** Check whether the constituent's move is accompanied by abnormal traded volume/turnover.
- **Breadth / agreement:** Test whether multiple historically leading, influential constituents are confirming in the same direction rather than relying on a single stock.
- **Out-of-sample validation:** Define signals without look-ahead bias, account for overlapping observations and transaction costs, and validate on dates not used to discover the relationship.

### Data requirement

Daily derivatives Bhavcopy is not sufficient to establish minute-level lead–lag behaviour. This research needs aligned historical intraday prices for the relevant constituents and the benchmark index, ideally one-minute bars (with five-minute bars as a possible lower-resolution alternative). Historical intraday volume should be included where available.

Before implementation, verify the availability, coverage, timestamp alignment, adjustment methodology, cost and licensing of a suitable historical intraday data source. Do not assume the existing Angel One live feed provides six months of historical intraday data.

### Possible eventual output

A separate **Index Early Warning** view could show:
- benchmark (NIFTY 50 or BANK NIFTY) and current directional context;
- constituents with historically tested lead relationships;
- which leaders are currently moving and whether volume confirms;
- whether several influential constituents agree;
- the observed lead horizon and historical follow-through statistics;
- index breakout level/status and whether index confirmation is still pending.

This should be an informational early-warning signal, not an automatic order trigger or a claim that a breakout is imminent. Keep it separate from the stock-selection/liquidity scanner: beta estimates sensitivity, relative strength/momentum describe current or recent performance, options liquidity assesses tradability, while lead–lag research tests whether a stock's move tends to precede the index.


## Shortlist scoring model — standalone prototype

**Status:** Experimental scoring model for hands-on testing. Weights, bands and thresholds are not production-approved.

### Intended purpose

When the user has a directional view on NIFTY 50 or NIFTY BANK, rank constituent F&O stocks that may offer greater directional exposure through their own options. The score is a screening/ranking aid, not a trade signal or a guarantee of future movement.

### Initial default weights

- Beta: **30%**
- Jensen's alpha: **20%**
- Relative strength: **30%**
- Options liquidity: **20%**

If the entered weights do not total 100%, normalize them proportionally. All component scores are converted to a 0–100 scale before weighting.

### Data definitions and separate sources

- **Beta:** rolling regression of daily cash-equity stock returns against the selected benchmark's daily returns. Initial experiment: 60 trading sessions. Use NIFTY 50 as benchmark for NIFTY constituents and NIFTY BANK for Bank Nifty constituents.
- **Jensen's alpha:** regression intercept / risk-adjusted excess return using aligned daily cash-market returns. Prototype input is annualized alpha in percent; initial experiment can use the same 60-session estimation window as beta.
- **Relative strength (RS):** stock's total return minus benchmark's total return over the preceding 20 trading sessions, expressed in percentage points. This is not the same as beta or Jensen's alpha.
- **Options liquidity:** separate 0–100 score eventually derived from derivatives Bhavcopy history. It must be based on options activity around relevant ATM/nearby strikes and expiries; do not infer options liquidity from futures liquidity or OI alone. In the first HTML prototype, this is entered manually because the final Bhavcopy-based liquidity formula has not yet been calibrated.
- **Live execution check:** bid-ask spread and available depth are checked only on shortlisted contracts using live Angel One data.

Important source distinction: derivatives Bhavcopy supplies futures/options contract activity and OI for the liquidity screen. It does **not** supply the cash-equity closing-price history needed for beta, Jensen's alpha or relative strength. Those calculations require cash-market closing prices for each stock and its corresponding index.

### Prototype score transformations

The standalone HTML prototype uses transparent, adjustable linear bands:

- **Beta score:** `clamp(max(beta, 0) / beta_cap × 100, 0, 100)`. Default beta_cap = 2.0. Higher positive beta is preferred for both bullish and bearish index views because the aim is to find stocks that historically move with, and potentially amplify, the benchmark move. Negative beta receives zero rather than being treated as an amplifier.
- **Alpha score:** clamp the directional annualized alpha mapped across a default ±15% band to 0–100. Bullish view rewards more positive alpha; bearish view rewards more negative alpha.
- **RS score:** clamp the directional 20-session excess return mapped across a default ±10 percentage-point band to 0–100. Bullish view rewards outperformance; bearish view rewards underperformance.
- **Liquidity score:** use the entered 0–100 options-liquidity score directly.
- **Final score:** weighted sum of the four 0–100 component scores, divided by the sum of entered weights. Default weights are 30/20/30/20.
- **Hard liquidity gate:** default minimum liquidity score = 35/100. A candidate below the gate is labelled Filtered and is placed below qualifying candidates regardless of its composite score.

The prototype exposes beta cap, alpha band, RS band, minimum liquidity gate and all four weights for experimentation. These calibration values are placeholders, not validated market thresholds. The score is relative to the stated input definitions and bands; it should not be described as a probability of success.

### Standalone test artifact

A browser-only HTML prototype was prepared as `stock-opportunity-score.html`. It includes editable candidate rows, bullish/bearish selection, benchmark selection, adjustable weights and score bands, a hard liquidity filter, ranked output, local session save/load and CSV export. Sample values are synthetic and explicitly labelled as illustrative. The prototype makes no market-data or broker API calls and does not change production dashboard code.

### Testing questions before adopting the model

1. Does a 60-session beta estimate give a sufficiently stable ranking, or should it be compared with 20- and 120-session windows?
2. Is Jensen's alpha adding information beyond relative strength, or are the two too correlated for both to deserve the proposed weights?
3. Which alpha annualization method and risk-free-rate convention should be used consistently?
4. What Bhavcopy-derived measures and thresholds should define the options-liquidity score for near-ATM contracts?
5. Does a hard minimum liquidity gate of 35/100 remove illiquid names without excluding usable contracts?
6. Validate the score out-of-sample and compare the selected stock-options exposure with simply trading the index option. Do not assume a high score implies better realized returns.


## Cash-market historical prices for beta, alpha and relative strength

**Correction / source clarification:** Do not expect derivatives Bhavcopy to provide the stock cash-market close history required for beta, Jensen's alpha or relative strength. These metrics require aligned historical cash-equity prices for each constituent and the matching index.

### Official NSE sources verified

- NSE All Reports: https://www.nseindia.com/all-reports
  - Daily **CM-UDiFF Common Bhavcopy Final (ZIP)** is the preferred bulk daily cash-market source. The older CM Bhavcopy CSV/common Bhavcopy formats were discontinued from 8 July 2024; use the UDiFF CM common Bhavcopy final format.
  - Download one daily file per trading session, parse the daily equity records, and retain the required symbols' close prices (and OHLC if useful).
- NSE Historical Reports: https://www.nseindia.com/static/resources/historical-reports-capital-market-daily-monthly-archives
  - Lists both Security-wise Price Volume Archives (Equities) and Historical Index Data.
- NSE Security-wise Archives (Equities): https://www.nseindia.com/report-detail/eq_security
  - Supports 1D, 1W, 1M, 3M, 6M, 1Y, 5Y and custom ranges with CSV download. NSE notes that a symbol is mandatory for more than one day of data, so this is useful for individual-symbol checks but is not the preferred one-download-for-the-whole-universe route.
- NSE Indices Historical Data: https://www.niftyindices.com/reports/historical-data
  - Use the index-specific history for NIFTY 50 and NIFTY BANK benchmark closes. Do not substitute an ETF or futures series for the index without explicitly deciding to do so.

### Preferred initial six-month collection

1. Enumerate the last approximately six months of NSE trading sessions.
2. Retrieve each session's official CM-UDiFF Common Bhavcopy Final ZIP from the NSE historical/current reports archive.
3. Validate date, expected schema, security series and successful ZIP/CSV parsing. Save source URL, file date, checksum and retrieval time.
4. Filter/retain the cash-equity close series for the current NIFTY 50 and NIFTY BANK constituents (de-duplicate overlap).
5. Retrieve the matching NIFTY 50 and NIFTY BANK historical index close series from NSE Indices.
6. Align stock and benchmark observations by trading date and calculate daily returns in Python.
7. Compute rolling beta, regression alpha and relative strength from those aligned daily returns. The initial beta/alpha window discussed is 60 trading sessions; relative strength may use a 20-session excess return.
8. Handle corporate actions / price adjustments consistently before interpreting return statistics. A raw bhavcopy close may be unadjusted around splits, bonuses or other corporate actions; verify and apply appropriate adjustments or flag affected series.

### Important implementation distinction

- **Cash-market CM Bhavcopy:** underlying stock prices used for beta, alpha and relative strength.
- **Index historical data:** benchmark index closes used for stock-vs-index comparisons.
- **Derivatives F&O UDiFF Bhavcopy:** option/futures volume, turnover, OI and contract activity used for liquidity screening.

The standalone HTML file previously created was only a manual-input scoring UI. A proper data-driven prototype should be Python-backed: download/parse these official datasets, calculate the metrics, then render the results in HTML. Do not describe the manual-input prototype as having calculated alpha, beta or liquidity from NSE data.

### Programmatic retrieval caveat

The source datasets and downloadable report paths are published on NSE's website. Before relying on unattended simple `requests` downloads, test the exact historical archive endpoints, response headers, date selection, cookies/session requirements and rate limits. Use ordinary HTTP downloads when they work reliably; do not assume every interactive page's download action is a static public URL.


## Cash-price acquisition strategy: per-symbol first, daily bulk fallback

**Clarification:** We do not automatically need to download six months of daily *cash-market* Bhavcopy files. NSE offers two cash-price retrieval paths, and the smaller targeted path should be tested first for the initial NIFTY 50 + BANK NIFTY F&O universe.

### Option A — NSE Security-wise Price Volume Archive (preferred first test)

Official page: https://www.nseindia.com/report-detail/eq_security

The page supports 1D, 1W, 1M, 3M, 6M, 1Y, 5Y and custom ranges, with CSV download. A symbol is required for multi-day queries.

Proposed collection:
- Build the de-duplicated intersection of current NIFTY 50 / NIFTY BANK constituents and the current F&O-eligible stock universe.
- Fetch a six-month CSV for each required stock symbol.
- Fetch benchmark index histories separately for NIFTY 50 and NIFTY BANK via NSE Indices historical data.
- Normalize and align dates in Python.

This is approximately one historical cash-price request per eligible underlying, rather than one cash Bhavcopy file for every trading date. It is the preferred initial route only if we can automate the site's download reliably and within reasonable rate limits. Test the precise requests/session flow; do not assume the UI's CSV action has a stable unauthenticated endpoint.

### Option B — Daily CM-UDiFF Common Bhavcopy Final (cash-market fallback)

Official page: https://www.nseindia.com/all-reports

Download one CM-UDiFF Common Bhavcopy Final ZIP per trading session, then retain all required underlying symbols from each day's file. Approximately 125–130 daily files for a six-calendar-month period. This is broader than necessary for our initial limited universe but provides a consistent bulk daily snapshot and is a reliable fallback if the per-symbol route cannot be automated.

### Do not confuse cash history and derivatives history

The cash-price collection decision above applies to beta, alpha and relative strength inputs only.

The separate **F&O UDiFF derivatives Bhavcopy** is still the preferred daily bulk source for options contract activity, volume, premium turnover and OI. The six-month derivatives liquidity history is not replaced by downloading one cash-price CSV per stock.

**Implementation decision:** Test NSE Security-wise Archive automation first for cash prices; use daily cash CM-UDiFF bulk files only if necessary. Continue to plan daily F&O derivatives Bhavcopy collection for options-liquidity history.


## Python-backed standalone prototype — implementation update

**Decision:** The scoring test should be a local Python backend with an HTML browser interface, not a static HTML-only calculator with manually typed metric values.

### Verified source endpoints to test from the user's machine

- **NSE cash-equity symbol history:** bootstrap a normal session by visiting `https://www.nseindia.com/report-detail/eq_security`, then request `https://www.nseindia.com/api/historicalOR/generateSecurityWiseHistoricalData` with `from=DD-MM-YYYY`, `to=DD-MM-YYYY`, `symbol=...`, `type=priceVolumeDeliverable`, `series=EQ`, `csv=true`. This returns symbol-specific cash historical CSV data when the session and endpoint allow it.
- **NIFTY index history:** `POST https://www.niftyindices.com/Backpage.aspx/getHistoricaldatatabletoString`; the request body contains a JSON string in `cinfo` with the canonical index name, start date, end date and display index name. Parse the response's `d` value as JSON. Use the Price Return Index series so the benchmark is on a price-return basis consistent with raw cash closing-price returns.
- **NSE F&O daily UDiFF Bhavcopy:** `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip`. Download one ZIP per weekday over the six-month period; weekends/holidays may have no file. Relevant UDiFF columns include `TckrSymb`, `XpryDt`, `StrkPric`, `OptnTp`, `UndrlygPric`, `OpnIntrst`, `TtlTradgVol` and `TtlNbOfTxsExctd`. Exact schema must be validated against actual downloaded files.
- **Current index constituents:** NIFTY 50 `https://www.niftyindices.com/IndexConstituent/ind_nifty50list.csv`; NIFTY BANK `https://www.niftyindices.com/IndexConstituent/ind_niftybanklist.csv`.

These endpoints are published by the respective exchange/index websites, but the HTTP/API routes are not guaranteed as stable public APIs. NSE may require ordinary session cookies, may rate-limit or change formats. Use polite sequential requests and stop/report 403/429/challenge responses. The local prototype does not bypass access controls.

### Local prototype behavior

The standalone Python + HTML artifact is organized as:
- `app.py`: local Flask server / browser API.
- `data_engine.py`: NSE HTTP client, CSV/ZIP parsing, aligned return calculations, option-liquidity calculation and composite score.
- `templates/index.html`: interactive HTML settings, download steps, score controls and ranked results.
- `tests/test_calculations.py`: synthetic calculation/parser tests.
- `README.md` and `run_windows.bat`: setup and local launch.

Workflow: load index constituents → download six-month F&O Bhavcopy and identify constituent symbols with stock-option rows → download six-month cash-price CSVs for that filtered stock list plus benchmark index history → calculate and rank.

The prototype caches downloaded files locally, uses sequential/paced HTTP requests and does not require Angel One credentials or WebSocket subscriptions. It binds only to localhost.

### Calculation and data-integrity controls

- Cash returns are aligned to identical benchmark trading dates. Missing daily stock observations are not converted into multi-day returns paired with one-day index returns.
- Default beta/alpha window: 60 daily return observations; default RS: 20 trading sessions.
- Alpha is an annualized regression intercept with a user-entered constant risk-free-rate assumption; a production Jensen's alpha should use an aligned daily risk-free series.
- Liquidity uses the nearest two unexpired expiries and an ATM-centred strike band; the initial proxy combines 20-session median volume, OI, trade count and active-day share. It does not pretend Bhavcopy supplies bid/ask spread or executable depth.
- The app flags that an F&O Bhavcopy row is not a definitive current eligibility register; verify against the current NSE contract master before production use.
- Corporate-action adjusted-price handling is still an open production requirement. Raw close histories can create false returns around splits/bonuses; extreme moves need review and properly sourced adjustment factors.
- The Python calculation/parser unit tests passed using synthetic fixtures in the build environment. **Live NSE downloads were not verified in that environment** because outbound DNS/network access was unavailable. The first run from the user's computer must validate session behavior, response types, exact UDiFF columns and coverage before trusting outputs.


Prototype build validation note (2 Nov 2026): Python files passed `py_compile`; four synthetic unit tests passed for beta/alpha recovery, bullish-vs-bearish direction handling, UDiFF field parsing and ATM-window liquidity aggregation. The Flask browser route was not exercised in the build container because Flask was not installed there (it is included in `requirements.txt` for local setup). Live NSE HTTP requests were not exercised because outbound DNS/network access was unavailable in the build environment.


## Dynamic / adaptive scoring weights — design proposal

The standalone prototype currently uses **fixed, user-editable weights** (30% beta, 20% alpha, 30% relative strength, 20% liquidity). It does not yet learn weights automatically. The user asked whether weights should be calculated dynamically; this section records the recommended approach for a future prototype iteration.

### Recommended approach: walk-forward predictive weights

Do not change weights arbitrarily based only on the current stock readings. Estimate them from historical evidence about which factors actually ranked subsequent stock performance during comparable index-direction episodes.

For each historical signal date, using only information available on that date:
1. Calculate each stock's trailing beta (e.g. 60 sessions), annualized regression alpha (same regression window), and relative strength (e.g. 20 sessions) against the selected benchmark.
2. Look forward a chosen horizon (initial test: five trading sessions).
3. For a bullish calibration sample, retain historical episodes where the benchmark's subsequent five-session return was positive; for bearish, retain episodes where it was negative.
4. Measure each factor's cross-sectional rank correlation / information coefficient (IC) with the subsequent direction-adjusted stock return across the eligible constituents.
5. Aggregate IC evidence over a rolling training window. Penalize redundant information where alpha and relative strength are highly correlated.
6. Convert stable positive predictive contributions into candidate weights, blend/shrink them toward a conservative baseline, cap individual weights and limit how quickly weights can change.
7. Evaluate the resulting weights on later, untouched dates using walk-forward validation against the fixed baseline. Never use future data to construct the features or train weights for an earlier test date.

### Liquidity should remain a separate tradeability gate

Options liquidity is not simply another return-predicting factor. Keep a minimum options-liquidity qualification threshold and live spread/depth validation separate from the learned beta/alpha/relative-strength weights. A liquid contract is tradable; liquidity by itself does not mean the underlying will outperform. Do not let an illiquid option become eligible because its other scores are high.

### Fallback, sample size and controls

- Use fixed baseline weights when there is insufficient evidence, unstable ICs, missing fields or a poor validation result.
- Six months may be enough to estimate a 60-session beta and 20-session RS, but may be marginal for learning stable weights after the required feature lookbacks and forward-return labels. Show sample size and confidence; do not fabricate adaptive weights when evidence is weak.
- Consider collecting 12 months for adaptive calibration if six months produces too few independent signal episodes. This does not change the initial six-month data-download preference for the first static metric experiment.
- Re-estimate on a controlled schedule (e.g. weekly after the completed session), not every screen refresh or every intraday tick.
- Display the current weights, training period, number of signal dates, factor ICs, fallback status and last update time so the user can audit why weights changed.

### Proposed UI modes

1. **Fixed / Manual:** user can experiment with explicit weights.
2. **Adaptive / Walk-forward:** Python estimates weights from historical predictive evidence, with shrinkage and out-of-sample checks; falls back to fixed weights when sample quality is inadequate.

**Decision:** Do not silently replace the existing fixed formula. Add adaptive weights as an explicit opt-in mode after the historical training panel and walk-forward validation are implemented and tested.
