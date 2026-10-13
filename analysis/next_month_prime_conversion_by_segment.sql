-- =====================================================================
-- Clubs: Who becomes Prime next month? Month by month, Jan-Sep 2026
-- For each month M, users are classified by what they were in M-1,
-- and we count how many of them are Prime ($100+) in M.
--
--   Segment 1: Low Payer in M-1, never Prime before M        (history from 2021-01-01)
--   Segment 2: Non Payer in M-1, never Prime before M        (history from 2021-01-01)
--   Segment 3: Low Payer in M-1, was Prime/Royal at some point before M-1
--
-- Definitions:
--   Monthly RP = SUM(royal_points_credited_or_debited)  (1 RP = $1)
--   Low Payer = 1-99 RP in the month, Prime = 100+ RP (P1/P2/P3/Royal)
--   Non Payer = no RP in the month
--   Segment 2 base = users who entered a club in M-1 (D_club_enter_table)
--     but did not pay. Segment 2 converters are shown two ways: all users
--     who went from no payment to first ever Prime, and the subset who
--     had entered a club in M-1 (the one used for the conversion %).
--
-- Paste the whole script into the BigQuery console and Run.
-- The last result is the month-by-month table.
-- =====================================================================

DECLARE start_month DATE DEFAULT DATE '2026-01-01';
DECLARE end_month   DATE DEFAULT DATE '2026-09-01';  -- month start, inclusive

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

CREATE TEMP TABLE first_prime AS
SELECT user_id, MIN(IF(rp >= 100, month, NULL)) AS first_prime_month
FROM monthly
GROUP BY 1;

CREATE TEMP TABLE club_active AS
SELECT DISTINCT DATE_TRUNC(date, MONTH) AS month, user_id
FROM `parcheesi-star-7168863.ludo.D_club_enter_table`
WHERE date >= DATE_SUB(start_month, INTERVAL 1 MONTH)
  AND date < end_month;

WITH months AS (
  SELECT m FROM UNNEST(GENERATE_DATE_ARRAY(start_month, end_month, INTERVAL 1 MONTH)) AS m
),
-- Segments 1 and 3: Low Payers in M-1
lp_prev AS (
  SELECT
    mo.m,
    p.user_id,
    (fp.first_prime_month IS NULL OR fp.first_prime_month >= mo.m) AS is_seg1,
    (fp.first_prime_month < p.month) AS is_seg3
  FROM months mo
  JOIN monthly p ON p.month = DATE_SUB(mo.m, INTERVAL 1 MONTH) AND p.rp < 100
  JOIN first_prime fp ON fp.user_id = p.user_id
),
seg13 AS (
  SELECT
    l.m,
    COUNTIF(l.is_seg1) AS s1_base,
    COUNTIF(l.is_seg1 AND c.user_id IS NOT NULL) AS s1_prime_next_month,
    COUNTIF(l.is_seg3) AS s3_base,
    COUNTIF(l.is_seg3 AND c.user_id IS NOT NULL) AS s3_prime_next_month
  FROM lp_prev l
  LEFT JOIN monthly c ON c.user_id = l.user_id AND c.month = l.m AND c.rp >= 100
  GROUP BY 1
),
-- Segment 2 base: entered a club in M-1, no payment in M-1, never Prime before M
seg2_base AS (
  SELECT mo.m, COUNT(*) AS s2_base
  FROM months mo
  JOIN club_active a ON a.month = DATE_SUB(mo.m, INTERVAL 1 MONTH)
  LEFT JOIN monthly p ON p.user_id = a.user_id AND p.month = a.month
  LEFT JOIN first_prime fp ON fp.user_id = a.user_id
  WHERE p.user_id IS NULL
    AND (fp.first_prime_month IS NULL OR fp.first_prime_month >= mo.m)
  GROUP BY 1
),
-- Segment 2 converters: first ever Prime in M, no payment in M-1
seg2_conv AS (
  SELECT
    c.month AS m,
    COUNT(*) AS s2_prime_next_month_all,
    COUNTIF(a.user_id IS NOT NULL) AS s2_prime_next_month_club_active
  FROM monthly c
  JOIN first_prime fp ON fp.user_id = c.user_id AND fp.first_prime_month = c.month
  LEFT JOIN monthly p ON p.user_id = c.user_id AND p.month = DATE_SUB(c.month, INTERVAL 1 MONTH)
  LEFT JOIN club_active a ON a.user_id = c.user_id AND a.month = DATE_SUB(c.month, INTERVAL 1 MONTH)
  WHERE c.month BETWEEN start_month AND end_month
    AND p.user_id IS NULL
  GROUP BY 1
)
SELECT
  FORMAT_DATE('%b %Y', mo.m) AS prime_month,
  -- Segment 1: Low Payer last month, never Prime
  IFNULL(s13.s1_base, 0) AS s1_low_payers_last_month,
  IFNULL(s13.s1_prime_next_month, 0) AS s1_became_prime,
  ROUND(100 * SAFE_DIVIDE(s13.s1_prime_next_month, s13.s1_base), 2) AS s1_conversion_pct,
  -- Segment 2: Non Payer last month, never Prime
  IFNULL(b2.s2_base, 0) AS s2_non_payers_last_month_club_active,
  IFNULL(c2.s2_prime_next_month_club_active, 0) AS s2_became_prime_club_active,
  ROUND(100 * SAFE_DIVIDE(c2.s2_prime_next_month_club_active, b2.s2_base), 4) AS s2_conversion_pct,
  IFNULL(c2.s2_prime_next_month_all, 0) AS s2_became_prime_all,
  -- Segment 3: Prime/Royal in the past, Low Payer last month
  IFNULL(s13.s3_base, 0) AS s3_ex_primes_low_payer_last_month,
  IFNULL(s13.s3_prime_next_month, 0) AS s3_became_prime,
  ROUND(100 * SAFE_DIVIDE(s13.s3_prime_next_month, s13.s3_base), 2) AS s3_conversion_pct
FROM months mo
LEFT JOIN seg13 s13 ON s13.m = mo.m
LEFT JOIN seg2_base b2 ON b2.m = mo.m
LEFT JOIN seg2_conv c2 ON c2.m = mo.m
ORDER BY mo.m;
