-- =====================================================================
-- Clubs: New Prime users (first ever Prime month in Jan-Sep 2026)
--   Query 1: Avg transactions in the month they became Prime,
--            one row per month of pay (1st month of pay, 2nd, 3rd ...)
--   Query 2: Users by month since first ever club entry (M0, M1, M2 ...)
-- Paste the whole script into the BigQuery console and Run.
-- The console shows 2 results (Query 1, then Query 2).
--
-- Definitions:
--   Monthly RP = SUM(royal_points_credited_or_debited)  (1 RP = $1)
--   Became Prime = first ever month with RP >= 100
--   Transaction  = one row in D_all_payers_clubs with RP > 0
--   Nth month of pay = calendar months since first ever payment in Clubs, + 1
--     (1st month of pay = became Prime in the month of their first payment)
--   M<N> = calendar months since first ever club entry
--     (M0 = became Prime in the month of their first club entry)
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
--          one row per month of pay
-- ---------------------------------------------------------------------
SELECT
  CONCAT(CAST(pay_month_no AS STRING),
    CASE
      WHEN MOD(pay_month_no, 100) IN (11, 12, 13) THEN 'th'
      WHEN MOD(pay_month_no, 10) = 1 THEN 'st'
      WHEN MOD(pay_month_no, 10) = 2 THEN 'nd'
      WHEN MOD(pay_month_no, 10) = 3 THEN 'rd'
      ELSE 'th'
    END, ' month of pay') AS became_prime_in,
  COUNT(*) AS new_prime_users,
  ROUND(AVG(prime_month_txns), 2) AS avg_transactions_in_prime_month,
  APPROX_QUANTILES(prime_month_txns, 2)[OFFSET(1)] AS median_transactions,
  ROUND(AVG(prime_month_rp), 1) AS avg_spend_usd_in_prime_month
FROM new_primes
GROUP BY pay_month_no
ORDER BY pay_month_no;

-- ---------------------------------------------------------------------
-- Query 2: New Prime users by month since first ever club entry
--          (M0 = month of first club entry, data from 2021-01-01)
-- ---------------------------------------------------------------------
WITH first_entry AS (
  SELECT user_id, MIN(date) AS first_entry_date
  FROM `parcheesi-star-7168863.ludo.D_club_enter_table`
  WHERE date >= DATE '2021-01-01'
  GROUP BY 1
  -- Fallback if D_club_enter_table does not go back far enough (bigger scan):
  -- SELECT user_id, MIN(DATE(server_ts)) AS first_entry_date
  -- FROM `parcheesi-star-7168863.ludo.clubs`
  -- WHERE kingdom = 'club_enter' AND DATE(server_ts) >= DATE '2021-01-01'
  -- GROUP BY 1
),
t AS (
  SELECT
    GREATEST(DATE_DIFF(p.first_prime_month, DATE_TRUNC(e.first_entry_date, MONTH), MONTH), -1) AS m_no
  FROM new_primes p
  LEFT JOIN first_entry e ON e.user_id = p.user_id
)
SELECT
  CASE
    WHEN m_no IS NULL THEN 'No club entry found'
    WHEN m_no < 0 THEN 'Prime before first recorded entry'
    ELSE CONCAT('M', CAST(m_no AS STRING))
  END AS became_prime_in,
  COUNT(*) AS new_prime_users
FROM t
GROUP BY m_no, became_prime_in
ORDER BY IFNULL(m_no, 99999);
