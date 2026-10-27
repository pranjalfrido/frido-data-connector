# Frido Data Knowledge

## How you work
1. Understand the question: which metric, product, channel, period.
2. For a KNOWN metric (listed below), run the same SQL the dashboard uses — do not regenerate it from scratch. Read the shared formula file first if needed.
3. For anything else: explore first (read repo files, check schema, check real distinct values), then write SQL informed by what you found.
4. Before filtering on any text column (status, channel, courier, SKU), always check real distinct values with SELECT DISTINCT first.
5. Sanity-check your result before answering — do the numbers look plausible? Row counts right?
6. If genuinely ambiguous in a way that changes the number materially, ask (see "When to ask" below). Otherwise state your assumption.
7. Never write or modify data. Never invent numbers.

## Tables

### BigQuery (project: frido-429506)
| Table | Use for |
|---|---|
| `production.fact_all_platform_sales_report` | All sales, revenue, returns, RTO, CIR, orders, units |
| `production.Clickpost_Shipment_Tracking_Report` | Logistics: delivery rate, RTO%, TAT, courier performance |
| `production.Aggregated_uniware_sales_report` | Inward/receiving, warehouse movements |
| `production.pincode_city_master` | State, city, region, tier mapping by pincode |
| `sharepoint_to_gcp.Frido_Item_Master__frido_item_sku_master` | Product master: category, GST rate, weight, dimensions |
| `sharepoint_to_gcp.Frido_Item_Master__productid_sku_mapping` | ProductId → MasterSKU aliases |

### Supabase
| Table | Use for |
|---|---|
| `inv_snapshot` | Current inventory (RTD, Raw, Blocked) by SKU + facility |
| `sales_window` | Recent sales for avg daily sale calculation |
| `item_master` | Product master (synced hourly from BigQuery) |
| `cogs_ledger` | COGS per SKU per month |
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
| DOI | `api/_inventory_shared.js` → `stockStatus()` | Total inventory / Avg daily sale |
| Channel mapping | `api/_bq.js` → `buildQuery()` | See channel groups below |

## Default behaviors (critical — wrong answers come from ignoring these)

### Logistics
- **Forward shipments only by default** — never include reverse unless user asks
- NDD couriers: Delhivery NDD (AWB starts `5448`), Skye Air, Urbane Bolt, ElasticRun

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
- BQ payment column is `payment_type`, not `PaymentMode`
- Supabase inventory columns: `rtd_invt`, `raw_invt`, `raw_blocked_invt` (not rtd_qty etc.)
- **Net Revenue ALWAYS uses mature window rates, not current-period rates** — compute RTO/CIR/Cancel% from today-44d to today-14d window, then apply those rates against current-period gross exc GST. Using current-period rates will give wrong (lower) net rev because recent orders haven't had time to return yet. Confirmed matches dashboard at ₹17.71 Cr vs ₹17.81 Cr (Oct 1-23 2026 D2C).
- D2C shNetCalc filter: `Channel='Shopify' AND SubChannel != 'Shopify International' AND SubChannel != 'Retail Store'`
