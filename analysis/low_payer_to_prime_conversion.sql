-- =====================================================================
-- Clubs: Low Payer -> Prime organic conversion & time-to-Prime
-- Paste the whole script into the BigQuery console and Run.
-- The console shows 3 results (one per final SELECT):
--   Result A: Summary (conversion rate of Low Payers -> Prime)
--   Table 1 : Time to become Prime from first month of payment ever
--   Table 2 : Consecutive Low Payer months right before becoming Prime
--
-- Definitions (monthly, per user, from D_all_payers_clubs):
--   RP for month   = SUM(royal_points_credited_or_debited)   (1 RP = $1)
--   Non Payer      = no row / RP <= 0 in that month
--   Low Payer      = 0 < RP < 100
--   Prime          = RP >= 100   (P1/P2/P3 and Royals all count as Prime)
--   First pay month  = first month the user ever had RP > 0
--   First Prime month = first month the user ever had RP >= 100
--   Consecutive LP months = number of back-to-back Low Payer months
--     immediately before the first Prime month (a Non Payer month resets
--     it to 0). e.g. LP Jan, LP Feb, Prime Mar -> 2
--                    LP May, none Jun, Prime Jul -> 0
-- Only complete months are used (the current month is excluded).
-- =====================================================================

DECLARE last_complete_month DATE DEFAULT DATE_SUB(DATE_TRUNC(CURRENT_DATE('Asia/Riyadh'), MONTH), INTERVAL 1 MONTH);
-- Optional: restrict which first-pay-month cohorts are included
-- (e.g. set cohort_end to 12 months ago so every user had a full year to convert).
DECLARE cohort_start DATE DEFAULT DATE '2000-01-01';
DECLARE cohort_end DATE DEFAULT DATE '2100-01-01';

CREATE TEMP TABLE user_months AS
SELECT
  user_id,
  DATE_TRUNC(date_ast, MONTH) AS month,
  SUM(royal_points_credited_or_debited) AS rp
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
WHERE date_ast < DATE_ADD(last_complete_month, INTERVAL 1 MONTH)
GROUP BY 1, 2
HAVING SUM(royal_points_credited_or_debited) > 0;

CREATE TEMP TABLE user_journey AS
WITH m AS (
  SELECT
    user_id,
    month,
    rp,
    IF(rp >= 100, 'Prime', 'Low Payer') AS status,
    DATE_DIFF(month, DATE '2000-01-01', MONTH) AS mi
  FROM user_months
),
isl AS (
  -- gaps-and-islands: consecutive paying months share the same island id
  SELECT *, mi - ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY month) AS island
  FROM m
),
firsts AS (
  SELECT
    user_id,
    MIN(month) AS first_pay_month,
    MIN(IF(status = 'Prime', month, NULL)) AS first_prime_month
  FROM m
  GROUP BY 1
),
prime_island AS (
  SELECT f.user_id, i.island, f.first_prime_month
  FROM firsts f
  JOIN isl i ON i.user_id = f.user_id AND i.month = f.first_prime_month
),
streak AS (
  -- every paying month before the first Prime month is a Low Payer month,
  -- so the streak = months in the same island before the first Prime month
  SELECT p.user_id, COUNTIF(i.month < p.first_prime_month) AS consec_lp_months
  FROM prime_island p
  JOIN isl i ON i.user_id = p.user_id AND i.island = p.island
  GROUP BY 1
),
lp_before AS (
  SELECT f.user_id, COUNTIF(m.month < f.first_prime_month) AS lp_months_before_prime
  FROM firsts f
  JOIN m ON m.user_id = f.user_id
  WHERE f.first_prime_month IS NOT NULL
  GROUP BY 1
)
SELECT
  f.user_id,
  f.first_pay_month,
  s0.status AS first_month_status,
  f.first_prime_month,
  DATE_DIFF(f.first_prime_month, f.first_pay_month, MONTH) AS months_to_prime,  -- 0 = first month of pay
  st.consec_lp_months,
  lb.lp_months_before_prime
FROM firsts f
JOIN m s0 ON s0.user_id = f.user_id AND s0.month = f.first_pay_month
LEFT JOIN streak st ON st.user_id = f.user_id
LEFT JOIN lp_before lb ON lb.user_id = f.user_id
WHERE f.first_pay_month BETWEEN cohort_start AND cohort_end;

-- ---------------------------------------------------------------------
-- Result A: Summary - organic conversion of Low Payers to Prime
-- ---------------------------------------------------------------------
SELECT
  MIN(first_pay_month) AS cohort_from,
  MAX(first_pay_month) AS cohort_to,
  last_complete_month AS data_till_month,
  COUNT(*) AS total_payers_ever,
  COUNTIF(first_month_status = 'Prime') AS prime_in_first_month_of_pay,
  COUNTIF(first_month_status = 'Low Payer') AS started_as_low_payer,
  COUNTIF(first_month_status = 'Low Payer' AND first_prime_month IS NOT NULL) AS low_payers_became_prime,
  ROUND(100 * SAFE_DIVIDE(
    COUNTIF(first_month_status = 'Low Payer' AND first_prime_month IS NOT NULL),
    COUNTIF(first_month_status = 'Low Payer')), 2) AS lp_to_prime_conversion_pct,
  ROUND(100 * SAFE_DIVIDE(
    COUNTIF(first_month_status = 'Low Payer' AND months_to_prime <= 2),
    COUNTIF(first_month_status = 'Low Payer')), 2) AS lp_to_prime_within_3_months_pct,
  ROUND(100 * SAFE_DIVIDE(
    COUNTIF(first_month_status = 'Low Payer' AND months_to_prime <= 5),
    COUNTIF(first_month_status = 'Low Payer')), 2) AS lp_to_prime_within_6_months_pct,
  ROUND(100 * SAFE_DIVIDE(
    COUNTIF(first_month_status = 'Low Payer' AND months_to_prime <= 11),
    COUNTIF(first_month_status = 'Low Payer')), 2) AS lp_to_prime_within_12_months_pct
FROM user_journey;

-- ---------------------------------------------------------------------
-- Table 1: Time to become Prime from first month of payment ever
-- ---------------------------------------------------------------------
WITH b AS (
  SELECT
    CASE
      WHEN months_to_prime IS NULL THEN '99. Never became Prime (yet)'
      WHEN months_to_prime = 0 THEN '01. 1st month of pay'
      WHEN months_to_prime = 1 THEN '02. 2nd month'
      WHEN months_to_prime = 2 THEN '03. 3rd month'
      WHEN months_to_prime = 3 THEN '04. 4th month'
      WHEN months_to_prime = 4 THEN '05. 5th month'
      WHEN months_to_prime = 5 THEN '06. 6th month'
      WHEN months_to_prime BETWEEN 6 AND 11 THEN '07. 7th-12th month'
      ELSE '08. 13th month onwards (12+ months)'
    END AS time_to_prime,
    COUNT(*) AS users
  FROM user_journey
  GROUP BY 1
)
SELECT
  time_to_prime,
  users,
  ROUND(100 * SAFE_DIVIDE(users, SUM(users) OVER ()), 2) AS pct_of_all_payers,
  IF(time_to_prime LIKE '99.%', NULL,
     ROUND(100 * SAFE_DIVIDE(users, SUM(IF(time_to_prime LIKE '99.%', 0, users)) OVER ()), 2)) AS pct_of_prime_converters,
  IF(time_to_prime LIKE '99.%', NULL,
     ROUND(100 * SAFE_DIVIDE(
       SUM(users) OVER (ORDER BY time_to_prime),
       SUM(IF(time_to_prime LIKE '99.%', 0, users)) OVER ()), 2)) AS cumulative_pct_of_prime_converters
FROM b
ORDER BY time_to_prime;

-- ---------------------------------------------------------------------
-- Table 2: Consecutive Low Payer months immediately before first Prime
-- (only users who ever became Prime)
-- ---------------------------------------------------------------------
WITH b AS (
  SELECT
    CASE
      WHEN first_month_status = 'Prime' THEN '00. Prime in 1st month of pay (no prior payment)'
      WHEN consec_lp_months = 0 THEN '01. 0 consecutive months (Non Payer month just before Prime)'
      WHEN consec_lp_months = 1 THEN '02. 1 consecutive month'
      WHEN consec_lp_months = 2 THEN '03. 2 consecutive months'
      WHEN consec_lp_months = 3 THEN '04. 3 consecutive months'
      WHEN consec_lp_months = 4 THEN '05. 4 consecutive months'
      WHEN consec_lp_months = 5 THEN '06. 5 consecutive months'
      WHEN consec_lp_months = 6 THEN '07. 6 consecutive months'
      WHEN consec_lp_months BETWEEN 7 AND 12 THEN '08. 7-12 consecutive months'
      ELSE '09. 12+ consecutive months'
    END AS consecutive_low_payer_months_before_prime,
    COUNT(*) AS users,
    ROUND(AVG(lp_months_before_prime), 2) AS avg_total_lp_months_before_prime
  FROM user_journey
  WHERE first_prime_month IS NOT NULL
  GROUP BY 1
)
SELECT
  consecutive_low_payer_months_before_prime,
  users,
  ROUND(100 * SAFE_DIVIDE(users, SUM(users) OVER ()), 2) AS pct_of_prime_converters,
  ROUND(100 * SAFE_DIVIDE(SUM(users) OVER (ORDER BY consecutive_low_payer_months_before_prime), SUM(users) OVER ()), 2) AS cumulative_pct,
  avg_total_lp_months_before_prime
FROM b
ORDER BY consecutive_low_payer_months_before_prime;
