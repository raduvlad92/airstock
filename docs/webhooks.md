# Webhooks

Airstock sends events to your own systems, such as an n8n workflow, right after a change is saved. Each shop chooses its own subscriptions: a URL, the event types it wants, and optional filters. Nothing is sent for a change that did not commit.

Decision: [Phase 2 plan, D14 and Section 5.13](phase-2-build-plan.md#513-webhooks). Architecture: [ADR 0023](adr/0023-outgoing-webhooks.md).

## Contents

1. [Setting up a webhook](#setting-up-a-webhook)
2. [What a delivery looks like](#what-a-delivery-looks-like)
3. [Verifying the signature](#verifying-the-signature)
4. [The n8n recipe](#the-n8n-recipe)
5. [Duplicates and order](#duplicates-and-order)
6. [Retries, failures, and replays](#retries-failures-and-replays)
7. [Where a webhook may point](#where-a-webhook-may-point)
8. [Event catalog](#event-catalog)
9. [The API](#the-api)
10. [Adding an event type](#adding-an-event-type)

## Setting up a webhook

In the dashboard: **Integrations → Webhooks → Add webhook**.

- **Name:** what receives it, for example "n8n stock flow".
- **URL:** an HTTPS address on a public host, such as the production URL of an n8n Webhook node.
- **Events:** tick the event types to receive. The list comes from the event catalog below.
- **Locations:** optional. Limit stock events to some warehouses or locations; a warehouse covers every location inside it. Event types without locations, such as `catalog.item.changed`, are always sent.
- **Alert kinds:** optional, shown once alert events exist.

Creating the webhook shows its **signing secret once**. Copy it into the receiving system. **Rotate secret** makes a new one; for the overlap you choose (24 hours by default), deliveries carry signatures from both secrets, so you can switch the receiver over without missing an event.

**Send test** sends `webhook.test`, or the sample payload of any event type the webhook receives, and adds it to the delivery log.

Who can do this: owners and managers (`webhooks.manage`). A member limited to some locations must limit their webhooks to those locations, and sees only such webhooks. Over the API, a credential needs the `webhooks:manage` scope. AI assistants connected over MCP cannot see or change webhooks: a webhook sends shop data out of Airstock, so only people decide where it goes.

## What a delivery looks like

One `POST` per event and subscription, with a JSON body:

```json
{
  "id": "0193a1b2-0000-7000-8000-0000000000ff",
  "type": "stock.changed",
  "created_at": "2026-11-16T09:00:00.000Z",
  "shop_id": "0193a1b2-0000-7000-8000-000000000001",
  "api_version": "v1",
  "data": { "...": "the event's snapshot, see the catalog" }
}
```

- `id`: the event ID. The same on every retry and replay of this event.
- `type`: the event type.
- `created_at`: when the change was saved.
- `api_version`: `v1`. A change that could break a consumer gets a new version.
- `data`: a snapshot complete enough to act on without calling Airstock back. Snapshots carry versions (for example a position's `version`), so you can drop an update older than one you already have.
- `test: true` appears only on deliveries sent by **Send test**.

Headers:

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `User-Agent` | `Airstock-Webhooks/1` |
| `Airstock-Event-Id` | The event ID, as in the body |
| `Airstock-Event-Type` | The event type |
| `Airstock-Delivery-Id` | This delivery; a replay has a new one |
| `Airstock-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |
| `Airstock-Test` | `1` on test deliveries only |

Answer with any `2xx` status within 10 seconds. Anything else, a redirect, or no answer counts as a failure and is retried.

## Verifying the signature

`Airstock-Signature` is `t=<unix seconds>,v1=<signature>`, where the signature is the hex HMAC-SHA256 of the string `<t>.<raw body>`, keyed with the whole secret (`whsec_…`) as UTF-8. During a rotation there are two `v1` values, newest first.

To check a delivery:

1. Split the header on commas; take `t` and every `v1`.
2. Refuse it if `t` is more than 5 minutes from your clock (a replayed old request).
3. Compute the HMAC of `` `${t}.${rawBody}` `` with each secret you hold, and accept it if any `v1` matches. Compare in constant time.
4. Use the **raw** body as received. Parsing and re-serializing JSON can change the bytes.

In Node.js:

<!-- node-snippet:start -->
```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyAirstock(header, rawBody, secrets, toleranceSeconds = 300) {
  let t = 0;
  const signatures = [];
  for (const part of String(header ?? '').split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't') t = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!t || signatures.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  return secrets.some((secret) => {
    const expected = Buffer.from(
      createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'),
    );
    return signatures.some(
      (s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), expected),
    );
  });
}
```
<!-- node-snippet:end -->

## The n8n recipe

1. Add a **Webhook** node: HTTP method `POST`, **Respond** `Immediately`, and under **Options** turn on **Raw Body**, so the node keeps the exact bytes Airstock signed. Use the node's **production URL** as the webhook URL in Airstock.
2. Add a **Code** node after it (mode "Run Once for All Items") with the code below. Put your secret in `SECRETS`; during a rotation, list both secrets until the old one expires. On self-hosted n8n, allow the crypto module with the environment variable `NODE_FUNCTION_ALLOW_BUILTIN=crypto`.
3. Optionally add a **Remove Duplicates** node set to "Remove items processed in previous executions", comparing `{{ $json.id }}`, so a retried or replayed event is acted on once.

<!-- n8n-snippet:start -->
```js
// Airstock webhook check for an n8n Code node ("Run Once for All Items").
const crypto = require('crypto');

// Your signing secrets. During a rotation, keep both until the old one expires.
const SECRETS = ['whsec_paste_your_secret_here'];
// Refuse deliveries signed more than 5 minutes ago (or ahead).
const TOLERANCE_SECONDS = 300;

const out = [];
for (const [i, item] of $input.all().entries()) {
  // The exact bytes Airstock signed: the Webhook node's Raw Body option keeps them as binary.
  const raw = item.binary?.data
    ? (await this.helpers.getBinaryDataBuffer(i, 'data')).toString('utf8')
    : JSON.stringify(item.json.body);
  const header = String(item.json.headers?.['airstock-signature'] ?? '');
  let t = 0;
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key === 't') t = Number(value);
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!t || signatures.length === 0) throw new Error('No Airstock signature.');
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE_SECONDS) {
    throw new Error('The Airstock signature is too old.');
  }
  const valid = SECRETS.some((secret) => {
    const expected = Buffer.from(
      crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex'),
    );
    return signatures.some(
      (s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), expected),
    );
  });
  if (!valid) throw new Error('The Airstock signature does not match.');
  // The verified event: id, type, created_at, shop_id, api_version, data.
  out.push({ json: JSON.parse(raw) });
}
return out;
```
<!-- n8n-snippet:end -->

Without **Raw Body**, the code falls back to re-serializing the parsed body. That matches Airstock's bytes for its payloads today, but the raw body is the dependable choice.

## Duplicates and order

- **Deduplicate by `id`.** Delivery is at least once: a retry after a lost answer, or a replay you started, sends the same event `id` again. Treat a second delivery of an `id` you already processed as done.
- **Order is not guaranteed.** Events can arrive out of order, especially after a retry. Snapshots carry versions: for `stock.changed`, keep the highest `version` per `positionId` and ignore older ones.

## Retries, failures, and replays

- **Timeout:** 10 seconds. Redirects are not followed. Airstock keeps at most the first 1 KB of your response body, for the delivery log.
- **Retries:** a failed delivery is tried again after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours, 12 hours, and 24 hours: eight attempts over about 45 hours. Then it is marked **failed**.
- **Auto-disable:** if every delivery to a webhook fails for 3 days, Airstock turns the webhook off and emails the shop's owners. Its pending retries are cancelled. Turn it back on from the dashboard, then replay what it missed.
- **Replay:** the **Replay** button in the delivery log (or the API) sends the same event again, with the same `id`, as a new delivery with its own retries.
- **Delivery log:** every delivery with its status, attempts, last response code, and the start of the last response. Kept for 30 days.
- **History:** each delivery attempt's outcome is an entry in the activity history (action `webhook.delivery`, by the system, source `webhooks`), and so is every change to a webhook's settings. The secret never appears in either.

## Where a webhook may point

- HTTPS only, and no user name or password before the host name.
- Not an IP address in a private, loopback, link-local, shared, documentation, multicast, or reserved range (for example `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `192.168.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`).
- Not an internal host name: `localhost`, names ending in `.localhost`, `.local`, `.internal`, `.home.arpa`, or `.localdomain`, or a name without a dot.

The rules are checked when a webhook is saved and again before every delivery.

## Event catalog

Each type lists the permission the person subscribing must hold (the events carry those fields), the filters that apply, and a sample envelope. The dashboard and `GET /api/v1/shops/{shopId}/webhook-event-types` show the same list.

<!-- event-catalog:start (generated by `pnpm webhooks:docs`; do not edit) -->

### `stock.changed`

Stock that can be sold changed: one event per operation (receipt, reservation, release, fulfillment, expiry, import, and the stock commands to come), naming every position it changed with SKU, location, lot or serial, on hand, reserved, available, and the position version.

- **Needs:** `inventory.read` (held by whoever subscribes)
- **Filters:** warehouses and locations

```json
{
  "id": "0193a1b2-0000-7000-8000-0000000000ff",
  "type": "stock.changed",
  "created_at": "2026-11-16T09:00:00.000Z",
  "shop_id": "0193a1b2-0000-7000-8000-000000000001",
  "api_version": "v1",
  "data": {
    "reason": null,
    "positions": [
      {
        "positionId": "0193a1b2-0000-7000-8000-000000000030",
        "variantId": "0193a1b2-0000-7000-8000-000000000011",
        "productId": "0193a1b2-0000-7000-8000-000000000010",
        "sku": "ETB-PRE-01",
        "name": "Prismatic Evolutions Elite Trainer Box",
        "location": {
          "id": "0193a1b2-0000-7000-8000-000000000021",
          "name": "A1",
          "path": "Main warehouse/A1",
          "warehouseId": "0193a1b2-0000-7000-8000-000000000020"
        },
        "condition": "sellable",
        "lotId": null,
        "lotCode": null,
        "expiresOn": null,
        "serialId": null,
        "serial": null,
        "onHand": "12",
        "reserved": "3",
        "available": "9",
        "version": 7
      }
    ],
    "truncated": false
  }
}
```

### `catalog.item.changed`

A product or variant was created, changed, archived, or restored: one event per command, naming each record with its SKU, name, price, status, and version.

- **Needs:** `catalog.read` (held by whoever subscribes)
- **Filters:** none (always sent)

```json
{
  "id": "0193a1b2-0000-7000-8000-0000000000ff",
  "type": "catalog.item.changed",
  "created_at": "2026-11-16T09:00:00.000Z",
  "shop_id": "0193a1b2-0000-7000-8000-000000000001",
  "api_version": "v1",
  "data": {
    "operation": "catalog.items.update",
    "items": [
      {
        "change": "updated",
        "product": {
          "id": "0193a1b2-0000-7000-8000-000000000010",
          "name": "Prismatic Evolutions Elite Trainer Box",
          "status": "active",
          "version": 3
        },
        "variant": {
          "id": "0193a1b2-0000-7000-8000-000000000011",
          "sku": "ETB-PRE-01",
          "name": null,
          "price": "59.990000",
          "status": "active",
          "version": 4
        }
      }
    ],
    "truncated": false
  }
}
```

### `job.completed`

An import or export finished, successfully or not, with its counts or row total. Download an export through the API or the dashboard.

- **Needs:** `shop.read` (held by whoever subscribes)
- **Filters:** none (always sent)

```json
{
  "id": "0193a1b2-0000-7000-8000-0000000000ff",
  "type": "job.completed",
  "created_at": "2026-11-16T09:00:00.000Z",
  "shop_id": "0193a1b2-0000-7000-8000-000000000001",
  "api_version": "v1",
  "data": {
    "job": {
      "kind": "import",
      "id": "0193a1b2-0000-7000-8000-000000000040",
      "status": "completed",
      "createdAt": "2026-11-16T09:00:00.000Z",
      "completedAt": "2026-11-16T09:00:12.000Z",
      "error": null,
      "fileName": "products.csv",
      "rows": null,
      "counts": {
        "done": 300,
        "failed": 0,
        "skipped": 0,
        "stock_failed": 0
      }
    }
  }
}
```

### `webhook.test`

Sent by "Send test" in the dashboard or the API, to check the endpoint.

- **Needs:** `webhooks.manage` (held by whoever subscribes)
- **Filters:** none (always sent)

```json
{
  "id": "0193a1b2-0000-7000-8000-0000000000ff",
  "type": "webhook.test",
  "created_at": "2026-11-16T09:00:00.000Z",
  "shop_id": "0193a1b2-0000-7000-8000-000000000001",
  "api_version": "v1",
  "data": {
    "message": "Test event from Airstock.",
    "subscription": {
      "id": "0193a1b2-0000-7000-8000-000000000050",
      "name": "n8n stock flow"
    }
  }
}
```

### Coming with later milestones

Registered, listed by the API with `"status": "coming"`, hidden in the dashboard, and refused when subscribing until the milestone that emits them ships. The samples show the planned shape.

| Type | Description | Filters |
| --- | --- | --- |
| `alert.opened` | An alert opened, such as low stock or a lot nearing expiry (I3). | warehouses and locations, alert kinds |
| `alert.resolved` | An alert resolved because stock recovered, or was acknowledged (I3). | warehouses and locations, alert kinds |
| `reservation.shortage` | A connector order was reserved with a shortage it could not cover (I1). | warehouses and locations |
| `transfer.status_changed` | A transfer moved to another state, such as dispatched or received (I2). | warehouses and locations |
| `purchase_order.status_changed` | A purchase order moved to another state, such as sent or received (I3). | warehouses and locations |
| `return.status_changed` | A return moved to another state, such as received or inspected (I2). | warehouses and locations |
| `shopify.sync_conflict` | Shopify and Airstock disagree on a quantity or field that no order explains (I6). | warehouses and locations |

<!-- event-catalog:end -->

## The API

All under `/api/v1/shops/{shopId}`, with the `webhooks.manage` permission and, for API credentials, the `webhooks:manage` scope. The OpenAPI contract is at `/openapi.json`.

| Method and path | Does |
| --- | --- |
| `GET /webhook-event-types` | The event catalog, with samples |
| `GET /webhook-subscriptions` | The shop's webhooks |
| `POST /webhook-subscriptions` | Create one; returns the secret once |
| `POST /webhook-subscriptions/{id}` | Change name, URL, event types, or filters (`expectedVersion` optional) |
| `POST /webhook-subscriptions/{id}/rotate-secret` | New secret, returned once; `overlapHours` 0 to 168 |
| `POST /webhook-subscriptions/{id}/status` | `{"status": "active"}` or `"disabled"` |
| `POST /webhook-subscriptions/{id}/delete` | Delete; pending retries stop, the log stays |
| `POST /webhook-subscriptions/{id}/test` | Send `webhook.test`, or a sample of `eventType` |
| `GET /webhook-deliveries` | The delivery log; filter by `subscriptionId` and `status`, page with `before` |
| `GET /webhook-deliveries/{id}` | One delivery and its envelope |
| `POST /webhook-deliveries/{id}/replay` | Send the same event again |

## Adding an event type

For developers adding events in later milestones (alerts, transfers, purchase orders, returns, Shopify).

1. **Register it** in `packages/core/src/webhooks/events.ts`: an ID, a one-sentence description, the permission whose fields it carries, the filters that apply (`locations`, `alertKinds`), a Zod schema for `data`, a sample, and a builder. The types planned for Phase 2 are already there as `coming`; change one to `available` when its milestone emits it.
2. **Choose how `data` is built.**
   - **At dispatch (preferred):** the command emits references (IDs), and the type's `build(tx, input)` reads the snapshot when the event is sent. The business transaction stays cheap. `stock.changed`, `catalog.item.changed`, and `job.completed` work this way.
   - **In the transaction:** the command builds the snapshot itself and emits `{ data, locationIds, alertKind }`; the `passthrough` builder sends it as given.
3. **Emit it in the same transaction as the change:**
   - A command returns `webhooks: [webhookEvent('alert.opened', input)]` in its handler result. The pipeline writes the outbox row with the success event, only when the shop has an active subscription to that type.
   - A job or sweep calls `insertWebhookEvents(tx, [webhookEvent(...)], uuidv7)` inside its transaction.
   - Never send from outside the transaction: an event must not exist for work that rolled back.
4. **Set `locationIds`** (leaf location IDs) in the built event if the type has the `locations` filter, and `alertKind` for alert types. A new alert kind goes in `WEBHOOK_ALERT_KINDS`.
5. **Run `pnpm webhooks:docs`** to update the catalog above; a test fails while it is stale. The registry test checks the sample against the schema.

The dashboard and the API pick up the new type from the registry; no UI change is needed.
