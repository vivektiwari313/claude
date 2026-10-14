-- =====================================================================
-- Clubs: $50+ Low Payers who were never Prime - MoM breakdown, Jan-Sep 2026
--
-- Base for month M: users who spent $50-$99 (RP) in M and were never
-- Prime ($100+) in any month from 2021-01-01 up to M.
--
-- Columns per month M:
--   first_time_payers          first ever payment in Clubs is in M
--                              (no purchase at all from 2021-01-01 to M-1)
--   low_payer_last_month       spent $1-$99 in M-1
--   low_payer_50plus_last_month  spent $50-$99 in M-1 (subset of the above)
--   non_payer_last_month       no spend in M-1 (includes first time payers)
--     of which returning       paid at some point before M-1, not in M-1
--   first_club_entry_this_month  first ever club entry (since 2021-01-01) is in M
--   prime_next_month           spent $100+ in M+1 (Jan-Aug only; Sep is blank)
--
-- Monthly RP = SUM(royal_points_credited_or_debited)  (1 RP = $1)
-- Paste the whole script into the BigQuery console and Run.
-- =====================================================================

DECLARE start_month DATE DEFAULT DATE '2026-01-01';
DECLARE end_month   DATE DEFAULT DATE '2026-09-01';  -- month start, inclusive
DECLARE conv_last_month DATE DEFAULT DATE '2026-08-01';  -- last month with a full next month

CREATE TEMP TABLE monthly AS
SELECT
  user_id,
  DATE_TRUNC(date_ast, MONTH) AS month,
  SUM(royal_points_credited_or_debited) AS rp
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
WHERE date_ast >= DATE '2021-01-01'
  AND date_ast < DATE_ADD(end_month, INTERVAL 1 MONTH)
GROUP BY 1, 2
HAVING SUM(royal_points_credited_or_debited) > 0;

CREATE TEMP TABLE user_firsts AS
SELECT
  user_id,
  -- first month with ANY purchase (even if later refunded)
  MIN(DATE_TRUNC(date_ast, MONTH)) AS first_pay_month
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
WHERE date_ast >= DATE '2021-01-01'
  AND royal_points_credited_or_debited > 0
GROUP BY 1;

CREATE TEMP TABLE first_prime AS
SELECT user_id, MIN(IF(rp >= 100, month, NULL)) AS first_prime_month
FROM monthly
GROUP BY 1;

CREATE TEMP TABLE base AS
SELECT
  m.month,
  m.user_id,
  m.rp
FROM monthly m
JOIN first_prime fp ON fp.user_id = m.user_id
WHERE m.month BETWEEN start_month AND end_month
  AND m.rp >= 50 AND m.rp < 100
  AND (fp.first_prime_month IS NULL OR fp.first_prime_month > m.month);

CREATE TEMP TABLE first_entry AS
SELECT e.user_id, DATE_TRUNC(MIN(e.date), MONTH) AS first_entry_month
FROM `parcheesi-star-7168863.ludo.D_club_enter_table` e
JOIN (SELECT DISTINCT user_id FROM base) b ON b.user_id = e.user_id
WHERE e.date >= DATE '2021-01-01'
GROUP BY 1;
-- If D_club_enter_table does not go back to 2021, use raw events instead:
-- SELECT SPLIT(c.user_id, ',')[SAFE_OFFSET(0)] AS user_id,
--        DATE_TRUNC(MIN(DATE(c.server_ts, 'Asia/Riyadh')), MONTH) AS first_entry_month
-- FROM `parcheesi-star-7168863.ludo.clubs` c
-- WHERE c.kingdom = 'club_enter' AND DATE(c.server_ts) >= DATE '2021-01-01'
-- GROUP BY 1

WITH flags AS (
  SELECT
    b.month,
    b.user_id,
    (uf.first_pay_month = b.month) AS is_first_time_payer,
    (prev.user_id IS NOT NULL AND prev.rp < 100) AS is_lp_last_month,
    (prev.rp >= 50 AND prev.rp < 100) AS is_lp50_last_month,
    (prev.user_id IS NULL) AS is_np_last_month,
    (fe.first_entry_month = b.month) AS is_first_club_entry,
    (nx.rp >= 100) AS is_prime_next_month
  FROM base b
  LEFT JOIN user_firsts uf ON uf.user_id = b.user_id
  LEFT JOIN monthly prev ON prev.user_id = b.user_id AND prev.month = DATE_SUB(b.month, INTERVAL 1 MONTH)
  LEFT JOIN monthly nx ON nx.user_id = b.user_id AND nx.month = DATE_ADD(b.month, INTERVAL 1 MONTH)
  LEFT JOIN first_entry fe ON fe.user_id = b.user_id
)
SELECT
  FORMAT_DATE('%b %Y', month) AS month_label,
  COUNT(*) AS lp_50plus_never_prime,
  COUNTIF(is_first_time_payer) AS first_time_payers,
  COUNTIF(is_lp_last_month) AS low_payer_last_month,
  COUNTIF(is_lp50_last_month) AS low_payer_50plus_last_month,
  COUNTIF(is_np_last_month) AS non_payer_last_month,
  COUNTIF(is_np_last_month AND NOT IFNULL(is_first_time_payer, FALSE)) AS non_payer_last_month_returning,
  COUNTIF(is_first_club_entry) AS first_club_entry_this_month,
  IF(month <= conv_last_month, COUNTIF(is_prime_next_month), NULL) AS prime_next_month,
  IF(month <= conv_last_month, ROUND(100 * COUNTIF(is_prime_next_month) / COUNT(*), 2), NULL) AS prime_next_month_pct,
  -- next-month Prime by group (Jan-Aug)
  IF(month <= conv_last_month, COUNTIF(is_prime_next_month AND is_first_time_payer), NULL) AS prime_next_month_from_first_time,
  IF(month <= conv_last_month, COUNTIF(is_prime_next_month AND is_lp_last_month), NULL) AS prime_next_month_from_lp_last_month,
  IF(month <= conv_last_month, COUNTIF(is_prime_next_month AND is_lp50_last_month), NULL) AS prime_next_month_from_lp50_last_month,
  IF(month <= conv_last_month, COUNTIF(is_prime_next_month AND is_np_last_month), NULL) AS prime_next_month_from_np_last_month,
  IF(month <= conv_last_month, COUNTIF(is_prime_next_month AND is_first_club_entry), NULL) AS prime_next_month_from_first_club_entry
FROM flags
GROUP BY month
ORDER BY month;
