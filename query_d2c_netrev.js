import { runBigQuery } from './lib/bigquery.js';

// Formula from live dashboard code (api/_bq.js):
// retainedShare    = 1 - cirPct - rtoPct - returnPct - cancelPct
// netRevenueExcGst = grossExcGst × retainedShare
// D2C = Channel='Shopify', SubChannels: MyFrido, Mobility, Shopify International
// Exclusions: Credit Notes, RTV, _EX orders (from buildQuery)
// This month = Oct 1 to Oct 24 2026

const result = await runBigQuery(`
  WITH base AS (
    SELECT
      SUM(SellingPrice_Inc_GST)  AS gross_inc_gst,
      SUM(SellingPrice_Exc_GST)  AS gross_exc_gst,
      SUM(CASE WHEN Order_Status = 'CIR'       THEN SellingPrice_Inc_GST ELSE 0 END) AS cir_rev,
      SUM(CASE WHEN Order_Status = 'RTO'       THEN SellingPrice_Inc_GST ELSE 0 END) AS rto_rev,
      SUM(CASE WHEN Order_Status = 'Return'    THEN SellingPrice_Inc_GST ELSE 0 END) AS return_rev,
      SUM(CASE WHEN Order_Status = 'Cancelled' THEN SellingPrice_Inc_GST ELSE 0 END) AS cancel_rev
    FROM \`frido-429506.production.fact_all_platform_sales_report\`
    WHERE
      OrderDate BETWEEN '2026-10-01' AND '2026-10-24'
      AND Channel = 'Shopify'
      AND SubChannel != 'Shopify International'
      AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
      AND NOT (OrderId LIKE '%_EX%')
  ),
  measures AS (
    SELECT
      gross_inc_gst,
      gross_exc_gst,
      cir_rev,
      rto_rev,
      return_rev,
      cancel_rev,
      -- prepaid-only cancel (COD cancels excluded from return% but included in net rev deduction)
      -- using full cancel_rev for net rev deduction per dashboard formula
      SAFE_DIVIDE(cir_rev,    gross_inc_gst) AS cir_pct,
      SAFE_DIVIDE(rto_rev,    gross_inc_gst) AS rto_pct,
      SAFE_DIVIDE(return_rev, gross_inc_gst) AS return_pct,
      SAFE_DIVIDE(cancel_rev, gross_inc_gst) AS cancel_pct
    FROM base
  )
  SELECT
    ROUND(gross_inc_gst / 100000, 2)                                          AS gross_inc_gst_lakhs,
    ROUND(gross_exc_gst / 100000, 2)                                          AS gross_exc_gst_lakhs,
    ROUND(cir_pct * 100, 2)                                                   AS cir_pct,
    ROUND(rto_pct * 100, 2)                                                   AS rto_pct,
    ROUND(return_pct * 100, 2)                                                AS return_pct,
    ROUND(cancel_pct * 100, 2)                                                AS cancel_pct,
    ROUND((1 - cir_pct - rto_pct - return_pct - cancel_pct), 4)              AS retained_share,
    ROUND(gross_exc_gst * (1 - cir_pct - rto_pct - return_pct - cancel_pct) / 100000, 2) AS net_rev_exc_gst_lakhs
  FROM measures
`);

console.log(result);
