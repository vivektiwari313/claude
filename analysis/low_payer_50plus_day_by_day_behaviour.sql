-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) - DAY BY DAY behaviour from
-- Month 1 Day 1 to Month 2 Day 7, to see when and what breaks out first
--
-- Cohort (Month 1 = M1, any month Jan-Aug 2026):
--   * spent $50-$99 in USD in M1 (ludo.economy Clubs heart purchases)
--   * not Prime in M1 and never Prime (100+ RP) since 2021-01-01
--   * every qualifying month from Jan to Aug 2026 counts; results pooled
-- Only two Month 2 outcomes (by royal points, royal_status stat first,
-- else D_all_payers_clubs):
--   2. Low Payer in M2   paid in M2, 1-99 RP
--   3. Prime in M2       100-999 RP
-- Days: M1D01 ... M1D28 and M2D01 ... M2D07 (calendar day of month, AST).
--   Days 29-31 of Month 1 are left out so every month has the same 28 days.
-- Every value is per user per day; users with no activity that day count as 0.
-- "Club Entry Days" becomes "entered a club that day" (0 or 1).
--
-- Paste the whole script into the BigQuery console and Run. Results, in order:
--   A. Medians per segment x day     B. Averages per segment x day
--   C. % of users active per day     D. Prime vs Low Payer gap per day
--   E. Cohort size check
-- =====================================================================

-- ---------------------------- CONFIG ---------------------------------
DECLARE m1_from DATE DEFAULT DATE '2026-01-01';  -- first Month 1
DECLARE m1_to   DATE DEFAULT DATE '2026-08-01';  -- last Month 1 (its M2 = Sep 2026)
DECLARE m1_min_usd FLOAT64 DEFAULT 50;           -- Month 1 spend from $50 ...
DECLARE m1_max_usd FLOAT64 DEFAULT 100;          -- ... up to (not incl.) $100
DECLARE data_from DATE;
DECLARE data_to   DATE;
SET data_from = m1_from;
SET data_to   = DATE_ADD(m1_to, INTERVAL 2 MONTH);  -- exclusive

-- ---------------- 1a. Purchases in USD (ludo.economy) ----------------
-- Clubs purchases are heart purchases. Field positions per the Clubs
-- tracking plan (Old Taxonomy Mapping):
--   purchase_complete: class = item_type, split(species)[1] = transaction
--                      value in USD (split(species)[0] = pack price)
--   direct_addition:   split(class)[0] = item_type, split(genus)[0] =
--                      paid flag (1 = paid), species = pack price
CREATE TEMP TABLE purchases_usd AS
SELECT
  SPLIT(user_id, ',')[SAFE_OFFSET(0)] AS user_id,
  DATE(server_ts, 'Asia/Riyadh') AS d,
  COALESCE(SAFE_CAST(SPLIT(species, ',')[SAFE_OFFSET(1)] AS FLOAT64),
           SAFE_CAST(SPLIT(species, ',')[SAFE_OFFSET(0)] AS FLOAT64)) AS usd
FROM `parcheesi-star-7168863.ludo.economy`
WHERE kingdom = 'purchase_complete'
  AND class = 'hearts'
  AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
UNION ALL
SELECT
  SPLIT(user_id, ',')[SAFE_OFFSET(0)],
  DATE(server_ts, 'Asia/Riyadh'),
  SAFE_CAST(SPLIT(species, ',')[SAFE_OFFSET(0)] AS FLOAT64)
FROM `parcheesi-star-7168863.ludo.economy`
WHERE kingdom = 'direct_addition'
  AND SPLIT(class, ',')[SAFE_OFFSET(0)] = 'hearts'
  AND SPLIT(genus, ',')[SAFE_OFFSET(0)] = '1'
  AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to;

CREATE TEMP TABLE monthly_usd AS
SELECT user_id, DATE_TRUNC(d, MONTH) AS month, SUM(usd) AS usd, COUNT(*) AS txns
FROM purchases_usd
WHERE d >= data_from AND d < data_to AND usd > 0
GROUP BY 1, 2;

-- ---------------- 1b. Royal points per month ------------------------
-- pay_rp: RP credited on purchases (D_all_payers_clubs), since 2021
CREATE TEMP TABLE monthly_pay_rp AS
SELECT
  user_id,
  DATE_TRUNC(date_ast, MONTH) AS month,
  SUM(royal_points_credited_or_debited) AS pay_rp
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
WHERE date_ast >= DATE '2021-01-01'
  AND date_ast < data_to
GROUP BY 1, 2;

-- stat_rp: royal_status stat (ludo.clubs), sent at month-end reset for
-- every Prime/Royal user: split(phylum)[0] = last month royal points,
-- split(class)[0] = royalty type (0 royal / 1 prime).
-- The month the points belong to = the month before the reset; the reset
-- runs at month start, so it is taken as the month of (stat date - 1 day).
-- (genus also carries the month as YYYYMM if you prefer to use that.)
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
  s.stat_rp,
  IFNULL(s.stat_rp, IFNULL(p.pay_rp, 0)) AS rp   -- official stat wins
FROM monthly_pay_rp p
FULL OUTER JOIN monthly_stat_rp s
  ON s.user_id = p.user_id AND s.month = p.month;

-- --------------------------- 2. Cohort -------------------------------
CREATE TEMP TABLE cohort_all AS
WITH fp AS (
  SELECT user_id, MIN(IF(rp >= 100, month, NULL)) AS first_prime_month
  FROM monthly_rp
  GROUP BY 1
),
q AS (
  SELECT u.user_id, u.month AS m1
  FROM monthly_usd u
  LEFT JOIN fp ON fp.user_id = u.user_id
  WHERE u.month BETWEEN m1_from AND m1_to
    AND u.usd >= m1_min_usd AND u.usd < m1_max_usd
    AND (fp.first_prime_month IS NULL OR fp.first_prime_month > u.month)
)
SELECT
  q.user_id,
  q.m1,
  r2.rp AS m2_rp,
  u2.usd AS m2_usd,
  CASE
    WHEN IFNULL(r2.rp, 0) >= 1000 THEN '4. Royal in M2 (1000+ RP)'
    WHEN IFNULL(r2.rp, 0) >= 100  THEN '3. Prime in M2 (100-999 RP)'
    WHEN u2.usd > 0 OR r2.pay_rp > 0 THEN '2. Low Payer in M2 (1-99 RP)'
    ELSE                               '1. Non Payer in M2'
  END AS segment
FROM q
LEFT JOIN monthly_rp r2  ON r2.user_id = q.user_id AND r2.month = DATE_ADD(q.m1, INTERVAL 1 MONTH)
LEFT JOIN monthly_usd u2 ON u2.user_id = q.user_id AND u2.month = DATE_ADD(q.m1, INTERVAL 1 MONTH);

-- Day-by-day view only compares these two Month 2 outcomes
CREATE TEMP TABLE cohort AS
SELECT * FROM cohort_all
WHERE segment IN ('2. Low Payer in M2 (1-99 RP)', '3. Prime in M2 (100-999 RP)');

-- ------------------- 3. EVENT MAPPING (edit here) --------------------
-- Field mapping follows "Data Schema Tracking Plan: LS Clubs"
-- (Schema for New Arch -> Old Taxonomy Mapping) and "Gameberry Taxonomy".
-- One row per event: user_id, d (AST date), kind, val, club_id, rcvr_id.
CREATE TEMP TABLE ev AS
WITH users AS (SELECT DISTINCT user_id FROM cohort),
raw AS (
  -- App Launch #Sessions: ludo.notif_new, kingdom = app_launch
  -- (client event; user_id column carries user_id, device_id, session_id)
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)] AS user_id, server_ts,
         'app_launch' AS kind, 1.0 AS val,
         CAST(NULL AS STRING) AS club_id, CAST(NULL AS STRING) AS rcvr_id
  FROM `parcheesi-star-7168863.ludo.notif_new`
  WHERE kingdom = 'app_launch'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Club Entry #Sessions / Days: club_enter, user = user_id,
  -- club_id = split(family)[0]
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts,
         'club_enter', 1.0, SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'club_enter'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Club Time Spent: club_leave, user = split(phylum)[0],
  -- user_time_spent_in_club_seconds = genus
  SELECT SPLIT(phylum, ',')[SAFE_OFFSET(0)], server_ts,
         'club_time', SAFE_CAST(genus AS FLOAT64), SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'club_leave'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Mic Taken #Sessions: take_mic_seat, user = user_id
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts,
         'mic_take', 1.0, SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'take_mic_seat'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Mic Time Spent: leave_mic_seat, user = split(phylum)[0]
  -- (user_id is the remover), user_time_spent_on_mic_seconds = split(phylum)[1]
  SELECT SPLIT(phylum, ',')[SAFE_OFFSET(0)], server_ts,
         'mic_time', SAFE_CAST(SPLIT(phylum, ',')[SAFE_OFFSET(1)] AS FLOAT64),
         SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'leave_mic_seat'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- # Gift Receiving Clubs: send_gift, sender = user_id,
  -- club_id = split(family)[0]
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts,
         'gift_sent', 1.0, SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'send_gift'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- # Gift Receiving Users: received_gift, receiver = user_id,
  -- sender = split(phylum)[0]. Re-keyed to the SENDER so we can count
  -- distinct receivers of the cohort user's gifts.
  SELECT SPLIT(phylum, ',')[SAFE_OFFSET(0)], server_ts,
         'gift_rcvd', 1.0, SPLIT(family, ',')[SAFE_OFFSET(0)],
         SPLIT(user_id, ',')[SAFE_OFFSET(0)]
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'received_gift'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
)
SELECT r.user_id, DATE(r.server_ts, 'Asia/Riyadh') AS d, r.kind, r.val, r.club_id, r.rcvr_id
FROM raw r
JOIN users u ON u.user_id = r.user_id
UNION ALL
-- # Purchase txns / Total Purchase: Clubs heart purchases in USD (ludo.economy)
SELECT p.user_id, p.d, 'purchase', p.usd, NULL, NULL
FROM purchases_usd p
JOIN users u ON u.user_id = p.user_id
WHERE p.d >= data_from AND p.d < data_to AND p.usd > 0;

-- ---------------- 4. Per user x day metrics --------------------------
CREATE TEMP TABLE user_day AS
WITH grid AS (
  SELECT g.mo, dy
  FROM UNNEST([STRUCT(1 AS mo, 28 AS n), STRUCT(2 AS mo, 7 AS n)]) AS g,
       UNNEST(GENERATE_ARRAY(1, g.n)) AS dy
),
ev_d AS (
  SELECT
    e.*,
    c.m1,
    DATE_DIFF(DATE_TRUNC(e.d, MONTH), c.m1, MONTH) + 1 AS mo_no,
    EXTRACT(DAY FROM e.d) AS dy
  FROM ev e
  JOIN cohort c ON c.user_id = e.user_id
)
SELECT
  c.user_id,
  c.m1,
  c.segment,
  g.mo,
  g.dy,
  COUNTIF(e.kind = 'app_launch') AS app_launch_sessions,
  COUNTIF(e.kind = 'club_enter') AS club_entry_sessions,
  IF(COUNTIF(e.kind = 'club_enter') > 0, 1, 0) AS club_entered,
  ROUND(IFNULL(SUM(IF(e.kind = 'club_time', e.val, 0)), 0) / 3600, 3) AS club_time_hrs,
  COUNTIF(e.kind = 'mic_take') AS mic_sessions,
  ROUND(IFNULL(SUM(IF(e.kind = 'mic_time', e.val, 0)), 0) / 3600, 3) AS mic_time_hrs,
  COUNT(DISTINCT IF(e.kind = 'gift_rcvd', e.rcvr_id, NULL)) AS gift_receiving_users,
  COUNT(DISTINCT IF(e.kind = 'gift_sent', e.club_id, NULL)) AS gift_receiving_clubs,
  COUNTIF(e.kind = 'purchase' AND e.val > 0) AS purchase_txns,
  ROUND(IFNULL(SUM(IF(e.kind = 'purchase', e.val, 0)), 0), 2) AS total_purchase_usd
FROM cohort c
CROSS JOIN grid g
LEFT JOIN ev_d e
  ON e.user_id = c.user_id AND e.m1 = c.m1 AND e.mo_no = g.mo AND e.dy = g.dy
GROUP BY 1, 2, 3, 4, 5;

-- ---------------- A. Medians per segment x day -----------------------
SELECT
  segment,
  FORMAT('M%dD%02d', mo, dy) AS day,
  COUNT(*) AS user_months,
  APPROX_QUANTILES(app_launch_sessions, 2)[OFFSET(1)] AS median_app_launch_sessions,
  APPROX_QUANTILES(club_entry_sessions, 2)[OFFSET(1)] AS median_club_entry_sessions,
  APPROX_QUANTILES(club_entered, 2)[OFFSET(1)] AS median_club_entered,
  APPROX_QUANTILES(club_time_hrs, 2)[OFFSET(1)] AS median_club_time_hrs,
  APPROX_QUANTILES(mic_sessions, 2)[OFFSET(1)] AS median_mic_sessions,
  APPROX_QUANTILES(mic_time_hrs, 2)[OFFSET(1)] AS median_mic_time_hrs,
  APPROX_QUANTILES(gift_receiving_users, 2)[OFFSET(1)] AS median_gift_receiving_users,
  APPROX_QUANTILES(gift_receiving_clubs, 2)[OFFSET(1)] AS median_gift_receiving_clubs,
  APPROX_QUANTILES(purchase_txns, 2)[OFFSET(1)] AS median_purchase_txns,
  APPROX_QUANTILES(total_purchase_usd, 2)[OFFSET(1)] AS median_total_purchase_usd
FROM user_day
GROUP BY segment, mo, dy
ORDER BY segment, mo, dy;

-- ---------------- B. Averages per segment x day ----------------------
SELECT
  segment,
  FORMAT('M%dD%02d', mo, dy) AS day,
  COUNT(*) AS user_months,
  ROUND(AVG(app_launch_sessions), 3) AS avg_app_launch_sessions,
  ROUND(AVG(club_entry_sessions), 3) AS avg_club_entry_sessions,
  ROUND(AVG(club_entered), 3) AS avg_club_entered,
  ROUND(AVG(club_time_hrs), 3) AS avg_club_time_hrs,
  ROUND(AVG(mic_sessions), 3) AS avg_mic_sessions,
  ROUND(AVG(mic_time_hrs), 3) AS avg_mic_time_hrs,
  ROUND(AVG(gift_receiving_users), 3) AS avg_gift_receiving_users,
  ROUND(AVG(gift_receiving_clubs), 3) AS avg_gift_receiving_clubs,
  ROUND(AVG(purchase_txns), 3) AS avg_purchase_txns,
  ROUND(AVG(total_purchase_usd), 2) AS avg_total_purchase_usd
FROM user_day
GROUP BY segment, mo, dy
ORDER BY segment, mo, dy;

-- ---------------- C. % of users active per day -----------------------
SELECT
  segment,
  FORMAT('M%dD%02d', mo, dy) AS day,
  COUNT(*) AS user_months,
  ROUND(100 * AVG(IF(app_launch_sessions > 0, 1, 0)), 1) AS pct_app_launch,
  ROUND(100 * AVG(club_entered), 1) AS pct_club_entry,
  ROUND(100 * AVG(IF(mic_sessions > 0, 1, 0)), 1) AS pct_mic_taken,
  ROUND(100 * AVG(IF(gift_receiving_users > 0 OR gift_receiving_clubs > 0, 1, 0)), 1) AS pct_gifted,
  ROUND(100 * AVG(IF(purchase_txns > 0, 1, 0)), 1) AS pct_purchased
FROM user_day
GROUP BY segment, mo, dy
ORDER BY segment, mo, dy;

-- ------------- D. Prime vs Low Payer gap per day (averages) ----------
-- ratio > 1 means Prime-in-M2 users do more of it that day than
-- Low-Payer-in-M2 users. The first day a ratio pulls away is the breakout.
WITH a AS (
  SELECT
    mo, dy,
    STARTS_WITH(segment, '3.') AS is_prime,
    AVG(app_launch_sessions) AS app, AVG(club_entry_sessions) AS ces,
    AVG(club_entered) AS ce, AVG(club_time_hrs) AS cth,
    AVG(mic_sessions) AS ms, AVG(mic_time_hrs) AS mth,
    AVG(gift_receiving_users) AS gru, AVG(gift_receiving_clubs) AS grc,
    AVG(purchase_txns) AS pt, AVG(total_purchase_usd) AS tp
  FROM user_day
  GROUP BY 1, 2, 3
)
SELECT
  FORMAT('M%dD%02d', p.mo, p.dy) AS day,
  ROUND(SAFE_DIVIDE(p.app, l.app), 2) AS app_launch_ratio,
  ROUND(SAFE_DIVIDE(p.ces, l.ces), 2) AS club_entry_sessions_ratio,
  ROUND(SAFE_DIVIDE(p.ce,  l.ce),  2) AS club_entered_ratio,
  ROUND(SAFE_DIVIDE(p.cth, l.cth), 2) AS club_time_ratio,
  ROUND(SAFE_DIVIDE(p.ms,  l.ms),  2) AS mic_sessions_ratio,
  ROUND(SAFE_DIVIDE(p.mth, l.mth), 2) AS mic_time_ratio,
  ROUND(SAFE_DIVIDE(p.gru, l.gru), 2) AS gift_receiving_users_ratio,
  ROUND(SAFE_DIVIDE(p.grc, l.grc), 2) AS gift_receiving_clubs_ratio,
  ROUND(SAFE_DIVIDE(p.pt,  l.pt),  2) AS purchase_txns_ratio,
  ROUND(SAFE_DIVIDE(p.tp,  l.tp),  2) AS total_purchase_ratio
FROM a p
JOIN a l ON l.mo = p.mo AND l.dy = p.dy AND NOT l.is_prime
WHERE p.is_prime
ORDER BY p.mo, p.dy;

-- ---------------- E. Check: cohort size by Month 1 -------------------
SELECT
  FORMAT_DATE('%b %Y', m1) AS month_1,
  segment,
  COUNT(*) AS users,
  ROUND(AVG(m2_rp), 1) AS avg_m2_rp,
  ROUND(AVG(m2_usd), 1) AS avg_m2_usd
FROM cohort
GROUP BY m1, segment
ORDER BY m1, segment;
