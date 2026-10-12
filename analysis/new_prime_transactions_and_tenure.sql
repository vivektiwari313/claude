-- =====================================================================
-- Clubs: New Prime users (first ever Prime month in Jan-Sep 2026)
--   Query 1: Avg transactions in the month they became Prime,
--            by pay month (1st month of pay, 2nd, 3rd ...)
--   Query 2: Months from first ever club entry to becoming Prime
-- Paste the whole script into the BigQuery console and Run.
-- The console shows 2 results (Query 1, then Query 2).
--
-- Definitions (same as low_payer_to_prime_conversion.sql):
--   Monthly RP = SUM(royal_points_credited_or_debited)  (1 RP = $1)
--   Prime month = month with RP >= 100; "became Prime" = first ever Prime month
--   Transaction = one row in D_all_payers_clubs with RP > 0
--     (refund/debit rows are not counted as transactions)
--   Pay month N = calendar months since first ever paying month, + 1
--     (1 = became Prime in the same month as their first payment)
--   Club month N = calendar months since first ever club entry, + 1
--     (1 = became Prime in the same month as their first club entry)
-- =====================================================================

DECLARE prime_from DATE DEFAULT DATE '2026-01-01';
DECLARE prime_to   DATE DEFAULT DATE '2026-09-01';  -- month start, inclusive

CREATE TEMP TABLE new_primes AS
WITH monthly AS (
  SELECT
    user_id,
    DATE_TRUNC(date_ast, MONTH) AS month,
    SUM(royal_points_credited_or_debited) AS rp,
    COUNTIF(royal_points_credited_or_debited > 0) AS txns
  FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
  WHERE date_ast < DATE_ADD(prime_to, INTERVAL 1 MONTH)
  GROUP BY 1, 2
  HAVING SUM(royal_points_credited_or_debited) > 0
),
firsts AS (
  SELECT
    user_id,
    MIN(month) AS first_pay_month,
    MIN(IF(rp >= 100, month, NULL)) AS first_prime_month
  FROM monthly
  GROUP BY 1
)
SELECT
  f.user_id,
  f.first_pay_month,
  f.first_prime_month,
  DATE_DIFF(f.first_prime_month, f.first_pay_month, MONTH) + 1 AS pay_month_no,
  m.txns AS prime_month_txns,
  m.rp AS prime_month_rp
FROM firsts f
JOIN monthly m ON m.user_id = f.user_id AND m.month = f.first_prime_month
WHERE f.first_prime_month BETWEEN prime_from AND prime_to;

-- ---------------------------------------------------------------------
-- Query 1: Avg transactions in the month users became Prime,
--          by which month of pay it was
-- ---------------------------------------------------------------------
WITH b AS (
  SELECT
    IF(pay_month_no <= 12, pay_month_no, IF(pay_month_no <= 24, 13, 25)) AS sort_key,
    CASE
      WHEN pay_month_no <= 12 THEN FORMAT('Pay month %d', pay_month_no)
      WHEN pay_month_no <= 24 THEN 'Pay month 13-24'
      ELSE 'Pay month 25+'
    END AS became_prime_in,
    prime_month_txns,
    prime_month_rp
  FROM new_primes
  UNION ALL
  SELECT 999, 'All new Primes', prime_month_txns, prime_month_rp
  FROM new_primes
)
SELECT
  became_prime_in,
  COUNT(*) AS new_prime_users,
  ROUND(AVG(prime_month_txns), 2) AS avg_transactions_in_prime_month,
  APPROX_QUANTILES(prime_month_txns, 2)[OFFSET(1)] AS median_transactions,
  ROUND(AVG(prime_month_rp), 1) AS avg_spend_usd_in_prime_month,
  ROUND(SAFE_DIVIDE(SUM(prime_month_rp), SUM(prime_month_txns)), 2) AS avg_transaction_size_usd
FROM b
GROUP BY sort_key, became_prime_in
ORDER BY sort_key;

-- ---------------------------------------------------------------------
-- Query 2: Months from first ever club entry (since 2021-01-01)
--          to becoming Prime
-- ---------------------------------------------------------------------
WITH first_entry AS (
  SELECT user_id, MIN(date) AS first_entry_date
  FROM `parcheesi-star-7168863.ludo.D_club_enter_table`
  WHERE date >= DATE '2021-01-01'
  GROUP BY 1
  -- If D_club_enter_table does not go back far enough, use the raw events instead
  -- (much bigger scan):
  -- SELECT user_id, MIN(DATE(server_ts)) AS first_entry_date
  -- FROM `parcheesi-star-7168863.ludo.clubs`
  -- WHERE kingdom = 'club_enter' AND DATE(server_ts) >= DATE '2021-01-01'
  -- GROUP BY 1
),
t AS (
  SELECT
    p.user_id,
    DATE_DIFF(p.first_prime_month, DATE_TRUNC(e.first_entry_date, MONTH), MONTH) + 1 AS club_month_no
  FROM new_primes p
  LEFT JOIN first_entry e ON e.user_id = p.user_id
),
b AS (
  SELECT
    CASE
      WHEN club_month_no IS NULL THEN 99999
      WHEN club_month_no < 1 THEN 0
      ELSE club_month_no
    END AS sort_key,
    CASE
      WHEN club_month_no IS NULL THEN 'No club entry found'
      WHEN club_month_no < 1 THEN 'Prime before first recorded entry'
      ELSE FORMAT('Month %d', club_month_no)
    END AS became_prime_in,
    COUNT(*) AS users
  FROM t
  GROUP BY 1, 2
)
SELECT
  became_prime_in,
  users,
  ROUND(100 * SAFE_DIVIDE(users, SUM(users) OVER ()), 2) AS pct_of_new_primes,
  ROUND(100 * SAFE_DIVIDE(SUM(users) OVER (ORDER BY sort_key), SUM(users) OVER ()), 2) AS cumulative_pct
FROM b
ORDER BY sort_key;
