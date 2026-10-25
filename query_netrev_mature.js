import { runBigQuery } from './lib/bigquery.js';

const r = await runBigQuery(`
  WITH
  gross AS (
    SELECT
      SubChannel,
      SUM(SellingPrice_Inc_GST) AS gross_inc_gst,
      SUM(SellingPrice_Exc_GST) AS gross_exc_gst
    FROM \`frido-429506.production.fact_all_platform_sales_report\`
    WHERE
      OrderDate BETWEEN '2026-10-01' AND '2026-10-23'
      AND Channel = 'Shopify'
      AND SubChannel IN ('MyFrido', 'Mobility')
      AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
      AND NOT (OrderId LIKE '%_EX%')
    GROUP BY SubChannel
  ),
  mature AS (
    SELECT
      SubChannel,
      SUM(CASE WHEN Order_Status='RTO'       THEN SellingPrice_Inc_GST ELSE 0 END) / SUM(SellingPrice_Inc_GST) AS rto_pct,
      SUM(CASE WHEN Order_Status='CIR'       THEN SellingPrice_Inc_GST ELSE 0 END) / SUM(SellingPrice_Inc_GST) AS cir_pct,
      SUM(CASE WHEN Order_Status='Return'    THEN SellingPrice_Inc_GST ELSE 0 END) / SUM(SellingPrice_Inc_GST) AS return_pct,
      SUM(CASE WHEN Order_Status='Cancelled' THEN SellingPrice_Inc_GST ELSE 0 END) / SUM(SellingPrice_Inc_GST) AS cancel_pct
    FROM \`frido-429506.production.fact_all_platform_sales_report\`
    WHERE
      OrderDate BETWEEN DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 44 DAY)
                    AND DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 14 DAY)
      AND Channel = 'Shopify'
      AND SubChannel IN ('MyFrido', 'Mobility')
      AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
      AND NOT (OrderId LIKE '%_EX%')
    GROUP BY SubChannel
  )
  SELECT
    g.SubChannel,
    ROUND(g.gross_inc_gst/10000000, 2) AS gross_inc_gst_cr,
    ROUND(g.gross_exc_gst/10000000, 2) AS gross_exc_gst_cr,
    ROUND(m.rto_pct*100, 2)    AS mature_rto_pct,
    ROUND(m.cir_pct*100, 2)    AS mature_cir_pct,
    ROUND(m.cancel_pct*100, 2) AS mature_cancel_pct,
    ROUND((1 - m.rto_pct - m.cir_pct - m.return_pct - m.cancel_pct)*100, 2) AS retained_share_pct,
    ROUND(g.gross_exc_gst * (1 - m.rto_pct - m.cir_pct - m.return_pct - m.cancel_pct) / 10000000, 2) AS net_rev_exc_gst_cr
  FROM gross g
  JOIN mature m USING (SubChannel)
  ORDER BY gross_inc_gst_cr DESC
`);

console.log(r);
