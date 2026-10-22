-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) who became PRIME in Month 2 -
-- how many used the Prime benefits, week by week M1W1 to M3W4
--
-- Cohort: spent $50-$99 in M1 (Jan-Aug 2026, Silver USD), never Prime
--   before, and 100-999 RP in M2 (royal_status if present, else
--   D_all_payers_clubs).
-- Why Month 3 is included: Prime/Royal tier rewards are granted on the
--   1st of the next month based on the previous month's royal points, so
--   a user who becomes Prime in M2 normally gets the benefits in M3.
--   (M3 of an Aug 2026 cohort is Oct 2026, which is still in progress.)
-- Benefits:
--   * Royal emoji  - emoji_on_mic, emoji_id like clubs_emoji_tiger... /
--                    ..._panda... (Tiger set for Prime + Royal, Panda set
--                    Royal only). VERIFY the list with result D.
--   * Party Cap    - mic pop gift, send_gift gift_id = 51
--   * Perfume      - send_gift gift_id = 36
--   Sources: ludo.events (type 'clubs') and old ludo.clubs
--   (emoji_id = split(class)[0]; gift_id = split(class)[0],
--    gift_qty = split(class)[1], hearts_out = genus).
-- Weeks: W1 = days 1-7, W2 = 8-14, W3 = 15-21, W4 = 22-end (AST).
--
-- Results: A. Users and usage per week per benefit  B. Month totals
--          C. Cohort size  D. Check: emoji ids used by the cohort
-- Dry-run first: emoji_on_mic is one of the heaviest Clubs events.
-- =====================================================================

-- ---------------------------- CONFIG ---------------------------------
DECLARE m1_from DATE DEFAULT DATE '2026-01-01';
DECLARE m1_to   DATE DEFAULT DATE '2026-08-01';
DECLARE m1_min_usd FLOAT64 DEFAULT 50;
DECLARE m1_max_usd FLOAT64 DEFAULT 100;          -- exclusive
DECLARE party_cap_gift_id STRING DEFAULT '51';
DECLARE perfume_gift_id   STRING DEFAULT '36';
DECLARE data_from DATE;
DECLARE data_to   DATE;
SET data_from = m1_from;
SET data_to   = LEAST(DATE_ADD(m1_to, INTERVAL 3 MONTH), CURRENT_DATE('Asia/Riyadh'));  -- up to M3

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
SELECT * FROM seg WHERE segment LIKE '3.%';

-- -------------- 4. Benefit usage events -----------------------------
CREATE TEMP TABLE usage_ev AS
WITH users AS (SELECT DISTINCT user_id FROM cohort),
e AS (
  -- Royal emoji on mic
  SELECT user_id, ts AS event_ts, 'royal_emoji' AS benefit,
         JSON_VALUE(properties, '$.emoji_id') AS item_id, 1 AS qty, 0 AS hearts
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'emoji_on_mic'
  UNION ALL
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts, 'royal_emoji',
         SPLIT(class, ',')[SAFE_OFFSET(0)], 1, 0
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'emoji_on_mic'
  UNION ALL
  -- Party Cap / Perfume gifts (one row per gift transaction)
  SELECT user_id, ts, 'gift',
         JSON_VALUE(properties, '$.gift_id'),
         SAFE_CAST(JSON_VALUE(properties, '$.gift_qty') AS INT64),
         SAFE_CAST(JSON_VALUE(properties, '$.hearts_out') AS INT64)
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'send_gift'
  UNION ALL
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts, 'gift',
         SPLIT(class, ',')[SAFE_OFFSET(0)],
         SAFE_CAST(SPLIT(class, ',')[SAFE_OFFSET(1)] AS INT64),
         SAFE_CAST(genus AS INT64)
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'send_gift'
)
SELECT * FROM (
SELECT
  e.user_id,
  TIMESTAMP_TRUNC(e.event_ts, SECOND) AS event_ts,
  CASE
    WHEN e.benefit = 'royal_emoji'
         AND (LOWER(e.item_id) LIKE '%tiger%' OR LOWER(e.item_id) LIKE '%panda%') THEN 'Royal emoji'
    WHEN e.benefit = 'royal_emoji' THEN 'other emoji'
    WHEN REGEXP_EXTRACT(e.item_id, r'(\d+)$') = party_cap_gift_id THEN 'Party Cap gift'
    WHEN REGEXP_EXTRACT(e.item_id, r'(\d+)$') = perfume_gift_id   THEN 'Perfume gift'
    ELSE NULL
  END AS benefit,
  e.item_id, e.qty, e.hearts
FROM e
JOIN users u ON u.user_id = e.user_id
)
WHERE benefit IS NOT NULL;   -- keeps royal/other emojis, Party Cap and Perfume only

CREATE TEMP TABLE cohort_usage AS
SELECT
  c.user_id, c.m1, u.benefit, u.item_id, u.qty, u.hearts, u.event_ts,
  DATE_DIFF(DATE_TRUNC(DATE(u.event_ts, 'Asia/Riyadh'), MONTH), c.m1, MONTH) + 1 AS mo,
  LEAST(DIV(EXTRACT(DAY FROM DATE(u.event_ts, 'Asia/Riyadh')) - 1, 7) + 1, 4) AS wk
FROM cohort c
JOIN (SELECT DISTINCT * FROM usage_ev) u ON u.user_id = c.user_id
WHERE DATE_DIFF(DATE_TRUNC(DATE(u.event_ts, 'Asia/Riyadh'), MONTH), c.m1, MONTH) + 1 IN (1, 2, 3);

-- ---------------- A. Users and usage per week per benefit -----------
WITH size AS (SELECT COUNT(*) AS cohort_user_months FROM cohort),
grid AS (
  SELECT b AS benefit, mo, wk
  FROM UNNEST(['Royal emoji', 'Party Cap gift', 'Perfume gift']) AS b,
       UNNEST([1, 2, 3]) AS mo, UNNEST([1, 2, 3, 4]) AS wk
),
w AS (
  SELECT
    benefit, mo, wk,
    COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING))) AS users,
    COUNT(*) AS times_used,                    -- emoji sends / gift transactions
    SUM(qty) AS quantity,                      -- emojis / gifts sent (gift_qty)
    SUM(hearts) AS hearts_spent
  FROM cohort_usage
  WHERE benefit IN ('Royal emoji', 'Party Cap gift', 'Perfume gift')
  GROUP BY 1, 2, 3
)
SELECT
  g.benefit,
  FORMAT('M%dW%d', g.mo, g.wk) AS week,
  s.cohort_user_months,
  IFNULL(w.users, 0) AS users,
  ROUND(100 * IFNULL(w.users, 0) / s.cohort_user_months, 2) AS pct_of_cohort,
  IFNULL(w.times_used, 0) AS times_used,
  IFNULL(w.quantity, 0) AS quantity,
  IFNULL(w.hearts_spent, 0) AS hearts_spent,
  ROUND(SAFE_DIVIDE(w.times_used, w.users), 2) AS times_used_per_user
FROM grid g
CROSS JOIN size s
LEFT JOIN w ON w.benefit = g.benefit AND w.mo = g.mo AND w.wk = g.wk
ORDER BY g.benefit, g.mo, g.wk;

-- ---------------- B. Month totals -----------------------------------
SELECT
  benefit,
  FORMAT('M%d', mo) AS month,
  COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING))) AS users,
  ROUND(100 * COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING))) / (SELECT COUNT(*) FROM cohort), 2) AS pct_of_cohort,
  COUNT(*) AS times_used,
  SUM(qty) AS quantity,
  SUM(hearts) AS hearts_spent
FROM cohort_usage
WHERE benefit IN ('Royal emoji', 'Party Cap gift', 'Perfume gift')
GROUP BY benefit, mo
ORDER BY benefit, mo;

-- ---------------- C. Cohort size ------------------------------------
SELECT FORMAT_DATE('%b %Y', m1) AS month_1, COUNT(*) AS prime_in_m2_users
FROM cohort GROUP BY m1 ORDER BY m1;

-- ---------------- D. Check: emoji ids the cohort used ---------------
-- Confirm which ids are the Royal emojis; edit the LIKE patterns in
-- section 4 if the list differs.
SELECT item_id AS emoji_id, benefit AS classified_as, COUNT(*) AS sends,
       COUNT(DISTINCT user_id) AS users
FROM cohort_usage
WHERE benefit IN ('Royal emoji', 'other emoji')
GROUP BY 1, 2
ORDER BY sends DESC
LIMIT 100;
