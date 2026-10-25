import { runBigQuery } from './lib/bigquery.js';

const r = await runBigQuery(`
  SELECT
    SubChannel,
    ROUND(SUM(SellingPrice_Inc_GST)/10000000, 2) AS gross_inc_gst_cr,
    COUNT(DISTINCT OrderId) AS orders,
    SUM(ItemQty) AS units
  FROM \`frido-429506.production.fact_all_platform_sales_report\`
  WHERE
    OrderDate BETWEEN '2026-10-01' AND '2026-10-23'
    AND Channel = 'Shopify'
    AND SubChannel IN ('MyFrido', 'Mobility')
    AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
    AND NOT (OrderId LIKE '%_EX%')
  GROUP BY SubChannel
  ORDER BY gross_inc_gst_cr DESC
`);

console.log(r);
