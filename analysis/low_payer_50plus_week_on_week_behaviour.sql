-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) - week on week behaviour in
-- Month 1 and Month 2, split by what they did in Month 2
--
-- Cohort (Month 1 = M1, any month Jan-Aug 2026):
--   * spent $50-$99 in USD in M1 (actual money, from ludo.economy)
--   * not Prime in M1 by royal points (RP < 100) and never Prime
--     (RP >= 100) in any month from 2021-01-01 up to M1
--   * every qualifying month from Jan to Aug 2026 counts: a user who
--     qualifies in two months appears in both monthly cohorts
--   * results are pooled across all Month 1s (Jan-Aug 2026), plus a
--     month-by-month breakdown
-- Segments, by the user's status in Month 2 (M2 = M1 + 1), on ROYAL POINTS:
--   1. Non Payer in M2      no purchase in M2 and RP < 100
--   2. Low Payer in M2      paid in M2, RP 1-99
--   3. Prime in M2          RP 100-999
--   4. Royal in M2          RP 1000+
--   RP includes bonus / streak points, so a user can reach Prime or Royal
--   with less than $100 / $1000 spent. Monthly RP = royal_status stat
--   (official month-end total, ludo.clubs) when present, otherwise the
--   sum of royal_points_credited_or_debited in D_all_payers_clubs.
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
-- Paste the whole script into the BigQuery console and Run. Results, in order:
--   A. Medians pooled Jan-Aug  B. Averages  C. Medians by Month 1
--   D. Coverage of each event source  E. RP source check  F. Cohort sizes
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
CREATE TEMP TABLE cohort AS
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

-- ------- A. Output: medians per segment, pooled Jan-Aug 2026 ---------
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

-- ------------- B. Same layout with averages (for comparison) ---------
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

-- ---------- C. Medians by Month 1 (Jan ... Aug 2026 separately) --------
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

-- ------------- D. Check: coverage of each source (optional) ----------
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

-- ------------- E. Check: royal points sources (optional) -------------
-- For users who have a royal_status stat in a month, compare it with the
-- RP summed from D_all_payers_clubs. If stat_rp is regularly above
-- pay_rp, the payments table excludes bonus / streak RP.
SELECT
  FORMAT_DATE('%b %Y', month) AS month,
  COUNT(*) AS users_with_royal_status,
  COUNTIF(pay_rp IS NULL) AS no_purchase_rp,
  COUNTIF(ABS(stat_rp - pay_rp) < 1) AS same_rp,
  COUNTIF(stat_rp > pay_rp + 1) AS stat_higher,
  COUNTIF(stat_rp < pay_rp - 1) AS stat_lower,
  ROUND(AVG(SAFE_DIVIDE(stat_rp, pay_rp)), 3) AS avg_stat_to_pay_ratio
FROM monthly_rp
WHERE stat_rp IS NOT NULL AND month BETWEEN DATE_SUB(m1_from, INTERVAL 6 MONTH) AND m1_to
GROUP BY month
ORDER BY month;

-- ------------- F. Check: cohort size by Month 1 and segment ----------
SELECT
  FORMAT_DATE('%b %Y', m1) AS month_1,
  segment,
  COUNT(*) AS users,
  ROUND(AVG(m2_rp), 1) AS avg_m2_rp,
  ROUND(AVG(m2_usd), 1) AS avg_m2_usd
FROM cohort
GROUP BY m1, segment
ORDER BY m1, segment;
