import { runBigQuery } from './lib/bigquery.js';
import { runSupabase } from './lib/supabase.js';

console.log('\n=== E2E TEST: Real business questions ===\n');

// Q1: Revenue + RTO% by channel last 7 days
try {
  const r = await runBigQuery(`
    WITH base AS (
      SELECT
        Channel,
        SUM(SellingPrice_Inc_GST) as gross_inc_gst,
        SUM(CASE WHEN Order_Status = 'RTO' THEN SellingPrice_Inc_GST ELSE 0 END) as rto_rev,
        SUM(CASE WHEN Order_Status = 'CIR' THEN SellingPrice_Inc_GST ELSE 0 END) as cir_rev
      FROM \`frido-429506.production.fact_all_platform_sales_report\`
      WHERE
        OrderDate >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 7 DAY)
        AND NOT (Channel = 'Amazon' AND COALESCE(Order_Status,'') = 'RTV (Return to vendor)')
        AND NOT (OrderId LIKE '%_EX%')
        AND NOT (COALESCE(Order_Status,'') = 'Credit Note')
      GROUP BY Channel
    )
    SELECT
      Channel,
      ROUND(gross_inc_gst/100000, 2) as gross_rev_lakhs,
      ROUND(rto_rev * 100.0 / NULLIF(gross_inc_gst, 0), 1) as rto_pct,
      ROUND(cir_rev * 100.0 / NULLIF(gross_inc_gst, 0), 1) as cir_pct
    FROM base
    ORDER BY gross_inc_gst DESC
  `);
  console.log('Q1: Revenue + RTO% by channel (last 7 days)');
  console.log(r);
} catch(e) { console.error('Q1 FAILED:', e.message); }

// Q2: Top 5 SKUs by units sold last 7 days
try {
  const r = await runBigQuery(`
    SELECT
      COALESCE(masterskucode, ProductId) as sku,
      SUM(ItemQty) as units_sold
    FROM \`frido-429506.production.fact_all_platform_sales_report\`
    WHERE
      OrderDate >= DATE_SUB(CURRENT_DATE('Asia/Kolkata'), INTERVAL 7 DAY)
      AND Order_Status IN ('Sales', 'Delivered', 'Dispatched')
      AND NOT (OrderId LIKE '%_EX%')
    GROUP BY sku
    ORDER BY units_sold DESC
    LIMIT 5
  `);
  console.log('\nQ2: Top 5 SKUs by units last 7 days');
  console.log(r);
} catch(e) { console.error('Q2 FAILED:', e.message); }

// Q3: Inventory health — SKUs with DOI < 15 days (low stock)
try {
  const r = await runSupabase(`
    SELECT
      i.item_sku_code,
      SUM(i.rtd_invt) as total_rtd,
      ROUND(AVG(sw.avg_daily_qty)::numeric, 2) as avg_daily_sale,
      CASE WHEN AVG(sw.avg_daily_qty) > 0
        THEN ROUND((SUM(i.rtd_invt) / AVG(sw.avg_daily_qty))::numeric, 0)
        ELSE NULL
      END as doi
    FROM inv_snapshot i
    LEFT JOIN (
      SELECT final_sku, AVG(qty) as avg_daily_qty
      FROM sales_window
      GROUP BY final_sku
    ) sw ON sw.final_sku = i.item_sku_code
    GROUP BY i.item_sku_code
    HAVING
      AVG(sw.avg_daily_qty) > 0
      AND SUM(i.rtd_invt) > 0
      AND SUM(i.rtd_invt) / AVG(sw.avg_daily_qty) < 15
    ORDER BY SUM(i.rtd_invt) / AVG(sw.avg_daily_qty) ASC
    LIMIT 10
  `);
  console.log('\nQ3: Low stock SKUs (DOI < 15 days)');
  console.log(r);
} catch(e) { console.error('Q3 FAILED:', e.message); }
