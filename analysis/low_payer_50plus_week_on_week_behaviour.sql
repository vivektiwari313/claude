-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) - week on week behaviour in
-- Month 1 and Month 2, split by what they did in Month 2
--
-- Cohort (Month 1 = M1, any month Jan-Aug 2026):
--   * spent $50-$99 (RP) in M1
--   * never Prime ($100+) in any month from 2021-01-01 up to M1
--   * every qualifying month from Jan to Aug 2026 counts: a user who
--     qualifies in two months appears in both monthly cohorts
--   * results are pooled across all Month 1s (Jan-Aug 2026), plus a
--     month-by-month breakdown
-- Segments, by what the user did in Month 2 (M2 = M1 + 1):
--   1. Non Payer in M2      (no RP)
--   2. Low Payer in M2      (1-99 RP)
--   3. Prime/Royal in M2    (100+ RP)
-- Periods: M1 W1..W4, M1 Total, M2 W1..W4, M2 Total
--   Weeks are calendar weeks of the month: W1 = days 1-7, W2 = 8-14,
--   W3 = 15-21, W4 = 22-end of month. Dates are in AST (Asia/Riyadh).
--   W4 has 7-10 days, so every W4 metric is normalised to 7 days
--   (value x 7 / days in W4) to compare with W1-W3. Month totals are not
--   normalised. For distinct counts (club entry days, gift receiving
--   users/clubs) this scaling is an approximation.
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
  SELECT m.user_id, m.month AS m1
  FROM monthly m
  JOIN fp ON fp.user_id = m.user_id
  WHERE m.month BETWEEN m1_from AND m1_to
    AND m.rp >= min_rp AND m.rp < 100
    AND (fp.first_prime_month IS NULL OR fp.first_prime_month > m.month)
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
-- # Purchase txns / Total Purchase: D_all_payers_clubs, val = RP (USD)
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
      c.m1,
      DATE_DIFF(DATE_TRUNC(e.d, MONTH), c.m1, MONTH) + 1 AS mo_no,
      LEAST(DIV(EXTRACT(DAY FROM e.d) - 1, 7) + 1, 4) AS wk
    FROM ev e
    JOIN cohort c ON c.user_id = e.user_id
  ) e, UNNEST([e.wk, 0]) AS wk2
  WHERE e.mo_no IN (1, 2)
),
raw AS (
SELECT
  c.user_id,
  c.m1,
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
LEFT JOIN ev_p e ON e.user_id = c.user_id AND e.m1 = c.m1 AND e.mo_no = g.mo AND e.wk2 = g.wk
GROUP BY 1, 2, 3, 4, 5
),
scaled AS (
  -- W4 = day 22 to month end (7-10 days) -> scale to a 7-day week
  SELECT
    r.*,
    IF(r.wk = 4,
       7 / (EXTRACT(DAY FROM LAST_DAY(DATE_ADD(r.m1, INTERVAL r.mo - 1 MONTH))) - 21),
       1) AS f
  FROM raw r
)
SELECT
  user_id, m1, segment, mo, wk,
  ROUND(app_launch_sessions  * f, 2) AS app_launch_sessions,
  ROUND(club_entry_sessions  * f, 2) AS club_entry_sessions,
  ROUND(club_entry_days      * f, 2) AS club_entry_days,
  ROUND(club_time_hrs        * f, 2) AS club_time_hrs,
  ROUND(mic_sessions         * f, 2) AS mic_sessions,
  ROUND(mic_time_hrs         * f, 2) AS mic_time_hrs,
  ROUND(gift_receiving_users * f, 2) AS gift_receiving_users,
  ROUND(gift_receiving_clubs * f, 2) AS gift_receiving_clubs,
  ROUND(purchase_txns        * f, 2) AS purchase_txns,
  ROUND(total_purchase_usd   * f, 2) AS total_purchase_usd
FROM scaled;

-- ------- 5. Output: medians per segment, pooled Jan-Aug 2026 ---------
SELECT
  segment,
  IF(wk = 0, FORMAT('M%d Total', mo), FORMAT('M%d W%d', mo, wk)) AS period,
  COUNT(*) AS user_months,
  COUNT(DISTINCT user_id) AS distinct_users,
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

-- ------------- 5b. Same layout with averages (for comparison) --------
SELECT
  segment,
  IF(wk = 0, FORMAT('M%d Total', mo), FORMAT('M%d W%d', mo, wk)) AS period,
  COUNT(*) AS user_months,
  ROUND(AVG(app_launch_sessions), 2) AS avg_app_launch_sessions,
  ROUND(AVG(club_entry_sessions), 2) AS avg_club_entry_sessions,
  ROUND(AVG(club_entry_days), 2) AS avg_club_entry_days,
  ROUND(AVG(club_time_hrs), 2) AS avg_club_time_hrs,
  ROUND(AVG(mic_sessions), 2) AS avg_mic_sessions,
  ROUND(AVG(mic_time_hrs), 2) AS avg_mic_time_hrs,
  ROUND(AVG(gift_receiving_users), 2) AS avg_gift_receiving_users,
  ROUND(AVG(gift_receiving_clubs), 2) AS avg_gift_receiving_clubs,
  ROUND(AVG(purchase_txns), 2) AS avg_purchase_txns,
  ROUND(AVG(total_purchase_usd), 2) AS avg_total_purchase_usd
FROM user_period
GROUP BY segment, mo, wk
ORDER BY segment, mo, IF(wk = 0, 9, wk);

-- ---------- 5c. Medians by Month 1 (Jan ... Aug 2026 separately) -------
SELECT
  FORMAT_DATE('%b %Y', m1) AS month_1,
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
GROUP BY m1, segment, mo, wk
ORDER BY m1, segment, mo, IF(wk = 0, 9, wk);

-- ------------- 6. Check: coverage of each source (optional) ----------
-- Share of cohort users with at least one event of each kind, by month.
-- If a kind shows ~0% the source/field mapping above needs a look.
SELECT
  FORMAT_DATE('%b %Y', DATE_TRUNC(e.d, MONTH)) AS month,
  e.kind,
  COUNT(*) AS events,
  COUNT(DISTINCT e.user_id) AS cohort_users_with_event,
  ROUND(100 * COUNT(DISTINCT e.user_id) / (SELECT COUNT(DISTINCT user_id) FROM cohort), 1) AS pct_of_cohort_users
FROM ev e
GROUP BY DATE_TRUNC(e.d, MONTH), e.kind
ORDER BY DATE_TRUNC(e.d, MONTH), e.kind;
