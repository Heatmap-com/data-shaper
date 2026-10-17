# Implementation plan: normalize persisted custom events

**Prepared:** 4 October 2026
**Depends on:** `Proposed-Canonical-Event-Taxonomy.md`
**Goal:** turn rows that already land in `journey_custom_map` into the weekly event datasets Phase 6 described, without changing the tracker script and without changing the ingest pipeline.

---

## 1. What "done" means

On at least one pilot, a storefront tag written through the existing custom-event API is readable as a canonical event: action, item index, class, and the revenue of the sessions that did it. Unregistered actions are visible and unused. An action with no element binding is visible and unused. Checkout, post-purchase, and off-domain surfaces are unchanged and stay missing.

The analysis-engine team owns the read and the reshape. A concierge owns the snippet that calls the existing API. Nobody adds a column, a table, or a tracker event type.

---

## 2. The shape that is already stored

Probed 4 October 2026. `udp_custom_events` and `journey_custom_map` share one grain. `journey_custom_map` is the table this work reads. Its types are unsigned and its `server_date` is a `Date`.

| Column | Type | Use |
| --- | --- | --- |
| `event_type` | String | Canonical action |
| `event_id` | Int32 | Item index, or a quartile, or a scroll position, as the taxonomy says |
| `event_count` | Int32 | Occurrences, or milliseconds when the registry says so |
| `idvisit`, `idloghsr` | | Join to the session and the pageview |
| `idsite`, `idsitehsr`, `device_type`, `server_date`, `server_time` | | Scope, device, week |

There is no properties column. The pilots had zero rows in both tables. Decision D-01 said to encode properties in `event_id`. That instruction assumed `event_id` could carry a string. It cannot. This plan uses `event_type` for the action and `event_id` for the integer the taxonomy assigns. D-01 should be amended to say that when this work starts.

`session_tags` is not a source. It is a JSON blob of visit attributes.

---

## 3. Order of work

### 3.1 Prove one tag round-trips

Before any dataset is built, emit one event on one pilot through the existing API: `event_type = faq.expand`, `event_id = 0`, `event_count = 1`. Read it back from `journey_custom_map` on that `idloghsr`.

Stop if the API refuses the name, drops `event_id`, or collapses the row onto a session instead of a pageview. The allowlist of roughly thirty names lives in the tracker rate-limit config. If that list blocks `faq.expand`, this plan ends with that fact recorded. Opening the list would be a tracker change, and it is out of scope here.

### 3.2 Record the encoding on the registry

Extend `src/catalog/events.json`. Do not add event names. For each name already listed, add:

- `element_class`, from the taxonomy document. Empty when the event is a page state (`cart.empty_view`, `notfound.view`, `scroll.reversal`).
- `id_meaning`: `position_index`, `quartile`, `scroll_y_rel`, `binary`, or `star`.
- `count_meaning`: `occurrences`, `dwell_ms`, or `visible_ms`.
- `source`: `tag` or `derived`.

`click.no_response` is `derived`. Everything in taxonomy sections 4.1 through 4.6 that is emitted by the snippet is `tag`. Names in taxonomy section 4.8 are removed from the registry used by this path, or marked `source: out_of_scope`, so the normalizer does not wait for them.

`custom-event-inventory` today groups by `event_type` and ignores `event_id`. It also reads `udp_custom_events`. Change it to read `journey_custom_map`, keep `event_id`, and classify each `event_type` as registered or not. That inventory is the check that the snippet and the registry agree.

### 3.3 Normalize

Add `src/domain/event-normalize.js`, a pure function. Input is a raw row plus the registry. Output is one of:

- a canonical event: `event_type`, `element_class`, `position_index`, `measure`, `measure_kind`, `idvisit`, `idloghsr`, `device`, `server_time`
- a rejection: `unregistered`, `bad_id`, or `out_of_scope`, with the raw `event_type` kept for the inventory

`bad_id` means the integer is outside the range that `id_meaning` allows. A quartile that is not 25, 50, 75, or 100 is `bad_id`. A negative index is `bad_id`.

Duration rows (`dwell_ms`, `visible_ms`) contribute their `event_count` as the measure once. They do not also increment an occurrence count. Occurrence rows sum `event_count`.

### 3.4 Attach the item name and the revenue

The weekly datasets call the normalizer, then do two joins the click datasets already know how to do.

- **Binding.** `element-binding` for the page. Match `element_class` and `position_index`. Copy the selector and the human name. No match yields `item_label = unresolved`. Those rows stay in the dataset and are excluded from any trigger.
- **Revenue.** The same session revenue used by `selector-weekly`: the revenue of the sessions in which the event happened, deduplicated per item. It is the revenue of those sessions. It is not a share of the order, and it is not additive across items.

Device and week come from the event row. The week is the Monday of `server_date`, matching the other weekly datasets.

### 3.5 Write the datasets

One adapter per feed, under `src/adapters/datasets/`, in the same shape as `selector-weekly.js`. Each reads `journey_custom_map` for the page window, normalizes, and returns metric rows.

| Adapter | Actions |
| --- | --- |
| `module-events-weekly` | Disclosure, media, choice, reviews, video, sticky add-to-cart, urgency, BNPL |
| `hover-weekly` | `hover.dwell` |
| `popup-weekly` | `popup.*` |
| `cart-state-weekly` | `cart.*` |
| `scroll-reversal-weekly` | `scroll.reversal` |
| `form-field-weekly` | `field.*`, `coupon.*`, `form.abandon_last_field` |
| `search-nullstate-weekly` | `search.*`, `quick_add.click`, `oos.view`, `notfound.view` |
| `rec-slots-weekly` | `rec.impression`, `rec.click` |
| `click-derived-weekly` | `click.no_response`, built from clicks plus the absence of a later event, pageview, or mutation. No tag is read. |

Metrics on every item row: `events` or `dwell_ms` as the registry says, `sessions`, `orders`, `revenue`, `rps`. `rps` is revenue divided by sessions that had the event. A second metric, `rps_vs_primary`, is that RPS divided by the RPS of sessions that clicked the page's primary add-to-cart in the same week and device, when that control exists on the page. Both ratios are omitted when the denominator is zero.

`element.in_view` lands in the existing `exposure-weekly` adapter as an additional source, only for bindings whose `attention_enrolled` is false. Enrolled elements keep the attention-table measurement they already have.

### 3.6 Derived dead click

`click-derived-weekly` does not read tags. For each click on a bound selector, look forward one second on the same pageview. A click with no subsequent pageview, no row in `journey_custom_map`, and no mutation event in that second becomes `click.no_response`. Where the mutation stream is missing, the row is not written. Absence of a mutation table is not evidence of a dead click.

### 3.7 Gate

A trigger may read these datasets only when both are true:

- The action's first `server_date` on that page is before the analysis window. An action that appears inside the window marks dependent cards conditional, reason "instrumentation change in window."
- A recorded `event_validation` verdict exists for that action on that site. Until then the inventory shows the action and every dependent card stays conditional, reason "validate event."

The verdict is a person checking a recording against one row, not an automated pass.

---

## 4. Tests

- `event-normalize.test.js`: one fixture per `id_meaning` and `count_meaning`, plus `unregistered`, `bad_id`, and `out_of_scope`.
- One fixture per new adapter: a pageview with two FAQ indexes, one of them unresolved, and a session with revenue. Assert the resolved item carries the revenue once, the unresolved item is flagged, and the two items are not summed into one RPS.
- A duration fixture: `faq.visible_ms` with `event_count = 4200` becomes 4200 milliseconds and an occurrence count of 1.
- `custom-event-inventory` fixture: an unknown `event_type` is `unregistered` and still listed.
- Contract test: every `source: tag` name in `events.json` is claimed by exactly one adapter, and every adapter action is in the taxonomy document.

No test hits production ClickHouse. The round-trip in section 3.1 is a manual probe, recorded next to D-01, and it is the entry ticket for the rest.

---

## 5. Concierge contract

The snippet is not engine code. It is specified here so the rows that arrive match the normalizer.

- Call the existing custom-event API only. Do not add a tracker function.
- `event_type` is copied from section 4 of the taxonomy document.
- `event_id` is the binding's `position_index` for that element on that page.
- Fire `faq.visible_ms` and `hover.dwell` once per item per pageview. Put milliseconds in `event_count`.
- Deduplicate `gallery.view`, `carousel.slide_view`, `rec.impression`, and `element.in_view` to one row per item per pageview.
- Cap `scroll.reversal` at five per pageview.
- Never send a field value, a query string, a coupon, or review text.
- Tag a theme, not a single URL. The index comes from the binding for that template.

The first theme is one partnership store, and the first class is `faq_item`. The other families wait until `faq.expand` and `faq.visible_ms` round-trip and a recording confirms the index.

---

## 6. Exit

- The section 3.1 probe has a row in `journey_custom_map` whose `event_type` and `event_id` survived.
- `module-events-weekly` on that pilot returns Warranty, or whichever label the binding has, with sessions and session revenue.
- An unknown `event_type` appears in the inventory as unregistered and in no strategy input.
- `events.json` and the taxonomy document list the same tag names.
- Checkout, offers, and portal actions are absent from the datasets, and their requirements stay `missing`.

---

## 7. Outside this plan

- Any edit to the tracker script, the tag allowlist, or the ClickHouse ingest.
- A properties column. If one is added later, the normalizer grows a reader for it. The event names do not change.
- Backfill. Tags start the day the snippet ships. Historical clicks join to classes through the binding, and that work belongs to the click datasets, not to this one.
- Pooling across stores. These datasets are per page and per site.
