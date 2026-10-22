-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) - when do they tap the Royal
-- banner, week by week from M1W1 to M2W4 (8 weeks)
--
-- Cohort (Month 1 = M1, any month Jan-Aug 2026, pooled):
--   * spent $50-$99 in M1 (Clubs hearts revenue, Silver purchase table)
--   * not Prime in M1 and never Prime (100+ RP) since 2021-01-01
-- Two Month 2 outcomes (royal points: royal_status if present, else
-- D_all_payers_clubs):  2. Low Payer in M2 (1-99 RP)  3. Prime in M2 (100-999 RP)
--
-- Banner: royal_banner_click ("user taps the Royal offer banner"), from
--   ludo.events (type 'clubs') and the old ludo.clubs (offer_id = phylum).
--   offer_id: offer_royalty_bonus_points_200_1 = Royal Reactivation Offer,
--             offer_royalty_bonus_points_250_1 = Prime Users One-Time Offer.
-- First click = the user's first royal_banner_click inside the 8-week
--   window (M1W1 to M2W4) of that cohort month.
-- Weeks: W1 = days 1-7, W2 = 8-14, W3 = 15-21, W4 = 22-end (AST).
--   W4 has 7-10 days; clicks_w4_norm scales W4 clicks to 7 days.
-- "Prime" tab on the Royalty page: NOT tracked (no such event in the
--   Clubs tracking plan, the live sheet or Mixpanel), so not included.
--
-- Results: A. Week by week per segment  B. By offer  C. Cohort size
-- =====================================================================

-- ---------------------------- CONFIG ---------------------------------
DECLARE m1_from DATE DEFAULT DATE '2026-01-01';
DECLARE m1_to   DATE DEFAULT DATE '2026-08-01';
DECLARE m1_min_usd FLOAT64 DEFAULT 50;
DECLARE m1_max_usd FLOAT64 DEFAULT 100;          -- exclusive
DECLARE data_from DATE;
DECLARE data_to   DATE;
SET data_from = m1_from;
SET data_to   = DATE_ADD(m1_to, INTERVAL 2 MONTH);  -- exclusive (M2 of Aug = Sep)

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

-- -------------- 4. Royal banner taps ---------------------------------
CREATE TEMP TABLE banner_taps AS
WITH users AS (SELECT DISTINCT user_id FROM cohort),
t AS (
  SELECT user_id, ts AS click_ts,
         JSON_VALUE(properties, '$.offer_id') AS offer_id
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'royal_banner_click'
  UNION ALL
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts, phylum
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'royal_banner_click'
)
-- same user + same second + same offer counted once (in case both tables have it)
SELECT DISTINCT t.user_id, TIMESTAMP_TRUNC(t.click_ts, SECOND) AS click_ts, t.offer_id
FROM t JOIN users u ON u.user_id = t.user_id;

CREATE TEMP TABLE cohort_clicks AS
WITH c AS (
  SELECT
    co.user_id, co.m1, co.segment, b.click_ts, b.offer_id,
    DATE(b.click_ts, 'Asia/Riyadh') AS d,
    DATE_DIFF(DATE_TRUNC(DATE(b.click_ts, 'Asia/Riyadh'), MONTH), co.m1, MONTH) + 1 AS mo
  FROM cohort co
  JOIN banner_taps b ON b.user_id = co.user_id
)
SELECT
  *,
  LEAST(DIV(EXTRACT(DAY FROM d) - 1, 7) + 1, 4) AS wk,
  click_ts = MIN(click_ts) OVER (PARTITION BY user_id, m1) AS is_first_click
FROM c
WHERE mo IN (1, 2);

-- ---------------- A. Week by week per segment ------------------------
WITH sizes AS (SELECT segment, COUNT(*) AS cohort_user_months FROM cohort GROUP BY 1),
grid AS (
  SELECT s.segment, mo, wk
  FROM sizes s, UNNEST([1, 2]) AS mo, UNNEST([1, 2, 3, 4]) AS wk
),
w AS (
  SELECT
    segment, mo, wk,
    COUNT(*) AS clicks,
    COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING))) AS users_clicked,
    COUNT(DISTINCT IF(is_first_click, CONCAT(user_id, '|', CAST(m1 AS STRING)), NULL)) AS first_click_users,
    SUM(IF(wk = 4, 7 / (EXTRACT(DAY FROM LAST_DAY(DATE_ADD(m1, INTERVAL mo - 1 MONTH))) - 21), 1)) AS clicks_w4_norm
  FROM cohort_clicks
  GROUP BY 1, 2, 3
)
SELECT
  g.segment,
  FORMAT('M%dW%d', g.mo, g.wk) AS week,
  s.cohort_user_months,
  IFNULL(w.users_clicked, 0) AS users_clicked,
  ROUND(100 * IFNULL(w.users_clicked, 0) / s.cohort_user_months, 2) AS pct_users_clicked,
  IFNULL(w.clicks, 0) AS clicks,
  ROUND(IFNULL(w.clicks_w4_norm, 0), 1) AS clicks_w4_norm,
  IFNULL(w.first_click_users, 0) AS first_click_users,
  ROUND(100 * SAFE_DIVIDE(IFNULL(w.first_click_users, 0), IFNULL(w.users_clicked, 0)), 1) AS pct_of_clickers_first_time,
  ROUND(100 * SUM(IFNULL(w.first_click_users, 0)) OVER (PARTITION BY g.segment ORDER BY g.mo, g.wk)
        / s.cohort_user_months, 2) AS cumulative_pct_ever_clicked
FROM grid g
JOIN sizes s USING (segment)
LEFT JOIN w ON w.segment = g.segment AND w.mo = g.mo AND w.wk = g.wk
ORDER BY g.segment, g.mo, g.wk;

-- ---------------- B. Same, by offer ----------------------------------
SELECT
  segment,
  FORMAT('M%dW%d', mo, wk) AS week,
  CASE offer_id
    WHEN 'offer_royalty_bonus_points_200_1' THEN 'Royal Reactivation Offer'
    WHEN 'offer_royalty_bonus_points_250_1' THEN 'Prime Users One-Time Offer'
    ELSE IFNULL(offer_id, '(no offer_id)')
  END AS offer,
  COUNT(*) AS clicks,
  COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING))) AS users_clicked,
  COUNT(DISTINCT IF(is_first_click, CONCAT(user_id, '|', CAST(m1 AS STRING)), NULL)) AS first_click_users
FROM cohort_clicks
GROUP BY 1, mo, wk, 3
ORDER BY segment, mo, wk, offer;

-- ---------------- C. Cohort size -------------------------------------
SELECT FORMAT_DATE('%b %Y', m1) AS month_1, segment, COUNT(*) AS users
FROM cohort GROUP BY m1, segment ORDER BY m1, segment;
