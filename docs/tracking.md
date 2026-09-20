# Vessel tracking

How a consignment's ship gets onto the dashboard map, what it costs, what it cannot do, and what has to be decided before real customers see live positions. The build history and the reasons for each choice are in `docs/build-log.md` (UI-3).

## How it fits together

1. **A person enters the ship.** A consignment can carry a vessel name, an IMO number and an MMSI, each optional. They are typed in on the New Consignment form, or set later with `PATCH /consignments/:id/vessel` (either party, or superadmin, audited). The IMO must be seven digits and pass the check digit; the MMSI must be exactly nine digits; anything else is a 422. Reading them from a bill of lading is a later stage.
2. **One job asks a provider.** The refresh job (`src/tracking/refresh.ts`) is the only code that calls a position provider. It runs on a schedule and can be triggered by a superadmin with `POST /admin/positions/refresh`. It picks vessels on live consignments whose latest position is old enough to be worth refreshing, asks in as few calls as the provider allows, validates what comes back and stores it in `vessel_positions` (72 hours kept, duplicates ignored).
3. **Everything else reads our own database.** `GET /positions`, `GET /consignments/:id/position` and the dashboard never reach a provider. Opening the dashboard, refetching every minute, or reloading the page cannot cost a call. This is tested, not assumed.
4. **The browser never calls a provider,** and the provider key exists only in the backend's environment.

## The provider interface

`VesselPositionProvider` (`src/tracking/provider.ts`): `planRequests(identifiers)` splits identifiers into the requests the provider would make (each inner list is exactly one billable call, so calls can be counted before any is spent), and `fetchPositions(group, context)` makes one request and returns normalised positions: `{ imo?, mmsi?, lat, lng, speedKnots?, headingDeg?, navStatus?, positionTime, source }`.

Every position is validated: latitude within -90 and 90, longitude within -180 and 180, a readable time not more than a minute in the future, and a usable identifier. A bad position is dropped and only the count is logged. An optional field out of range (a negative speed, a heading of 511, which AIS uses for "not available") is left out and the position kept.

Two providers exist. **`sample`** (the default everywhere) makes up deterministic positions along sea routes, tags every one `sample`, calls nothing and costs nothing. **`vesselapi`** calls VesselAPI (https://vesselapi.com) using its batch endpoint `GET /vessels/positions` (many vessels per call), or, if `VESSELAPI_LOOKUP=single`, `GET /vessel/{id}/position`. Other sources (AISStream over WebSocket, Datalastic, VesselFinder) can be added by implementing the interface. None is built.

## Configuration

Set these in the backend's `.env` (never in the frontend, and never commit a key). `.env.example` lists them all with the key blank.

| Variable | Default | What it does |
|---|---|---|
| `AIS_PROVIDER` | `sample` | `sample` or `vesselapi`. |
| `AIS_LIVE_ALLOWED` | `false` | A live provider refuses to start unless this is exactly `true`. It exists so nobody switches on live data for paying customers by accident. |
| `VESSELAPI_KEY` | none | The VesselAPI key. Sent only as a Bearer header. Required for `vesselapi`. |
| `VESSELAPI_MONTHLY_BUDGET` | `150` | Calls allowed per calendar month (UTC) on the plan. |
| `VESSELAPI_RESERVE` | `15` | Calls held back for manual use. Scheduled runs never spend them. |
| `TRACKING_REFRESH_INTERVAL_MINUTES` | `720` | How often the scheduled refresh runs (12 hours). |
| `TRACKING_REFRESH_MIN_INTERVAL_MINUTES` | `60` | The floor under it: the job is never run more often, even across restarts. |
| `TRACKING_RECENT_MAX_AGE_SECONDS` | `7200` | A position this old or younger is "recent"; older is "stale". |
| `TRACKING_MIN_POSITION_AGE_MINUTES` | `720` | A vessel whose latest position is younger than this is not asked about again. |
| `VESSELAPI_LOOKUP` | `batch` | `batch` or `single`. |
| `VESSELAPI_BATCH_SIZE`, `VESSELAPI_WINDOW_HOURS`, `VESSELAPI_TIMEOUT_MS`, `VESSELAPI_BASE_URL` | 20, 24, 10000, VesselAPI's | Tuning. |
| `TRACKING_REFRESH_ENABLED` | `true` | Set `false` to stop the server starting the scheduled job. |

## The call budget

The free plan allows 150 calls a month and the provider's own rule for failed calls is not certain, so **every call is counted, failed ones included**. Before every call the ledger (`provider_calls`) counts this month's calls and refuses unless `used + 1 + reserve <= budget`; with the defaults at most 135 automatic calls a month. The row is written before the request is sent, under a lock, so a crash or two callers at once cannot overspend. A manual refresh may use the reserve but never passes the budget. A 429 sets a back-off (15 minutes, doubling, capped at 6 hours, or the `Retry-After` if longer) that survives a restart. A scheduled run may spend at most today's share: (budget, less the reserve, less what was used before today) divided by the days left in the month. A log warning appears from 80 percent. `GET /admin/tracking/budget` (superadmin) shows calls used, the budget, the reserve, what is left, any back-off, and when the last refresh ran.

With four demo vessels the job asks for all of them in one batch call, at most about twice a day, so the plan is not at risk; the UI shows the true age of every position.

## What the map shows

A vessel with a **recent** position is a normal marker; a **stale** one (older than the threshold) is a hollow dashed marker; one with **no position** has no marker, and the info line says "No vessel identifier on this consignment" or "No position received yet". Each vessel's own trail of the last 24 hours is drawn as a thin line. There is no planned route, because the backend has no port or route data. The flag on the map says "Sample positions" whenever any drawn position is made-up, and "Live AIS" only when a real drawn position is recent; stale positions are "Last known positions", never live.

## Coverage limits

- **Terrestrial AIS reaches roughly 40 to 60 km offshore.** Free and low-cost feeds are mostly land receivers, so a ship in mid-ocean often has no recent position. That is a property of the data, not a fault, and the app says "no recent position" rather than guessing. VesselAPI's data is described as terrestrial; its satellite fallback (`filter.sat`) spends separate paid credits and is **never requested** by this app.
- **A position is only as fresh as the last refresh.** On the free plan a vessel is refreshed at most a couple of times a day, so a position can be hours old by design.
- The batch endpoint only looks back over `VESSELAPI_WINDOW_HOURS` (default 24); the single-vessel endpoint looks back up to 80 hours. Older than that, there is nothing to show.
- Sample positions are not real ships. The seed's vessels use numbers that cannot belong to a real ship.

## Before live data is turned on for customers

These are decisions, not code:

1. **Terms.** The free plan is for evaluation. No commercial-use terms were found in VesselAPI's public documentation, so they are **unconfirmed**. Confirm the terms of whichever plan is chosen before any paying customer sees live data.
2. **A paid plan or another licensed provider.** 150 calls a month is a demo tier. Basic (1,500 a month) and above are listed; whichever is chosen, set `VESSELAPI_MONTHLY_BUDGET` to match.
3. **Satellite coverage.** Decide whether customers need positions in mid-ocean. It is where the cost is, and it is not built.
4. **Verify how a batch is counted.** The documentation does not say whether one batch call counts as one call or one per vessel, what the batch endpoint returns per vessel, or its maximum number of ids. Make one manual refresh and compare VesselAPI's own usage counter with `GET /admin/tracking/budget`. If a batch of N counts as N, set `VESSELAPI_BATCH_SIZE=1`.
5. **Freight forwarders.** The importing and the exporting organization (and superadmin) may enter the vessel. A forwarder may not yet: forwarders are linked to no consignment, so they cannot see one. Giving them access needs a designed way to attach a forwarder to a consignment (who attaches it, and how it is removed), which changes what they can see across the app.
6. **Where the key lives.** A `.env` file is fine for evaluation; production needs a secret manager. Real sign-in must exist before any customer uses the app.
7. **Turning it on deliberately.** Set `AIS_PROVIDER=vesselapi`, `VESSELAPI_KEY` and `AIS_LIVE_ALLOWED=true` on a machine that is meant to make live calls, and nowhere else.
8. **The map's tile provider** (a separate decision): CARTO's public tiles currently return a watermark asking for a key.
