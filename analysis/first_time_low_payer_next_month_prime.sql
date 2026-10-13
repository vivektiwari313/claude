-- =====================================================================
-- Clubs: First time ever Non Payer -> Low Payer, and how many of them
-- become Prime the next month. Month on month, Jan-Aug 2026.
--
--   Month M row = users whose first ever payment month is M
--                 (never paid at all from 2021-01-01 up to M-1,
--                  not even a purchase that was later refunded)
--                 and who spent 1-99 RP in M (Low Payer)
--   Prime next month = those users with 100+ RP in M+1
--
-- Definitions:
--   Monthly RP = SUM(royal_points_credited_or_debited)  (1 RP = $1)
--   Low Payer = 1-99 RP in the month, Prime = 100+ RP (P1/P2/P3/Royal)
--
-- Paste the whole script into the BigQuery console and Run.
-- =====================================================================

DECLARE start_month DATE DEFAULT DATE '2026-01-01';
DECLARE end_month   DATE DEFAULT DATE '2026-08-01';  -- month start, inclusive

WITH monthly AS (
  SELECT
    user_id,
    DATE_TRUNC(date_ast, MONTH) AS month,
    SUM(royal_points_credited_or_debited) AS rp
  FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
  WHERE date_ast >= DATE '2021-01-01'
    AND date_ast < DATE_ADD(end_month, INTERVAL 2 MONTH)  -- includes M+1 of the last month
  GROUP BY 1, 2
  HAVING SUM(royal_points_credited_or_debited) > 0
),
-- First ever paying month since 2021-01-01: the first month with ANY purchase
-- (RP > 0), even if it was later refunded, so the user was a Non Payer in
-- every month from 2021-01-01 up to M-1
first_pay AS (
  SELECT user_id, MIN(DATE_TRUNC(date_ast, MONTH)) AS first_pay_month
  FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
  WHERE date_ast >= DATE '2021-01-01'
    AND royal_points_credited_or_debited > 0
  GROUP BY 1
),
new_payers AS (
  SELECT
    f.first_pay_month AS m,
    f.user_id,
    fm.rp AS first_month_rp,
    nx.rp AS next_month_rp
  FROM first_pay f
  JOIN monthly fm ON fm.user_id = f.user_id AND fm.month = f.first_pay_month
  LEFT JOIN monthly nx ON nx.user_id = f.user_id AND nx.month = DATE_ADD(f.first_pay_month, INTERVAL 1 MONTH)
  WHERE f.first_pay_month BETWEEN start_month AND end_month
),
months AS (
  SELECT m FROM UNNEST(GENERATE_DATE_ARRAY(start_month, end_month, INTERVAL 1 MONTH)) AS m
),
agg AS (
  SELECT
    m,
    COUNT(*) AS all_first_time_payers,
    COUNTIF(first_month_rp < 100) AS first_time_low_payers,
    COUNTIF(first_month_rp < 100 AND next_month_rp >= 100) AS prime_next_month,
    COUNTIF(first_month_rp < 100 AND next_month_rp < 100) AS low_payer_again_next_month,
    COUNTIF(first_month_rp < 100 AND next_month_rp IS NULL) AS non_payer_next_month,
    COUNTIF(first_month_rp >= 100) AS first_time_payers_straight_to_prime
  FROM new_payers
  GROUP BY 1
)
SELECT
  FORMAT_DATE('%b %Y', mo.m) AS first_low_payer_month,
  FORMAT_DATE('%b %Y', DATE_ADD(mo.m, INTERVAL 1 MONTH)) AS next_month,
  IFNULL(a.first_time_low_payers, 0) AS non_payer_to_low_payer_first_time,
  IFNULL(a.prime_next_month, 0) AS became_prime_next_month,
  ROUND(100 * SAFE_DIVIDE(a.prime_next_month, a.first_time_low_payers), 2) AS prime_next_month_pct,
  IFNULL(a.low_payer_again_next_month, 0) AS low_payer_again_next_month,
  IFNULL(a.non_payer_next_month, 0) AS non_payer_next_month,
  -- context: first time payers who skipped Low Payer and went straight to Prime in M
  IFNULL(a.first_time_payers_straight_to_prime, 0) AS first_time_payers_straight_to_prime,
  IFNULL(a.all_first_time_payers, 0) AS all_first_time_payers
FROM months mo
LEFT JOIN agg a ON a.m = mo.m
ORDER BY mo.m;
