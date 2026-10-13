-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) - week on week behaviour in
-- Month 1 and Month 2, split by what they did in Month 2
--
-- Cohort (Month 1 = M1, any month Jan-Aug 2026):
--   * spent $50-$99 (RP) in M1
--   * never Prime ($100+) in any month from 2021-01-01 up to M1
--   * each user is counted once, in their first qualifying month
-- Segments, by what the user did in Month 2 (M2 = M1 + 1):
--   1. Non Payer in M2      (no RP)
--   2. Low Payer in M2      (1-99 RP)
--   3. Prime/Royal in M2    (100+ RP)
-- Periods: M1 W1..W4, M1 Total, M2 W1..W4, M2 Total
--   Weeks are calendar weeks of the month: W1 = days 1-7, W2 = 8-14,
--   W3 = 15-21, W4 = 22-end of month. Dates are in AST (Asia/Riyadh).
-- Output: one row per segment x period, MEDIAN per user of each metric
--   (users with no activity in a period count as 0).
--
-- Paste the whole script into the BigQuery console and Run.
-- The last result is the table. A per-user table (user_period) is also
-- built, so you can change the final SELECT (e.g. AVG instead of median).
-- =====================================================================

-- ---------------------------- CONFIG ---------------------------------
DECLARE m1_from DATE DEFAULT DATE '2026-01-01';  -- first Month 1
DECLARE m1_to   DATE DEFAULT DATE '2026-08-01';  -- last Month 1 (its M2 = Sep 2026)
DECLARE min_rp  INT64 DEFAULT 50;                -- Month 1 spend from $50
DECLARE data_from DATE;
DECLARE data_to   DATE;
SET data_from = m1_from;
SET data_to   = DATE_ADD(m1_to, INTERVAL 2 MONTH);  -- exclusive

-- ----------------------- 1. Monthly payments -------------------------
CREATE TEMP TABLE monthly AS
SELECT
  user_id,
  DATE_TRUNC(date_ast, MONTH) AS month,
  SUM(royal_points_credited_or_debited) AS rp
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
WHERE date_ast >= DATE '2021-01-01'
  AND date_ast < data_to
GROUP BY 1, 2
HAVING SUM(royal_points_credited_or_debited) > 0;

-- --------------------------- 2. Cohort -------------------------------
CREATE TEMP TABLE cohort AS
WITH fp AS (
  SELECT user_id, MIN(IF(rp >= 100, month, NULL)) AS first_prime_month
  FROM monthly
  GROUP BY 1
),
q AS (
  SELECT m.user_id, MIN(m.month) AS m1
  FROM monthly m
  JOIN fp ON fp.user_id = m.user_id
  WHERE m.month BETWEEN m1_from AND m1_to
    AND m.rp >= min_rp AND m.rp < 100
    AND (fp.first_prime_month IS NULL OR fp.first_prime_month > m.month)
  GROUP BY 1
)
SELECT
  q.user_id,
  q.m1,
  CASE
    WHEN n.rp IS NULL THEN '1. Non Payer in M2'
    WHEN n.rp < 100   THEN '2. Low Payer in M2'
    ELSE                   '3. Prime/Royal in M2'
  END AS segment
FROM q
LEFT JOIN monthly n ON n.user_id = q.user_id AND n.month = DATE_ADD(q.m1, INTERVAL 1 MONTH);

-- ------------------- 3. EVENT MAPPING (edit here) --------------------
-- One row per event: user_id, d (AST date), kind, val, club_id, rcvr_id.
-- Change a source table / kingdom / column here and everything below follows.
CREATE TEMP TABLE ev AS
WITH users AS (SELECT DISTINCT user_id FROM cohort),
raw AS (
  -- App Launch #Sessions: one row per app_launch event
  -- VERIFY: table/kingdom for app launch in Clubs/LS
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)] AS user_id, server_ts,
         'app_launch' AS kind, 1.0 AS val,
         CAST(NULL AS STRING) AS club_id, CAST(NULL AS STRING) AS rcvr_id
  FROM `parcheesi-star-7168863.ludo.outside_game_actions`
  WHERE kingdom = 'app_launch'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Club Entry #Sessions / Club Entry Days: club_enter events
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts,
         'club_enter', 1.0, SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'club_enter'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Club Time Spent: club_leave, phylum = user_id, genus = seconds in club
  SELECT phylum, server_ts,
         'club_time', SAFE_CAST(genus AS FLOAT64), SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'club_leave'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Mic Taken #Sessions: take_mic_seat events
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts,
         'mic_take', 1.0, SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'take_mic_seat'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- Mic Time Spent: leave_mic_seat, genus = seconds on mic
  -- VERIFY: genus is the mic session duration in seconds
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts,
         'mic_time', SAFE_CAST(genus AS FLOAT64), SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'leave_mic_seat'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- # Gift Receiving Clubs: send_gift, user_id = sender,
  -- family = club_id,club_name -> distinct club ids the user gifted in
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts,
         'gift_sent', 1.0, SPLIT(family, ',')[SAFE_OFFSET(0)], NULL
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE kingdom = 'send_gift'
    AND DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to

  UNION DISTINCT
  -- # Gift Receiving Users: received_gift, one row per receiver per gift.
  -- The event's user = receiver, properties.sender_uid = sender.
  -- Re-keyed to the SENDER so we can count distinct receivers per sender.
  -- VERIFY: table/column names (ludo.events: name, type, ts, user_id,
  -- properties) and that received_gift covers the whole period
  -- (check: SELECT MIN(DATE(ts)) FROM ludo.events WHERE name = 'received_gift')
  SELECT JSON_EXTRACT_SCALAR(properties, '$.sender_uid'), CAST(ts AS TIMESTAMP),
         'gift_rcvd', 1.0, JSON_EXTRACT_SCALAR(properties, '$.club_id'),
         SPLIT(user_id, ',')[SAFE_OFFSET(0)]
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE name = 'received_gift' AND type = 'clubs'
    AND DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
)
SELECT r.user_id, DATE(r.server_ts, 'Asia/Riyadh') AS d, r.kind, r.val, r.club_id, r.rcvr_id
FROM raw r
JOIN users u ON u.user_id = r.user_id
UNION ALL
-- Purchases for Clubs: one row per purchase, val = RP (USD)
SELECT p.user_id, p.date_ast, 'purchase', CAST(p.royal_points_credited_or_debited AS FLOAT64), NULL, NULL
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs` p
JOIN users u ON u.user_id = p.user_id
WHERE p.date_ast >= data_from AND p.date_ast < data_to;

-- ---------------- 4. Per user x period metrics -----------------------
CREATE TEMP TABLE user_period AS
WITH grid AS (
  SELECT mo, wk FROM UNNEST([1, 2]) AS mo, UNNEST([1, 2, 3, 4, 0]) AS wk  -- wk 0 = month total
),
ev_p AS (
  SELECT e.*, wk2
  FROM (
    SELECT
      e.*,
      DATE_DIFF(DATE_TRUNC(e.d, MONTH), c.m1, MONTH) + 1 AS mo_no,
      LEAST(DIV(EXTRACT(DAY FROM e.d) - 1, 7) + 1, 4) AS wk
    FROM ev e
    JOIN cohort c ON c.user_id = e.user_id
  ) e, UNNEST([e.wk, 0]) AS wk2
  WHERE e.mo_no IN (1, 2)
)
SELECT
  c.user_id,
  c.segment,
  g.mo,
  g.wk,
  COUNTIF(e.kind = 'app_launch') AS app_launch_sessions,
  COUNTIF(e.kind = 'club_enter') AS club_entry_sessions,
  COUNT(DISTINCT IF(e.kind = 'club_enter', e.d, NULL)) AS club_entry_days,
  IFNULL(SUM(IF(e.kind = 'club_time', e.val, 0)), 0) / 3600 AS club_time_hrs,
  COUNTIF(e.kind = 'mic_take') AS mic_sessions,
  IFNULL(SUM(IF(e.kind = 'mic_time', e.val, 0)), 0) / 3600 AS mic_time_hrs,
  COUNT(DISTINCT IF(e.kind = 'gift_rcvd', e.rcvr_id, NULL)) AS gift_receiving_users,
  COUNT(DISTINCT IF(e.kind = 'gift_sent', e.club_id, NULL)) AS gift_receiving_clubs,
  COUNTIF(e.kind = 'purchase' AND e.val > 0) AS purchase_txns,
  IFNULL(SUM(IF(e.kind = 'purchase', e.val, 0)), 0) AS total_purchase_usd
FROM cohort c
CROSS JOIN grid g
LEFT JOIN ev_p e ON e.user_id = c.user_id AND e.mo_no = g.mo AND e.wk2 = g.wk
GROUP BY 1, 2, 3, 4;

-- ------------------- 5. Output: medians per segment ------------------
SELECT
  segment,
  IF(wk = 0, FORMAT('M%d Total', mo), FORMAT('M%d W%d', mo, wk)) AS period,
  COUNT(*) AS users,
  APPROX_QUANTILES(app_launch_sessions, 2)[OFFSET(1)] AS median_app_launch_sessions,
  APPROX_QUANTILES(club_entry_sessions, 2)[OFFSET(1)] AS median_club_entry_sessions,
  APPROX_QUANTILES(club_entry_days, 2)[OFFSET(1)] AS median_club_entry_days,
  ROUND(APPROX_QUANTILES(club_time_hrs, 2)[OFFSET(1)], 2) AS median_club_time_hrs,
  APPROX_QUANTILES(mic_sessions, 2)[OFFSET(1)] AS median_mic_sessions,
  ROUND(APPROX_QUANTILES(mic_time_hrs, 2)[OFFSET(1)], 2) AS median_mic_time_hrs,
  APPROX_QUANTILES(gift_receiving_users, 2)[OFFSET(1)] AS median_gift_receiving_users,
  APPROX_QUANTILES(gift_receiving_clubs, 2)[OFFSET(1)] AS median_gift_receiving_clubs,
  APPROX_QUANTILES(purchase_txns, 2)[OFFSET(1)] AS median_purchase_txns,
  ROUND(APPROX_QUANTILES(total_purchase_usd, 2)[OFFSET(1)], 2) AS median_total_purchase_usd
FROM user_period
GROUP BY segment, mo, wk
ORDER BY segment, mo, IF(wk = 0, 9, wk);
