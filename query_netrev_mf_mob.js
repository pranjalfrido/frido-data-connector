import { runBigQuery } from './lib/bigquery.js';

const r = await runBigQuery(`
  WITH q AS (
    SELECT *
    FROM \`frido-429506.production.fact_all_platform_sales_report\`
    WHERE
      OrderDate BETWEEN '2026-10-01' AND '2026-10-23'
      AND Channel = 'Shopify'
      AND SubChannel IN ('MyFrido', 'Mobility')
      AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
      AND NOT (OrderId LIKE '%_EX%')
  )
  SELECT
    SubChannel,
    ROUND(SUM(SellingPrice_Inc_GST)/10000000, 2)  AS gross_inc_gst_cr,
    ROUND(SUM(SellingPrice_Exc_GST)/10000000, 2)  AS gross_exc_gst_cr,
    ROUND(SUM(CASE WHEN Order_Status='RTO'       THEN SellingPrice_Inc_GST ELSE 0 END)*100/SUM(SellingPrice_Inc_GST),2) AS rto_pct,
    ROUND(SUM(CASE WHEN Order_Status='CIR'       THEN SellingPrice_Inc_GST ELSE 0 END)*100/SUM(SellingPrice_Inc_GST),2) AS cir_pct,
    ROUND(SUM(CASE WHEN Order_Status='Return'    THEN SellingPrice_Inc_GST ELSE 0 END)*100/SUM(SellingPrice_Inc_GST),2) AS return_pct,
    ROUND(SUM(CASE WHEN Order_Status='Cancelled' THEN SellingPrice_Inc_GST ELSE 0 END)*100/SUM(SellingPrice_Inc_GST),2) AS cancel_pct,
    ROUND(
      SUM(SellingPrice_Exc_GST)
      * (1 - (
          SUM(CASE WHEN Order_Status IN ('RTO','CIR','Return','Cancelled') THEN SellingPrice_Inc_GST ELSE 0 END)
          / SUM(SellingPrice_Inc_GST)
        ))
      / 10000000
    , 2) AS net_rev_exc_gst_cr
  FROM q
  GROUP BY SubChannel
  ORDER BY gross_inc_gst_cr DESC
`);

console.log(r);
