import { runBigQuery } from './lib/bigquery.js';

const r = await runBigQuery(`
  WITH q AS (
    SELECT *
    FROM \`frido-429506.production.fact_all_platform_sales_report\`
    WHERE
      OrderDate BETWEEN '2026-10-01' AND '2026-10-24'
      AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
      AND NOT (Channel = 'Amazon' AND COALESCE(Order_Status,'') = 'RTV (Return to vendor)')
      AND NOT (OrderId LIKE '%_EX%')
  )
  SELECT
    SUM(SellingPrice_Inc_GST)  AS gross_inc_gst,
    SUM(SellingPrice_Exc_GST)  AS gross_exc_gst,
    SUM(CASE WHEN Order_Status = 'CIR'       THEN SellingPrice_Inc_GST ELSE 0 END) AS cir_rev,
    SUM(CASE WHEN Order_Status = 'RTO'       THEN SellingPrice_Inc_GST ELSE 0 END) AS rto_rev,
    SUM(CASE WHEN Order_Status = 'Return'    THEN SellingPrice_Inc_GST ELSE 0 END) AS return_rev,
    SUM(CASE WHEN Order_Status = 'Cancelled' THEN SellingPrice_Inc_GST ELSE 0 END) AS cancel_rev,
    SUM(CASE WHEN Order_Status = 'Cancelled' AND payment_type = 'COD' THEN SellingPrice_Inc_GST ELSE 0 END) AS cod_cancel_rev
  FROM q
  WHERE Channel = 'Shopify'
    AND SubChannel != 'Shopify International'
    AND SubChannel != 'Retail Store'
`);

const headers = r.split('\n')[0].split('\t');
const vals = r.split('\n')[1].split('\t');
const row = Object.fromEntries(headers.map((h,i) => [h, parseFloat(vals[i])||0]));
const { gross_inc_gst, gross_exc_gst, cir_rev, rto_rev, return_rev, cancel_rev } = row;
const retainedShare = Math.max(0, 1 - (rto_rev + cir_rev + return_rev + cancel_rev) / gross_inc_gst);
const netRevExcGst = gross_exc_gst * retainedShare;

console.log(`Gross Inc GST:   ₹${(gross_inc_gst/10000000).toFixed(2)} Cr  (dashboard: ₹24.38 Cr)`);
console.log(`Gross Exc GST:   ₹${(gross_exc_gst/10000000).toFixed(2)} Cr`);
console.log(`RTO%:            ${(rto_rev*100/gross_inc_gst).toFixed(2)}%  (dashboard: 6.8%)`);
console.log(`CIR%:            ${(cir_rev*100/gross_inc_gst).toFixed(2)}%  (dashboard: 6.4%)`);
console.log(`Cancel%:         ${(cancel_rev*100/gross_inc_gst).toFixed(2)}%  (dashboard: 4.5%)`);
console.log(`Retained Share:  ${(retainedShare*100).toFixed(2)}%`);
console.log(`Net Rev Exc GST: ₹${(netRevExcGst/10000000).toFixed(2)} Cr  (dashboard: ₹17.81 Cr)`);
