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
