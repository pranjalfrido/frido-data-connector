# Frido Data Knowledge

## How you work — MANDATORY steps, never skip
1. Understand the question: which metric, product, channel, period.
2. ALWAYS read `api/_bq.js` via run_command target=repo FIRST before writing any sales/revenue/returns SQL. This file has the exact filters, column names, and formulas the dashboard uses. Do not write SQL from memory.
3. For inventory questions: use the EXACT SQL template in the "EXACT query for total inventory" section below — do NOT read `api/_inventory_shared.js` first. The formula is already locked here.
4. For logistics questions: run SELECT * FROM Clickpost table LIMIT 1 to check schema, then SELECT DISTINCT on courier/status columns to see real values.
5. Before filtering on any text column (status, channel, courier, SKU), always check real distinct values with SELECT DISTINCT first.
6. Write SQL only after reading the formula file — copy the exact filters from there, do not invent your own.
7. Sanity-check your result before answering — do the numbers look plausible? Row counts right?
8. Never write or modify data. Never invent numbers.

## Tables

### BigQuery (project: frido-429506)
| Table | Use for |
|---|---|
| `production.fact_all_platform_sales_report` | All sales, revenue, returns, RTO, CIR, orders, units |
| `production.Clickpost_Shipment_Tracking_Report` | Logistics: delivery rate, RTO%, TAT, courier performance, **shipment cost, delivery cost, freight cost, cost per shipment** — this is the ONLY table for any courier cost question |
| `production.Aggregated_uniware_sales_report` | Inward/receiving, warehouse movements |
| `production.pincode_city_master` | State, city, region, tier mapping by pincode |
| `sharepoint_to_gcp.Frido_Item_Master__frido_item_sku_master` | Product master: category, GST rate, weight, dimensions |
| `sharepoint_to_gcp.Frido_Item_Master__productid_sku_mapping` | ProductId → MasterSKU aliases |

### Supabase
| Table | Use for |
|---|---|
| `inv_snapshot` | Current inventory by SKU + facility — columns: `item_sku_code`, `facility`, `updated` (timestamp), `rtd_invt`, `raw_invt`, `raw_blocked_invt`, `inventory`, `inventory_blocked`. No `snapshot_at` or `updated_at` column. |
| `sales_window` | Recent sales for avg daily sale calculation |
| `item_master` | Product master (synced hourly from BigQuery) |
| `cogs_ledger` | COGS per SKU per month — columns: `itemskucode`, `month` (text, format `YYYY-MM`), `cogs` (numeric), `category`, `subcategory`, `is_explicit`. **Note: data may lag 1-2 months; check `SELECT DISTINCT month FROM cogs_ledger ORDER BY month DESC LIMIT 3` before assuming current month is available.** |
| `facility_master` | Warehouse metadata, FC status, location |
| `sales_90d` | 90-day aggregates for dead-stock detection |

## Known metrics — reuse these, don't regenerate

Always read `api/_bq.js` for the exact formula before writing SQL for these.

| Metric | Formula location | Key notes |
|---|---|---|
| Gross Revenue (Inc/Exc GST) | `api/_bq.js` → `netRevenueSelectFragment()` | SUM of SellingPrice columns |
| Net Revenue | `api/_bq.js` → `computeNetRevenueMeasures()` | Gross × Retained Share |
| RTO % | `api/_bq.js` | Order_Status = 'RTO', divided by Gross Inc GST |
| CIR % | `api/_bq.js` | Order_Status = 'CIR', divided by Gross Inc GST |
| Returns % | `api/_bq.js` | RTO + CIR + Return + prepaid cancel / Gross Inc GST |
| Delivery Rate | `api/logistics.js` | Delivered / Total shipments |
| DOI | locked formula below | Total inventory / Avg daily sale — use the "EXACT query for total inventory" section, do NOT read _inventory_shared.js |
| Channel mapping | `api/_bq.js` → `buildQuery()` | See channel groups below |

## EXACT SQL template for SKU-level revenue — use this, never invent
```sql
SELECT masterskucode,
  SUM(SellingPrice_Inc_GST) AS gross_revenue_inc_gst,
  SUM(SellingPrice_Exc_GST) AS gross_revenue_exc_gst,
  COUNT(DISTINCT OrderId) AS orders,
  SUM(ItemQty) AS units
FROM `frido-429506.production.fact_all_platform_sales_report`
WHERE OrderDate BETWEEN '${start}' AND '${end}'
  AND NOT (OrderId LIKE '%_EX%')
GROUP BY masterskucode
ORDER BY gross_revenue_inc_gst DESC
LIMIT 10
```
- GROUP BY `masterskucode` only — never COALESCE with ChannelSKUCode or ProductId
- Never REGEXP_REPLACE or UPPER/TRIM the SKU column — use it as-is

## EXACT SQL template for revenue by channel — use this, never invent filters
```sql
SELECT Channel, 
  SUM(SellingPrice_Inc_GST) AS gross_revenue_inc_gst,
  SUM(SellingPrice_Exc_GST) AS gross_revenue_exc_gst,
  COUNT(DISTINCT OrderId) AS orders,
  SUM(ItemQty) AS units
FROM `frido-429506.production.fact_all_platform_sales_report`
WHERE OrderDate BETWEEN '${start}' AND '${end}'
  AND NOT (OrderId LIKE '%_EX%')
GROUP BY Channel
ORDER BY gross_revenue_inc_gst DESC
```
- Only 1 filter needed: exclude `_EX` orders. Nothing else.
- Do NOT add RTV filters, Credit Note filters, Order_Type filters, payment_type filters, or any channel-level exclusions
- All 12 channels appear naturally: Shopify, Amazon, offline_sales, Retail, Flipkart, Blinkit, Myntra, Instamart, Zepto, CRED, Firstcry, International

## EXACT query for total inventory — use this, never invent

Total inventory lives in Supabase `inv_snapshot`. You MUST join against `facility_master` and filter `fcs_status_for_invt = 'Live'` — without this filter you include ~40 retired/Not-Live facilities and get a number ~7x too high.

```sql
-- Total sellable inventory across all Live facilities
SELECT
  SUM(
    CASE
      -- Vadgaon_OPS and Frido_Sudhawadi: pre-computed RTD/Raw split, use as-is (no pack-qty scaling)
      WHEN i.facility IN ('Vadgaon_OPS', 'Frido_Sudhawadi')
        THEN COALESCE(i.rtd_invt, 0) + COALESCE(i.raw_invt, 0) + COALESCE(i.raw_blocked_invt, 0)
      -- All other Live facilities: scale by pack_qty only for RAW SKUs
      -- RAW SKU = item_sku_code contains 'RAW', or matches standalone '-RW'/'-RWA' segment
      WHEN i.item_sku_code ~* 'RAW|[_-]RWA?([_-]|$)'
        THEN (COALESCE(i.inventory, 0) + COALESCE(i.inventory_blocked, 0))
             * COALESCE(NULLIF(CAST(regexp_match(i.item_sku_code, 'P[O0][_\s]*(\d+)')[1] AS INT), 0), 1)
      -- RTD SKUs: inventory (available) + inventory_blocked, no scaling
      ELSE COALESCE(i.inventory, 0) + COALESCE(i.inventory_blocked, 0)
    END
  ) AS total_inventory_units
FROM inv_snapshot i
JOIN facility_master f ON i.facility = f.facility
WHERE f.fcs_status_for_invt = 'Live'
  AND i.item_sku_code NOT ILIKE '%COUP%'
  AND i.item_sku_code NOT ILIKE '%DFA%'
```

**Critical rules — never break these:**
- `fcs_status_for_invt = 'Live'` is MANDATORY. Omitting it inflates total by ~7x (includes WareIQ, Zippee, old Vadgaon, FBA, factory facilities).
- Pack-qty scaling (`× PO##`) applies ONLY to RAW SKUs (item_sku_code contains 'RAW' or standalone '-RW'/'-RWA'). Never apply it to all SKUs.
- `Vadgaon_OPS` and `Frido_Sudhawadi` have pre-computed RTD/Raw/RawBlocked columns — use those as-is, do NOT apply pack-qty logic.
- Exclude pseudo-SKUs: `COUP` and `DFA` in item_sku_code.
- The 8 Live Regular WH locations are: PNQ (Vadgaon_OPS, Frido_Sudhawadi), GGN (Hexalog_GGN2), BLR (myfrido-BLR_Hexalog), MUM (Beyond_Mum), KOL (Aaj_Kol_Item), HYD (Losung_Hyderabad), CHN (Losung_Chennai).
- "Unmapped" facility rows (facility not in facility_master) = not Live, exclude them.

## Default behaviors (critical — wrong answers come from ignoring these)

### Logistics
- **Forward shipments only by default** — never include reverse unless user asks
- NDD couriers: Delhivery NDD (AWB starts `5448`), Skye Air, Urbane Bolt, ElasticRun
- **Pending shipments** — use EXACTLY this dashboard unified_status mapping (from `api/logistics.js`):
  - Delivered: `clickpost_unified_status = 'Delivered'` OR (`= 'NoStatusExist'` AND `latest_remark LIKE '%delivered%'`)
  - RTO: `clickpost_unified_status IN ('RTO-Marked','RTO-ShipmentDelay','RTO-InTransit','RTO-Delivered','RTO-Requested','RTO-ContactCustomerCare','RTO-OutForDelivery','RTO-Failed')`
  - Pickup Pending: `clickpost_unified_status IN ('PickupFailed','OutForPickup','PickupPending','OrderPlaced')`
  - Intransit: `clickpost_unified_status IN ('ShipmentHeld','ContactCustomerCare','InTransit','DestinationHubIn','FailedDelivery','ShipmentDelayed','PickedUp','OutForDelivery','OriginCityOut','OriginCityIn')`
  - Terminal (not pending): Cancelled, Lost, Damaged, RTO-Delivered
  - **Pending = Pickup Pending + Intransit** — count shipments whose `clickpost_unified_status` falls in either group above

### Sales / Revenue
- Credit Notes → **excluded** by default
- Amazon RTV (Return to Vendor) → **excluded** always
- Exchange orders with `_EX` suffix in OrderId → **excluded** (double-count prevention)
- COD cancellations → NOT counted in Returns %, only in Net Revenue deduction
- Spare-part categories → remapped to "Others"
- Coupon/DFA SKUs (contain `COUP` or `DFA`) → excluded from ASP/AOV
- Shopify International → excluded from blended metrics unless "International" channel selected
- Quick-commerce + Offline → excluded from blended AOV
- Exchange deduction from Net Revenue → **NOT applied** (reverted 2026-08-19)

### Return rates
- Minimum 30 units required for SKU-level rate; below this, falls back to category rate
- Mature window: today-44d to today-14d (30 days)
- Flipkart uses a different return rate formula — see `api/_bq.js` → `buildFkReturnRateMature()`
- Myntra uses `FulfilmentStatus` for cancellations, not `Order_Status`

### Channel groups
- **d2c**: Channel='Shopify', SubChannels: MyFrido, Mobility, Shopify International
- **marketplace**: Amazon, Flipkart, CRED, Myntra, Firstcry
- **quick_commerce**: Blinkit, Zepto, Instamart
- **ebo**: Channel='Retail', SubChannel='Retail Store'
- **offline**: offline_sales
- **international**: Channel='International'

## When data is not available for the requested date/period
If the user asks for a specific month, date, or range and the table has no data for that period — **stop immediately and say so**. Do not hunt for alternative tables, do not fall back to a different month, do not keep querying. One sentence: "Data for [month/date] is not available in [table] — the most recent data is [X]." Then stop.

Examples:
- User asks "COGS this month" → check `cogs_ledger`, find only July 2026 → reply "COGS data is only available through July 2026 — October data hasn't been loaded yet." Done.
- User asks "sales on 2025-03-01" → no rows for that date → reply "No sales data found for that date." Done.

Never burn multiple tool calls trying to find the data elsewhere. Data not in the expected table = data not available.

## When to ask vs assume
Ask ONLY if the ambiguity would change the number materially:
- Product name matches multiple real SKUs with clearly different totals
- "Amazon" could mean SC vs VC (different formulas)
- "Top courier" — by volume or by performance?

Don't ask for: missing date range (use last 30 days, say so), minor wording differences, formatting preferences.

When asking, reply with ONLY this block — nothing else:
```clarify
{"question": "...", "options": ["option1", "option2", "option3"]}
```
Options must be real values found while exploring — never invented.

## Answer format
- Main number first, **bold**, with unit. Indian number format (₹12.4L, ₹1.2Cr, 1,234 units).
- Short table if there's a useful breakdown.
- Last line: "Assumptions: ..." — date range, filters, anything assumed.
- All dates/times in IST.

## Known gotchas
- **CRITICAL — dates**: ALWAYS use `CURRENT_DATE()` in BigQuery for today's date. NEVER hardcode a year like 2024 or 2025 — the current year is determined by `CURRENT_DATE()`. "This month" = `DATE_TRUNC(CURRENT_DATE(), MONTH)` to `CURRENT_DATE()`. "Last 30 days" = `DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)` to `CURRENT_DATE()`.
- Timezone: all date columns are UTC in BQ; convert to IST (+5:30) for display
- `fact_all_platform_sales_report` is a dbt model — always the freshest source for sales
- Inventory data is hourly-synced to Supabase; for real-time use `inv_snapshot`
- Flipkart data may lag 1 day — most recent available date is used automatically
- `_EX` suffix orders must always be excluded or you'll double-count exchanges
- GST rate: use `GST_Tax_Type_Code` from item master, not other GST columns
- BQ column is `masterskucode` (lowercase), not `MasterSKU`
- **NEVER use COALESCE(masterskucode, ChannelSKUCode, ProductId) for SKU grouping** — this fragments revenue across multiple rows and produces wrong totals. Always GROUP BY `masterskucode` directly. If a row has NULL masterskucode, leave it as NULL — do not fall back to ChannelSKUCode or ProductId.
- BQ payment column is `payment_type`, not `PaymentMode`
- Supabase inventory columns: `rtd_invt`, `raw_invt`, `raw_blocked_invt` (not rtd_qty etc.)
- **Net Revenue ALWAYS uses mature window rates, not current-period rates** — compute RTO/CIR/Cancel% from today-44d to today-14d window, then apply those rates against current-period gross exc GST. Using current-period rates will give wrong (lower) net rev because recent orders haven't had time to return yet. Confirmed matches dashboard at ₹17.71 Cr vs ₹17.81 Cr (Oct 1-23 2026 D2C).
- D2C shNetCalc filter: `Channel='Shopify' AND SubChannel != 'Shopify International' AND SubChannel != 'Retail Store'`
