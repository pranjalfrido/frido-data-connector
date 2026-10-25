import { runBigQuery } from './lib/bigquery.js';

// Dashboard: Gross Inc GST = ₹24.38 Cr, Net Rev Exc GST = ₹17.81 Cr
// D2C = Channel='Shopify', SubChannels: MyFrido, Mobility, Shopify International (ALL = Overall tab)
// Formula: retainedShare = 1 - (rto+cir+return+FULL cancel) / gross_inc_gst
//          netRevExcGst = grossExcGst * retainedShare

// Test 1: with Shopify International INCLUDED (Overall tab = all subchannels)
const r1 = await runBigQuery(`
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
      AND SubChannel IN ('MyFrido', 'Mobility', 'Shopify International')
      AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
      AND NOT (OrderId LIKE '%_EX%')
  ),
  m AS (
    SELECT *,
      SAFE_DIVIDE(rto_rev + cir_rev + return_rev + cancel_rev, gross_inc_gst) AS deduction_pct
    FROM base
  )
  SELECT
    ROUND(gross_inc_gst/10000000, 2)  AS gross_inc_gst_cr,
    ROUND(gross_exc_gst/10000000, 2)  AS gross_exc_gst_cr,
    ROUND(rto_rev*100/gross_inc_gst, 2) AS rto_pct,
    ROUND(cir_rev*100/gross_inc_gst, 2) AS cir_pct,
    ROUND(cancel_rev*100/gross_inc_gst, 2) AS cancel_pct,
    ROUND((1-deduction_pct)*100, 2) AS retained_share_pct,
    ROUND(gross_exc_gst*(1-deduction_pct)/10000000, 2) AS net_rev_exc_gst_cr
  FROM m
`);
console.log('With Shopify International INCLUDED (Overall tab):');
console.log(r1);

// Test 2: check what distinct SubChannels exist under Shopify
const r2 = await runBigQuery(`
  SELECT SubChannel, COUNT(*) as orders, ROUND(SUM(SellingPrice_Inc_GST)/10000000,2) as rev_cr
  FROM \`frido-429506.production.fact_all_platform_sales_report\`
  WHERE OrderDate BETWEEN '2026-10-01' AND '2026-10-24'
    AND Channel = 'Shopify'
  GROUP BY SubChannel ORDER BY rev_cr DESC
`);
console.log('\nAll Shopify SubChannels this month:');
console.log(r2);
