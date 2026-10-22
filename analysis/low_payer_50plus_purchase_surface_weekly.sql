-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) - week on week purchases by
-- surface (Shop vs Mini pop-up), Month 1 and Month 2
--
-- Cohort (Month 1 = M1, any month Jan-Aug 2026, pooled):
--   * spent $50-$99 in M1 (Clubs hearts revenue, Silver purchase table)
--   * not Prime in M1 and never Prime (100+ RP) since 2021-01-01
-- Two Month 2 outcomes (royal points: royal_status stat if present,
-- else D_all_payers_clubs):
--   2. Low Payer in M2   paid in M2, 1-99 RP
--   3. Prime in M2       100-999 RP
--
-- Purchases: Intermediate_Silver.LS_I_Daily_Purchase_Info with
--   class = 'hearts' AND dollar_value > 0 (the team's only USD source).
--   One purchase = one `family` (bundles span several rows).
-- Surface: completed purchases carry no surface, so each purchase is
--   matched to the user's purchase_initiate tap just before it
--   (purchase_from = shop / mini_pop_up / offer_pop_up), within 30 min
--   before to 2 min after the purchase; the closest tap wins, preferring
--   one with the same pack price. Taps come from the new table
--   (ludo.events, type 'clubs') and the old one (ludo.clubs, purchase_from
--   in `class`), so months on either side of the migration are covered.
--   Webstore / offline purchases (mode_of_payment = 'Offline') have no
--   in-app tap and are reported separately; in-app purchases with no tap
--   found are "unattributed".
-- Weeks: W1 = days 1-7, W2 = 8-14, W3 = 15-21, W4 = 22-end (AST).
--   W4 values are normalised to 7 days (x 7 / days in W4). Totals are not.
--
-- Paste the whole script into the BigQuery console and Run. Results:
--   A. Week on week by segment: transactions and USD per surface
--   B. Same, long format (one row per surface) with per-user averages
--   C. Check: tap match rate by month and source table
--   D. Check: cohort size
-- Dry-run first: the purchase_initiate scans cover Jan-Sep 2026.
-- =====================================================================

-- ---------------------------- CONFIG ---------------------------------
DECLARE m1_from DATE DEFAULT DATE '2026-01-01';  -- first Month 1
DECLARE m1_to   DATE DEFAULT DATE '2026-08-01';  -- last Month 1 (its M2 = Sep 2026)
DECLARE m1_min_usd FLOAT64 DEFAULT 50;
DECLARE m1_max_usd FLOAT64 DEFAULT 100;          -- exclusive
DECLARE match_before_min INT64 DEFAULT 30;       -- tap up to 30 min before purchase
DECLARE match_after_min  INT64 DEFAULT 2;        -- ... or up to 2 min after (clock skew)
DECLARE data_from DATE;
DECLARE data_to   DATE;
SET data_from = m1_from;
SET data_to   = DATE_ADD(m1_to, INTERVAL 2 MONTH);  -- exclusive

-- ---------------- 1. Purchases (Silver, USD) -------------------------
CREATE TEMP TABLE purchases AS
SELECT
  user_id,
  family AS purchase_id,
  MIN(server_ts) AS purchase_ts,
  MIN(date) AS date,
  SUM(dollar_value) AS usd,
  LOGICAL_OR(IFNULL(mode_of_payment = 'Offline', FALSE)) AS is_offline
FROM `parcheesi-star-7168863.Intermediate_Silver.LS_I_Daily_Purchase_Info`
WHERE date >= data_from AND date < data_to
  AND class = 'hearts' AND dollar_value > 0
GROUP BY 1, 2;

CREATE TEMP TABLE monthly_usd AS
SELECT user_id, DATE_TRUNC(DATE(purchase_ts, 'Asia/Riyadh'), MONTH) AS month, SUM(usd) AS usd
FROM purchases
GROUP BY 1, 2;

-- ---------------- 2. Royal points per month --------------------------
CREATE TEMP TABLE monthly_pay_rp AS
SELECT user_id, DATE_TRUNC(date_ast, MONTH) AS month,
       SUM(royal_points_credited_or_debited) AS pay_rp
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
WHERE date_ast >= DATE '2021-01-01' AND date_ast < data_to
GROUP BY 1, 2;

-- royal_status (old architecture): split(phylum)[0] = month's royal
-- points, sent at the month-start reset for the previous month.
CREATE TEMP TABLE monthly_stat_rp AS
SELECT
  SPLIT(user_id, ',')[SAFE_OFFSET(0)] AS user_id,
  DATE_TRUNC(DATE_SUB(DATE(server_ts, 'Asia/Riyadh'), INTERVAL 1 DAY), MONTH) AS month,
  MAX(SAFE_CAST(SPLIT(phylum, ',')[SAFE_OFFSET(0)] AS FLOAT64)) AS stat_rp
FROM `parcheesi-star-7168863.ludo.clubs`
WHERE kingdom = 'royal_status'
  AND DATE(server_ts) >= DATE '2021-01-01'
  AND DATE(server_ts) < DATE_ADD(data_to, INTERVAL 7 DAY)
GROUP BY 1, 2;

CREATE TEMP TABLE monthly_rp AS
SELECT
  COALESCE(p.user_id, s.user_id) AS user_id,
  COALESCE(p.month, s.month) AS month,
  p.pay_rp,
  IFNULL(s.stat_rp, IFNULL(p.pay_rp, 0)) AS rp
FROM monthly_pay_rp p
FULL OUTER JOIN monthly_stat_rp s ON s.user_id = p.user_id AND s.month = p.month;

-- --------------------------- 3. Cohort -------------------------------
CREATE TEMP TABLE cohort AS
WITH fp AS (
  SELECT user_id, MIN(IF(rp >= 100, month, NULL)) AS first_prime_month
  FROM monthly_rp GROUP BY 1
),
q AS (
  SELECT u.user_id, u.month AS m1
  FROM monthly_usd u
  LEFT JOIN fp ON fp.user_id = u.user_id
  WHERE u.month BETWEEN m1_from AND m1_to
    AND u.usd >= m1_min_usd AND u.usd < m1_max_usd
    AND (fp.first_prime_month IS NULL OR fp.first_prime_month > u.month)
),
seg AS (
  SELECT
    q.user_id, q.m1,
    CASE
      WHEN IFNULL(r2.rp, 0) >= 1000 THEN 'royal'
      WHEN IFNULL(r2.rp, 0) >= 100  THEN '3. Prime in M2 (100-999 RP)'
      WHEN u2.usd > 0 OR r2.pay_rp > 0 THEN '2. Low Payer in M2 (1-99 RP)'
      ELSE 'non_payer'
    END AS segment
  FROM q
  LEFT JOIN monthly_rp r2  ON r2.user_id = q.user_id AND r2.month = DATE_ADD(q.m1, INTERVAL 1 MONTH)
  LEFT JOIN monthly_usd u2 ON u2.user_id = q.user_id AND u2.month = DATE_ADD(q.m1, INTERVAL 1 MONTH)
)
SELECT * FROM seg WHERE segment LIKE '2.%' OR segment LIKE '3.%';

-- -------------- 4. Purchase taps (purchase_initiate) -----------------
CREATE TEMP TABLE taps AS
WITH users AS (SELECT DISTINCT user_id FROM cohort),
t AS (
  -- new architecture
  SELECT
    user_id,
    ts AS tap_ts,
    JSON_VALUE(properties, '$.purchase_from') AS purchase_from,
    SAFE_CAST(JSON_VALUE(properties, '$.pack_price') AS FLOAT64) AS pack_price,
    'ludo.events' AS tap_source
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'purchase_initiate'
  UNION ALL
  -- old architecture: purchase_from = class, pack_price = split(phylum)[2]
  SELECT
    SPLIT(user_id, ',')[SAFE_OFFSET(0)],
    server_ts,
    class,
    SAFE_CAST(SPLIT(phylum, ',')[SAFE_OFFSET(2)] AS FLOAT64),
    'ludo.clubs'
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'purchase_initiate'
)
SELECT t.* FROM t JOIN users u ON u.user_id = t.user_id;

-- -------------- 5. Each cohort purchase with its surface -------------
CREATE TEMP TABLE cohort_purchases AS
WITH cp AS (
  -- purchases in M1 and M2 of each cohort row
  SELECT
    c.user_id, c.m1, c.segment,
    p.purchase_id, p.purchase_ts, p.usd, p.is_offline,
    DATE(p.purchase_ts, 'Asia/Riyadh') AS d,
    DATE_DIFF(DATE_TRUNC(DATE(p.purchase_ts, 'Asia/Riyadh'), MONTH), c.m1, MONTH) + 1 AS mo
  FROM cohort c
  JOIN purchases p ON p.user_id = c.user_id
  WHERE DATE_TRUNC(DATE(p.purchase_ts, 'Asia/Riyadh'), MONTH)
        BETWEEN c.m1 AND DATE_ADD(c.m1, INTERVAL 1 MONTH)
),
matched AS (
  SELECT
    cp.user_id, cp.m1, cp.segment, cp.purchase_id, cp.purchase_ts,
    cp.usd, cp.is_offline, cp.d, cp.mo,
    ARRAY_AGG(
      STRUCT(tp.purchase_from AS purchase_from, tp.tap_source AS tap_source)
      ORDER BY
        IF(ABS(IFNULL(tp.pack_price, -1) - cp.usd) < 0.5, 0, 1),     -- same price first
        IF(tp.tap_ts <= cp.purchase_ts, 0, 1),                       -- then taps before
        ABS(TIMESTAMP_DIFF(cp.purchase_ts, tp.tap_ts, SECOND))       -- then closest
      LIMIT 1
    )[SAFE_OFFSET(0)] AS tap
  FROM cp
  LEFT JOIN taps tp
    ON tp.user_id = cp.user_id
   AND NOT cp.is_offline
   AND tp.tap_ts BETWEEN TIMESTAMP_SUB(cp.purchase_ts, INTERVAL match_before_min MINUTE)
                     AND TIMESTAMP_ADD(cp.purchase_ts, INTERVAL match_after_min MINUTE)
  GROUP BY cp.user_id, cp.m1, cp.segment, cp.purchase_id, cp.purchase_ts,
           cp.usd, cp.is_offline, cp.d, cp.mo
)
SELECT
  user_id, m1, segment, purchase_id, usd, d, mo,
  LEAST(DIV(EXTRACT(DAY FROM d) - 1, 7) + 1, 4) AS wk,
  CASE
    WHEN is_offline THEN 'webstore_offline'
    WHEN tap.purchase_from = 'shop' THEN 'shop'
    WHEN tap.purchase_from = 'mini_pop_up' THEN 'mini_pop_up'
    WHEN tap.purchase_from = 'offer_pop_up' THEN 'offer_pop_up'
    WHEN tap.purchase_from IS NOT NULL THEN CONCAT('other: ', tap.purchase_from)
    ELSE 'unattributed'
  END AS surface,
  tap.tap_source
FROM matched;

-- -------------- 6. Segment x period x surface (with W4 scaling) ------
CREATE TEMP TABLE seg_period_surface AS
WITH sizes AS (
  SELECT segment, COUNT(*) AS cohort_user_months FROM cohort GROUP BY 1
),
per_period AS (
  SELECT segment, mo, wk, surface, m1, COUNT(DISTINCT purchase_id) AS txns, SUM(usd) AS usd,
         COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING))) AS buyers
  FROM cohort_purchases GROUP BY 1, 2, 3, 4, 5
  UNION ALL
  SELECT segment, mo, 0, surface, m1, COUNT(DISTINCT purchase_id), SUM(usd),
         COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING)))
  FROM cohort_purchases GROUP BY 1, 2, 3, 4, 5
)
SELECT
  pp.segment, pp.mo, pp.wk, pp.surface,
  s.cohort_user_months,
  -- W4 normalised per Month 1 (month length differs), then summed
  SUM(pp.txns * IF(pp.wk = 4, 7 / (EXTRACT(DAY FROM LAST_DAY(DATE_ADD(pp.m1, INTERVAL pp.mo - 1 MONTH))) - 21), 1)) AS txns,
  SUM(pp.usd  * IF(pp.wk = 4, 7 / (EXTRACT(DAY FROM LAST_DAY(DATE_ADD(pp.m1, INTERVAL pp.mo - 1 MONTH))) - 21), 1)) AS usd,
  SUM(pp.buyers) AS buyers
FROM per_period pp
JOIN sizes s USING (segment)
GROUP BY 1, 2, 3, 4, 5;

-- ---------- A. Week on week: Shop vs Mini pop-up (wide) --------------
SELECT
  segment,
  IF(wk = 0, FORMAT('M%d Total', mo), FORMAT('M%d W%d', mo, wk)) AS period,
  ANY_VALUE(cohort_user_months) AS cohort_user_months,
  ROUND(SUM(IF(surface = 'shop', txns, 0)), 1)        AS shop_txns,
  ROUND(SUM(IF(surface = 'shop', usd, 0)), 2)         AS shop_usd,
  ROUND(SUM(IF(surface = 'mini_pop_up', txns, 0)), 1) AS mini_pop_up_txns,
  ROUND(SUM(IF(surface = 'mini_pop_up', usd, 0)), 2)  AS mini_pop_up_usd,
  ROUND(SAFE_DIVIDE(SUM(IF(surface = 'mini_pop_up', txns, 0)),
                    SUM(IF(surface IN ('shop', 'mini_pop_up'), txns, 0))) * 100, 1) AS mini_share_of_shop_plus_mini_txns_pct,
  ROUND(SUM(IF(surface = 'offer_pop_up', txns, 0)), 1) AS offer_pop_up_txns,
  ROUND(SUM(IF(surface = 'offer_pop_up', usd, 0)), 2)  AS offer_pop_up_usd,
  ROUND(SUM(IF(surface = 'webstore_offline', txns, 0)), 1) AS webstore_offline_txns,
  ROUND(SUM(IF(surface = 'webstore_offline', usd, 0)), 2)  AS webstore_offline_usd,
  ROUND(SUM(IF(surface = 'unattributed' OR surface LIKE 'other:%', txns, 0)), 1) AS unattributed_txns,
  ROUND(SUM(IF(surface = 'unattributed' OR surface LIKE 'other:%', usd, 0)), 2)  AS unattributed_usd,
  ROUND(SUM(txns), 1) AS all_txns,
  ROUND(SUM(usd), 2)  AS all_usd
FROM seg_period_surface
GROUP BY segment, mo, wk
ORDER BY segment, mo, IF(wk = 0, 9, wk);

-- ---------- B. Long format with per-user averages --------------------
SELECT
  segment,
  IF(wk = 0, FORMAT('M%d Total', mo), FORMAT('M%d W%d', mo, wk)) AS period,
  surface,
  ROUND(txns, 1) AS txns,
  ROUND(usd, 2) AS usd,
  buyers AS buyer_user_months,
  ROUND(txns / cohort_user_months, 3) AS txns_per_cohort_user,
  ROUND(usd / cohort_user_months, 2)  AS usd_per_cohort_user,
  ROUND(SAFE_DIVIDE(usd, txns), 2)    AS avg_txn_size_usd
FROM seg_period_surface
ORDER BY segment, mo, IF(wk = 0, 9, wk), surface;

-- ---------- C. Check: how many in-app purchases found a tap ----------
SELECT
  FORMAT_DATE('%b %Y', DATE_TRUNC(d, MONTH)) AS month,
  COUNT(DISTINCT purchase_id) AS purchases,
  COUNT(DISTINCT IF(surface = 'webstore_offline', purchase_id, NULL)) AS webstore_offline,
  COUNT(DISTINCT IF(surface NOT IN ('webstore_offline', 'unattributed'), purchase_id, NULL)) AS matched_to_tap,
  ROUND(100 * SAFE_DIVIDE(
    COUNT(DISTINCT IF(surface NOT IN ('webstore_offline', 'unattributed'), purchase_id, NULL)),
    COUNT(DISTINCT IF(surface != 'webstore_offline', purchase_id, NULL))), 1) AS in_app_match_rate_pct,
  COUNT(DISTINCT IF(tap_source = 'ludo.events', purchase_id, NULL)) AS tap_from_new_table,
  COUNT(DISTINCT IF(tap_source = 'ludo.clubs', purchase_id, NULL))  AS tap_from_old_table
FROM cohort_purchases
GROUP BY DATE_TRUNC(d, MONTH)
ORDER BY DATE_TRUNC(d, MONTH);

-- ---------- D. Check: cohort size -----------------------------------
SELECT FORMAT_DATE('%b %Y', m1) AS month_1, segment, COUNT(*) AS users
FROM cohort
GROUP BY m1, segment
ORDER BY m1, segment;
