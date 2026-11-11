**Status:** Approved
**Date:** 2026-11-11
**Author:** David Hargitai
**Version:** 1.11
**Source PRD:** PRD-v1.2

# Implementation Tasks: Multi-tenant Webhook Delivery Platform

Legend: ✅ done (acceptance criteria pre-checked), ⬜ to do. Status was verified against the code on 2026-11-11, not taken from the PRD's phase checkmarks.

## 1. Global Project Context

- **Internal services (exist):** `api` (public REST API), `relay` (outbox relay, Postgres to RabbitMQ), `dispatcher` (fans each event out into delivery jobs), `mock-receiver` (customer endpoint stand-in), `ops` (migrate and seed commands).
- **New services:** `worker` (delivery worker, NestJS), `gateway` (dashboard gateway, NestJS with Socket.IO), `dashboard` (React UI with TanStack Query, Redux, Redux-saga, TanStack Virtual).
- **Shared libraries:** `domain`, `core` (deep modules), `messaging`, `observability`. Package scope `@wdp/*`, Bun workspaces, Node 24.
- **Databases:** Postgres (config, tenants, endpoints, subscriptions, and the `events` table that doubles as the outbox), MongoDB (attempt log, 30-day TTL), Redis (rate limits, breaker state, limiter state).
- **Messaging:** RabbitMQ with quorum queues, TTL plus dead-letter tier queues, publisher confirms and manual acks.
- **External dependencies:** none required; the mock receiver replaces real customer endpoints.
- **Ecosystem placement:** a standalone repository; other portfolio projects do not import from it.
- **Architecture:** tenant system, `POST /v1/events`, Postgres outbox, relay, events exchange, dispatcher, fresh lane queues, worker, signed POST to the receiver. Failures go through retry tier queues, then `retry.ready`, then the DLQ. Attempt summaries flow to the gateway and the dashboard.

## 2. Feature Summary

Tenants publish events through a public REST API, and the platform delivers every accepted event at least once, as a signed HTTP request, to each subscribed endpoint. It adds retries with exponential backoff and jitter, circuit breaking, per-endpoint and per-tenant limits, SSRF protection, secret encryption and rotation, replay, and a dashboard with a live delivery log. The MVP is a thin vertical slice demoed at hundreds of events per second.

## 3. Global Prerequisites (If any)

- Docker with Compose, for the stack and for Testcontainers.
- `SECRETS_KEK_V1`: a base64 32-byte key, needed from Task 22.
- `TIME_SCALE` (default 1, demo 30, tests 1000), needed from Task 16.
- A JWT signing secret shared by `api` and `gateway`, from Task 38. The PRD does not name it; add it to `.env.example`.
- A MongoDB container in the integration test setup (it starts only Postgres, Redis and RabbitMQ today), from Task 15.
- Locked PRD parameters (section 6) must not change without asking.

## 4. Task Breakdown

### Phase 1: Foundation and atomic ingestion (done)

### Task 1: Platform foundation ✅

**Original Story:** Technical (no numbered story)
**Scope:** `ops`, Compose, migrations
**Blocked by:** None

**What to build:**
A Compose stack with Postgres, Mongo, Redis and RabbitMQ, versioned SQL migrations, and seeding of tenants and API keys (`whk_<prefix>_<secret>`).

**Acceptance Criteria:**

- [x] `docker compose up` starts the stack and applies migrations
- [x] A seed command creates a tenant and prints an API key once
- [x] API keys are stored as a prefix plus a SHA-256 hash and verified in constant time

### Task 2: Event ingestion with idempotency ✅

**Original Story:** 1, 2, 16
**Scope:** `api`, `core`, Postgres
**Blocked by:** Task 1

**What to build:**
`POST /v1/events` stores one `events` row (idempotency store and outbox) and returns `202 {event_id}`.

**Acceptance Criteria:**

- [x] A new key inserts the event and returns `202`
- [x] The same key and same request hash returns the original `event_id`
- [x] The same key with a different body returns `422`
- [x] Concurrent requests with the same key create one event

### Task 3: Per-tenant ingest rate limit ✅

**Original Story:** 18
**Scope:** `api`, `core`, Redis
**Blocked by:** Task 2

**What to build:**
A Redis token bucket per tenant (100/s sustained, burst 200) on ingestion.

**Acceptance Criteria:**

- [x] Requests over the limit return `429` with `Retry-After`
- [x] One tenant's flood does not consume another tenant's budget

### Task 4: Endpoint and subscription management ✅

**Original Story:** 3, 6 (partly: HTTPS, port and userinfo rules)
**Scope:** `api`, Postgres
**Blocked by:** Task 1

**What to build:**
Create, list, get and delete for endpoints, and replacing and listing their event-type subscriptions, validated at registration. There is no update route: an endpoint's URL, description and `status` (`active`/`disabled`) cannot be changed through the API yet (see Task 40).

**Acceptance Criteria:**

- [x] An endpoint can be registered and subscribed to event types
- [x] Invalid URLs are rejected at registration
- [x] Tenants cannot see each other's endpoints

### Task 5: Outbox relay ✅

**Original Story:** 16
**Scope:** `relay`, `messaging`
**Blocked by:** Task 2

**What to build:**
Poll unpublished rows in batches with `SKIP LOCKED`, publish with confirms, then mark `published_at`.

**Acceptance Criteria:**

- [x] A crash between publish and mark causes a republish, never a loss
- [x] Two relays do not take the same rows
- [x] No false "published" when nothing receives the event

### Task 6: Dispatcher fan-out onto lanes ✅

**Original Story:** 17 (lane sharding only)
**Scope:** `dispatcher`, `core`, `messaging`
**Blocked by:** Tasks 4, 5

**What to build:**
Fan each event out into one delivery job per subscribed endpoint, sharded onto fresh lane queues by endpoint. Subscribers are read from Postgres on every event; the PRD's Redis subscription cache is not built and has no task (a scale-up path). A failed dispatch is retried through a retry queue and dead-lettered only once its attempts run out (Task 47).

**Acceptance Criteria:**

- [x] One job per subscribed endpoint on the right lane
- [x] Job ids are stable across redelivery (`delivery_id = hash(event_id, endpoint_id)`)
- [x] Failed and malformed events are dead-lettered

### Task 7: Mock receiver ✅

**Original Story:** Technical
**Scope:** `mock-receiver`
**Blocked by:** Task 1

**What to build:**
A customer endpoint stand-in with configurable failure rate, status, latency and hang, plus stats.

**Acceptance Criteria:**

- [x] Query parameters set the behaviour and bad values return `400`
- [x] `GET /stats` counts deliveries per `webhook-id`

### Phase 2: Delivery, retries and DLQ

### Task 47: Fix: transient dispatch failures are retried, not dead-lettered ✅

**Original Story:** 16 (at-least-once delivery of every accepted event)
**Scope:** `dispatcher`, `core`, `messaging`
**Blocked by:** None (do it first in Phase 2, on a `fix/` branch)

**What to build:**
Today any dispatch failure, including one job whose publish confirm timed out, rejects the event message without requeue. That sends the whole event to the DLQ although it is already marked published and some of its jobs may already be queued, so nothing recovers it without a manual replay. Transient failures (a publish error or confirm timeout, a subscription lookup error) must instead be retried with a pause, re-handling the whole event: job ids are deterministic, so the jobs that already went out come out again with the same ids. Only messages that no retry can fix (malformed bodies) go to the DLQ at once. A failure that persists past a bound still ends in the DLQ with its reason rather than looping forever.

Broker behaviour, measured on RabbitMQ 4.4.0 with this project's queue arguments (delivery limit 5): `nack` with requeue never counts toward the delivery limit (30 of 30 deliveries, nothing dead-lettered), while `reject` with requeue does (6 deliveries, then the DLQ). Both redeliver at once, with no pause. So neither requeue alone gives the pause, and `nack` gives no bound either. Before 4.3 every return counted toward the limit, and Compose and the tests use the floating `rabbitmq:4` tag, so the image must be pinned to 4.4 for this behaviour to hold.

**Acceptance Criteria:**

- [x] An event whose first dispatch hits a transient publish failure is dispatched to every subscribed endpoint without manual action
- [x] Re-handling after a partial failure republishes the already sent jobs with the same `delivery_id`s and adds no extra endpoints' jobs
- [x] Retries pause between attempts and do not spin the consumer
- [x] A malformed event message is still dead-lettered at once
- [x] A failure that persists past the bound ends in the DLQ with its reason
- [x] Compose and the integration tests run the same pinned RabbitMQ version
- [x] The integration test fails against the current code (event dead-lettered on the first transient failure)

### Task 0: Greenfield service setup (worker) ✅

**Original Story:** Infrastructure
**Scope:** `worker`
**Blocked by:** None (blocks every task with `worker` in its scope)

**What to build:**
A minimal worker service accessible in the development environment that returns `200 OK` on `GET /status`. Built as a Nest HTTP app in `apps/worker` and a `worker` Compose service. The route has no `/v1` prefix (that is the public API's), `PORT` defaults to 3001, and it is a liveness check only: it probes no dependency, since the worker has none yet.

**Acceptance Criteria:**

- [x] `GET /status` returns `200 OK` in the development environment

### Task 8: Events retention purge ⬜

**Original Story:** Locked parameter
**Scope:** `core`, Postgres
**Blocked by:** Task 2

**What to build:**
A daily batched purge of published `events` rows older than 30 days.

**Acceptance Criteria:**

- [ ] Published rows older than 30 days are removed in batches
- [ ] Unpublished rows are never removed, whatever their age

### Task 9: Endpoint signing secret ✅

**Original Story:** 4
**Scope:** `api`, Postgres
**Blocked by:** Task 4

**What to build:**
Creating an endpoint generates a `whsec_<base64 of 32 random bytes>` secret and shows it once. The secret is stored in plaintext until Task 22 lands; Task 22 is blocked only by this task, so it can follow straight after. Built as `generateEndpointSecret` in `@wdp/core`, stored in `endpoints.signing_secret` (migration 0004 backfills existing endpoints, so none is without a secret), and returned as `secret` by `POST /v1/endpoints` only. The worker reads it through `EndpointTargetLookup` (Task 14); rotation belongs to Task 29.

**Acceptance Criteria:**

- [x] The creation response contains the secret, and later reads do not
- [x] Each endpoint gets a distinct secret

### Task 10: SignatureService ✅

**Original Story:** 7
**Scope:** `core`
**Blocked by:** None

**What to build:**
`sign(secrets[], id, timestamp, rawBody)` and `verify(...)`: HMAC-SHA256 over `id.timestamp.body`, several signatures during rotation, constant-time compare, 5-minute tolerance.

**Acceptance Criteria:**

- [x] Known vectors match
- [x] A tampered body or an old timestamp fails verification
- [x] A header with several signatures verifies against any matching secret

### Task 11: SafeHttpClient limits ✅

**Original Story:** 25 (part)
**Scope:** `core`
**Blocked by:** None

**What to build:**
`post(url, headers, body) -> Result` with a 3 s connect and 10 s total timeout, no redirects and a 64 KB response cap, classifying outcomes. The limits are constructor options (`connectTimeoutMs`, `totalTimeoutMs`, `maxResponseBytes`), not a `limits` argument. A failed result has a `kind`: `http_error`, `redirect`, `response_too_large` (also for a 2xx), `connect_timeout`, `timeout`, `network_error`, `ssrf_blocked` (added by Task 12) or `invalid_url`; `post` never throws. An optional `lookup` option is the connect-time DNS hook Task 12 plugs into.

**Acceptance Criteria:**

- [x] Timeouts, redirects and oversized responses each produce a distinct failed result
- [x] Only 2xx is a success

### Task 12: Connect-time SSRF guard ✅

**Original Story:** 25
**Scope:** `core`
**Blocked by:** Task 11

**What to build:**
Resolve DNS, check the deny-list (loopback, RFC1918, link-local, CGNAT, IPv6 ULA, mapped IPv4), and pin the IP with correct SNI and Host. A dev-only `SSRF_ALLOW_HOSTS` allowlist stays off in the suite. The guard plugs into `SafeHttpClient` through its `lookup` option; Task 11's tests cover only plain http, so the https path (SNI, `secureConnect`) is tested here. Built as `SsrfGuard` and `isBlockedAddress` in `@wdp/core`: `lookup` resolves, refuses the whole host if any address is blocked, and returns the checked addresses; nothing is cached. Node never calls `lookup` for a host that is already an IP address, so `blockedHostReason` and the client's `hostCheck` option cover those. A refusal is a failed result of kind `ssrf_blocked`. The client also got a `ca` option (extra trusted root, verification stays on), used by the https tests.

**Acceptance Criteria:**

- [x] The suite blocks every deny-list category
- [x] A DNS rebinding case is blocked using a fake resolver
- [x] The connection uses the checked IP

### Task 13: Explained URL rejections at registration ⬜

**Original Story:** 6 (rest)
**Scope:** `api`, `core`
**Blocked by:** Tasks 4, 12

**What to build:**
Registration resolves the host and rejects disallowed targets with a reason.

**Acceptance Criteria:**

- [ ] Registering `https://169.254.169.254/` returns `422 url_not_allowed` naming the reason

### Task 14: First delivery end to end ✅

**Original Story:** 1, 8
**Scope:** `worker`, `core`, `messaging`
**Blocked by:** Tasks 0, 6, 9, 10, 12

**What to build:**
The worker consumes a fresh-lane job, signs it, POSTs it to the receiver through the SafeHttpClient and the SSRF guard (one `SsrfGuard` supplies the client's `lookup` and `hostCheck`, with `SSRF_ALLOW_HOSTS` read by the worker), and acks. `webhook-id` is stable and `webhook-timestamp` is regenerated on every attempt. Built as `DeliveryAttempt` and `EndpointTargetLookup` (the worker's read path to an endpoint's url, secret and status, scoped by tenant) in `@wdp/core`, and `JobMessageHandler` and `WorkerRunner` in `apps/worker`. The `webhook-id` is the `delivery_id`; the body is the envelope `{id: event_id, type, data: payload}`, serialised once, so the signed bytes are the sent bytes. The worker consumes every lane, one channel per lane, with `WORKER_PREFETCH` (20) each. A failed attempt (any non-2xx, timeout or SSRF block) and a job for a missing or disabled endpoint are logged and acked, not retried: Task 18 replaces that branch. A malformed job, or an unexpected error such as a failed endpoint lookup, is dead-lettered by the consumer. Compose gives the worker `SSRF_ALLOW_HOSTS` and the same `depends_on` as the dispatcher.

**Acceptance Criteria:**

- [x] An accepted event reaches the mock receiver with a valid signature
- [x] Every outbound request goes through the SSRF guard; the mock receiver is reachable only through the worker's `SSRF_ALLOW_HOSTS`
- [x] The job is acked only after the attempt is handled
- [x] A later attempt carries the same `webhook-id` and a fresh timestamp

### Task 15: Attempt log in Mongo ⬜

**Original Story:** 9
**Scope:** `worker`, Mongo
**Blocked by:** Task 14

**What to build:**
Write one attempt document per attempt (status, HTTP code, latency, snippet up to 1 KB, error) with the covered compound indexes and a 30-day TTL.

**Acceptance Criteria:**

- [ ] Every attempt is recorded with the PRD fields
- [ ] The indexes and the TTL exist

### Task 16: RetryPolicy ✅

**Original Story:** 21
**Scope:** `core`
**Blocked by:** None

**What to build:**
A pure `next(attempt, rng) -> {action, delay, tier, bucket}` (no `now`: nothing in the result depends on a clock; `attempt` is the 1-based failed attempt): 7 tiers (5 s to 10 h), 3 jitter buckets (0.8x, 1.0x, 1.2x), `TIME_SCALE` with floors, passed as the `timeScale` and `minDelayMs` options.

**Acceptance Criteria:**

- [x] The schedule and jitter bounds are table-tested
- [x] The 8th failed attempt returns `dead`
- [x] The time scale and its floor are applied

### Task 17: Retry tier topology ✅

**Original Story:** 21
**Scope:** `messaging`
**Blocked by:** Task 16

**What to build:**
21 fixed-TTL tier queues that dead-letter into `retry.ready`, with queue names that encode the scaled delay (a floor can give a tier's three buckets the same delay, so identical names are declared once). Also the short delay queue (5 s, scaled) that returns a parked job to its fresh lane, used by Tasks 24 and 27: one per lane, so it can dead-letter by a fixed routing key straight back to that lane. `retry.ready` reuses the existing quorum arguments (delivery limit and dead-letter exchange); the tier and delay queues are quorum queues with a fixed TTL and no delivery limit, since nothing consumes them. Built as `declareRetryTopology` in `@wdp/messaging`, fed from `RetryPolicy.delays()` and `parkDelayMs`; a worker publishes to a queue by name (`retryTierQueue(delay)`, `parkQueue(delay, lane)`) on the default exchange.

**Acceptance Criteria:**

- [x] Against a real broker, a message returns to `retry.ready` after its TTL
- [x] Against a real broker, a parked job returns to its own fresh lane after the delay
- [x] A new `TIME_SCALE` creates new queues instead of failing

### Task 18: Failed attempt becomes a retry, with correct ack order ⬜

**Original Story:** 21, 23
**Scope:** `worker`
**Blocked by:** Tasks 14, 15, 16, 17

**What to build:**
On a failed attempt: log it, publish to the retry tier, wait for the confirm, then ack. This replaces Task 14's branch, which only logs a failed attempt and acks it. The PRD's DeliveryStateMachine (`Delivery.recordAttempt`, states pending, in-flight, succeeded, retrying, dead, and the attempt budget) lands here in `@wdp/domain`, and the job carries its attempt number.

**Acceptance Criteria:**

- [ ] Illegal state transitions are rejected (unit-tested)
- [ ] A failing receiver produces the scheduled attempts
- [ ] A worker killed mid-delivery loses no job and the receiver sees the same `webhook-id`
- [ ] The test fails if the ack happens before the retry publish

### Task 19: Exhausted deliveries land in the DLQ ⬜

**Original Story:** 22
**Scope:** `worker`, `messaging`
**Blocked by:** Task 18

**What to build:**
After the 8th failed attempt, publish the job to the DLQ with the failure reason.

**Acceptance Criteria:**

- [ ] A permanently failing endpoint ends with one DLQ entry carrying the reason
- [ ] An exhausted delivery can be told apart from a dead-lettered event in the shared DLQ

### Task 20: Poison messages ✅

**Original Story:** Technical
**Scope:** `messaging`
**Blocked by:** None (built in Phase 1)

**What to build:**
Quorum queues with `delivery-limit` 5, dead-lettering to the DLQ. Every working queue already gets these arguments, and `retry.ready` (Task 17) inherits them; the TTL queues of Task 17 do not, since nothing consumes them.

**Acceptance Criteria:**

- [x] A message that keeps killing its consumers ends up in the DLQ after the first delivery plus 5 redeliveries
- [x] A message whose handler throws is dead-lettered once instead of looping

### Task 21: Worker graceful shutdown ⬜

**Original Story:** 24
**Scope:** `worker`
**Blocked by:** Task 14

**What to build:**
On SIGTERM, cancel consumers, finish in-flight work within the 30 s grace period, then close the channel.

**Acceptance Criteria:**

- [ ] An in-flight delivery completes and is acked before exit

### Phase 3: Resilience and fairness

### Task 22: Secrets encrypted at rest ⬜

**Original Story:** Security
**Scope:** `core`, `api`, `worker`
**Blocked by:** Task 9

**What to build:**
AES-256-GCM envelope encryption behind a `KeyProvider` port, with the KEK from `SECRETS_KEK_V1` and a 60 s decrypted cache in the worker.

**Acceptance Criteria:**

- [ ] No plaintext secret is stored in Postgres
- [ ] The worker signs correctly using decrypted secrets

### Task 23: CircuitBreaker module ⬜

**Original Story:** 20
**Scope:** `core`, Redis
**Blocked by:** None

**What to build:**
`allow(endpointId)` and `record(endpointId, outcome)`: sliding 60 s window, trip at 50% failures with at least 20 samples, exponential cooldown with jitter, lazy half-open, single probe elected with `SET NX PX`.

**Acceptance Criteria:**

- [ ] Against real Redis, the circuit opens, half-opens with one probe, and closes or reopens
- [ ] A dead probe worker cannot wedge the circuit

### Task 24: Breaker in the worker ⬜

**Original Story:** 20
**Scope:** `worker`
**Blocked by:** Tasks 18, 23

**What to build:**
A denied job is re-parked in the short delay tier without calling the endpoint and without consuming an attempt.

**Acceptance Criteria:**

- [ ] A dead endpoint stops receiving calls once the circuit opens
- [ ] Attempt numbers are not consumed while the circuit is open

### Task 25: EndpointLimiter concurrency cap ⬜

**Original Story:** 19
**Scope:** `core`, Redis
**Blocked by:** None

**What to build:**
`acquire` and `release` of a 20-slot semaphore per endpoint, with 30 s leases so leaked permits recover.

**Acceptance Criteria:**

- [ ] Against real Redis, the 21st concurrent acquire is denied
- [ ] A leaked permit expires

### Task 26: Per-endpoint token bucket ⬜

**Original Story:** 19
**Scope:** `core`, Redis
**Blocked by:** Task 25

**What to build:**
20 requests/s sustained, burst 40, overridable per endpoint.

**Acceptance Criteria:**

- [ ] Requests over the rate are denied
- [ ] A per-endpoint override is honoured

### Task 27: Limiter in the worker ⬜

**Original Story:** 19
**Scope:** `worker`
**Blocked by:** Tasks 18, 26

**What to build:**
Over the cap or rate, park the job in the delay tier without consuming an attempt and without nack-requeue.

**Acceptance Criteria:**

- [ ] A hanging endpoint holds at most 20 slots
- [ ] Other endpoints on the same worker keep delivering

### Task 28: Fresh versus retry consumer split ⬜

**Original Story:** 17
**Scope:** `worker`
**Blocked by:** Task 18

**What to build:**
Fresh-lane consumers use prefetch 20 and the `retry.ready` consumer uses prefetch 5, with fresh traffic prioritised.

**Acceptance Criteria:**

- [ ] With retries backed up, fresh deliveries still meet the first-attempt target

### Task 29: Secret rotation with overlap ⬜

**Original Story:** 5
**Scope:** `api`, `worker`
**Blocked by:** Tasks 10, 22

**What to build:**
Rotate an endpoint's secret with a 24 h overlap in which each request carries two signatures.

**Acceptance Criteria:**

- [ ] During the overlap, verification works with either secret
- [ ] After the overlap, only the new secret is sent

### Task 30: Isolation load test ⬜

**Original Story:** 17
**Scope:** tests, docs
**Blocked by:** Tasks 27, 28

**What to build:**
Run a flooding tenant and a hanging endpoint while measuring other tenants, and record the results. The per-tenant ingest limit (100/s, burst 200) caps a single tenant, so the 500 events/s target needs at least 5 tenants.

**Acceptance Criteria:**

- [ ] Other tenants' p99 first-attempt latency stays within 5 s
- [ ] Sustained ingest of at least 500 events/s is measured and recorded

### Phase 4: Dashboard, observability and demo

### Task 31: Delivery and attempt read API ⬜

**Original Story:** 9, 10
**Scope:** `api`, `core`, Mongo
**Blocked by:** Task 15

**What to build:**
Cursor-paginated lists (default 50, max 200) with filters by endpoint, status and event id, and a CursorCodec.

**Acceptance Criteria:**

- [ ] Keyset pagination returns `hasMore` without a total count
- [ ] A malformed cursor returns `400`
- [ ] A tampered cursor cannot cross tenants
- [ ] Each log query uses an index scan with no sort stage (`explain()`)

### Task 32: Replay API ⬜

**Original Story:** 13
**Scope:** `api`, `worker`
**Blocked by:** Tasks 18, 31

**What to build:**
Replay one delivery or a whole event with the same `webhook-id` and a fresh attempt counter.

**Acceptance Criteria:**

- [ ] A replayed delivery reaches the receiver with the original `webhook-id`
- [ ] The attempt counter restarts, and the replay's attempts stay distinguishable from the original's in the attempt log
- [ ] Replaying an event whose dispatch was dead-lettered fans it out to its current subscribers

### Task 33: Circuit status API ⬜

**Original Story:** 15
**Scope:** `api`, Redis
**Blocked by:** Task 23

**What to build:**
Expose an endpoint's circuit state (closed, open, half-open).

**Acceptance Criteria:**

- [ ] The state matches the breaker state in Redis

### Task 34: Correlation ids in logs ⬜

**Original Story:** 26
**Scope:** all services
**Blocked by:** Task 14

**What to build:**
`event_id`, `delivery_id`, `attempt_no` and `tenant_id` on every log line, in Nest's default Logger. Partly there: the relay and dispatcher log with camelCase keys (`eventId`, `messageId`) and no tenant id, so they need aligning.

**Acceptance Criteria:**

- [ ] One event can be traced across services by `event_id`

### Task 35: Prometheus metrics ⬜

**Original Story:** 27
**Scope:** `observability`, services
**Blocked by:** Tasks 14, 24

**What to build:**
The six PRD metrics, with endpoint ids kept out of the labels. First-attempt latency needs the event's acceptance time, which delivery jobs do not carry yet.

**Acceptance Criteria:**

- [ ] Queue depth, attempt outcomes, and delivery and first-attempt latency are exposed
- [ ] `wdp_breaker_open_endpoints` is exposed

### Task 36: Greenfield service setup (gateway) ⬜

**Original Story:** Infrastructure
**Scope:** `gateway`
**Blocked by:** None

**What to build:**
A minimal gateway service accessible in the development environment that returns `200 OK` on `GET /status`.

**Acceptance Criteria:**

- [ ] `GET /status` returns `200 OK` in the development environment

### Task 37: Live attempt feed ⬜

**Original Story:** 12
**Scope:** `worker`, `gateway`
**Blocked by:** Tasks 14, 36, 38

**What to build:**
Workers publish attempt summaries to a topic exchange. The gateway binds per connected tenant, batches with `bufferTime(250 ms, max 100)` and pushes over Socket.IO to a `tenant:<id>` room taken from the token.

**Acceptance Criteria:**

- [ ] A connected tenant receives its own attempts live
- [ ] A tenant never receives another tenant's attempts

### Task 38: Dashboard auth ⬜

**Original Story:** Security
**Scope:** `api`, `ops`
**Blocked by:** Task 1

**What to build:**
A seeded user per tenant with an `scrypt` password hash and a 1 h JWT, issued by `api`. The API accepts the JWT as well as an API key on the routes the dashboard uses (today every route accepts only API keys), and the gateway verifies the same token.

**Acceptance Criteria:**

- [ ] Login returns a token valid for 1 h
- [ ] The endpoint, delivery, attempt and replay routes accept the token and scope it to its tenant
- [ ] The socket handshake needs the token and takes the tenant from its claim

### Task 39: Greenfield service setup (dashboard) ⬜

**Original Story:** Infrastructure
**Scope:** `dashboard`
**Blocked by:** Task 38

**What to build:**
A minimal React app accessible in the development environment where a seeded user can log in.

**Acceptance Criteria:**

- [ ] The app loads and a seeded user can log in

### Task 40: Dashboard: endpoint and subscription CRUD ⬜

**Original Story:** 3
**Scope:** `dashboard`, `api`
**Blocked by:** Task 39

**What to build:**
Screens to create, list, edit and delete endpoints and subscriptions. Editing needs a new API update route for an endpoint's description and `status` (Task 4 has none).

**Acceptance Criteria:**

- [ ] A user can manage endpoints and subscriptions without the API directly
- [ ] Disabling an endpoint stops new deliveries to it

### Task 41: Dashboard: delivery log ⬜

**Original Story:** 10, 11
**Scope:** `dashboard`
**Blocked by:** Tasks 31, 39

**What to build:**
A virtualized, infinite-scroll log with filters by endpoint, status and event id.

**Acceptance Criteria:**

- [ ] Large histories scroll without freezing
- [ ] Filters narrow the log

### Task 42: Dashboard: live "N new" pill ⬜

**Original Story:** 12
**Scope:** `dashboard`
**Blocked by:** Tasks 37, 41

**What to build:**
New attempts appear live as a pill that preserves scroll position and prepends on click.

**Acceptance Criteria:**

- [ ] The pill shows the count and clicking it prepends the new attempts
- [ ] The scroll position is kept

### Task 43: Dashboard: replay and cancellable bulk replay ⬜

**Original Story:** 13, 14
**Scope:** `dashboard`
**Blocked by:** Tasks 32, 41

**What to build:**
A replay button per delivery or event, and a bulk replay driven by Redux-saga that can be cancelled.

**Acceptance Criteria:**

- [ ] One click replays a failed delivery
- [ ] Cancelling a bulk replay stops further replays

### Task 44: Dashboard: circuit status ⬜

**Original Story:** 15
**Scope:** `dashboard`
**Blocked by:** Tasks 33, 40

**What to build:**
Show each endpoint's circuit status.

**Acceptance Criteria:**

- [ ] The status is visible and updates as the circuit changes

### Task 45: Fault-injection correctness run ⬜

**Original Story:** PRD success criterion
**Scope:** tests
**Blocked by:** Tasks 20, 21, 24, 27, 47

**What to build:**
Run at least 10,000 events through fault injection (killed workers and a failing receiver) and assert the counts.

**Acceptance Criteria:**

- [ ] Zero lost events
- [ ] Zero duplicate dispatches, apart from documented at-least-once repeats

### Task 46: Scripted three-scene demo and results ⬜

**Original Story:** PRD success criteria
**Scope:** docs, tests
**Blocked by:** Tasks 30, 35, 42, 43, 44, 45

**What to build:**
The demo script (retries and breaker, killed worker, duplicate `Idempotency-Key`), the README results table, and saved `explain()` outputs.

**Acceptance Criteria:**

- [ ] All three scenes run from a clean `docker compose up`
- [ ] The results table holds measured numbers
- [ ] A scale-up path is written for each simplification
