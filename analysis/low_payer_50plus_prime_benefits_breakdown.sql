-- =====================================================================
-- Clubs: $50+ Low Payers (never Prime) who became PRIME in Month 2 -
-- breakdown of every Prime benefit item, by Prime tier, M1 / M2 / M3
--
-- Cohort: spent $50-$99 in M1 (Jan-Aug 2026, Silver USD), never Prime
--   before, 100-999 RP in M2 (royal_status if present, else
--   D_all_payers_clubs). Pooled across all Month 1s.
-- Prime tier from M2 royal points: P1 = 100-199, P2 = 200-499,
--   P3 = 500-999 (tiers at $100 / $200 / $500). "All Prime" = all three.
-- Months: M1, M2, M3. Tier rewards are granted on the 1st of the month
--   after reaching the tier, so M3 is where most benefit use should show.
--   (M3 of the Aug 2026 cohort is Oct 2026, still in progress.)
-- Benefit items (one row each):
--   * Royal emoji     emoji_on_mic, each emoji_id containing 'tiger' or
--                     'panda' (e.g. clubs_emoji_tigerkiss)
--   * Party Cap gift  send_gift gift_id 51 (mic pop gift)
--   * Perfume gift    send_gift gift_id 36
--   * Prime cosmetics cosmetic_user with rwd_type = 1 (Royalty tiers
--                     reward) and royalty_type = 1 (Prime): each
--                     cosmetic_type / cosmetic_id granted (frame, chat
--                     bubble, entry effect, profile theme, ...), and
--                     use_user_cosmetic use_flg = 1 for that same item
--                     after it was granted.
-- Sources: ludo.events (type 'clubs') and the old ludo.clubs, with field
--   positions from the Clubs tracking plan (old_mapping).
--
-- Results: A. Benefit breakdown by tier and month   B. M3 view, tiers side by side
--          C. Cohort size by tier                   D. Check: Prime cosmetics granted
-- Dry-run first: emoji_on_mic and send_gift are heavy events.
-- =====================================================================

-- ---------------------------- CONFIG ---------------------------------
DECLARE m1_from DATE DEFAULT DATE '2026-01-01';
DECLARE m1_to   DATE DEFAULT DATE '2026-08-01';
DECLARE m1_min_usd FLOAT64 DEFAULT 50;
DECLARE m1_max_usd FLOAT64 DEFAULT 100;          -- exclusive
DECLARE party_cap_gift_id STRING DEFAULT '51';
DECLARE perfume_gift_id   STRING DEFAULT '36';
DECLARE data_from DATE;
DECLARE data_to   DATE;
SET data_from = m1_from;
SET data_to   = LEAST(DATE_ADD(m1_to, INTERVAL 3 MONTH), CURRENT_DATE('Asia/Riyadh'));  -- up to M3

-- ---------------- 1. Purchases (Silver, USD) -------------------------
CREATE TEMP TABLE purchases AS
SELECT
  user_id,
  family AS purchase_id,
  MIN(server_ts) AS purchase_ts,
  MIN(date) AS date,
  SUM(dollar_value) AS usd,
  LOGICAL_OR(IFNULL(mode_of_payment = 'Offline', FALSE)) AS is_offline
FROM `parcheesi-star-7168863.Intermediate_Silver.LS_I_Daily_Purchase_Info`
WHERE date >= data_from AND date < data_to
  AND class = 'hearts' AND dollar_value > 0
GROUP BY 1, 2;

CREATE TEMP TABLE monthly_usd AS
SELECT user_id, DATE_TRUNC(DATE(purchase_ts, 'Asia/Riyadh'), MONTH) AS month, SUM(usd) AS usd
FROM purchases
GROUP BY 1, 2;

-- ---------------- 2. Royal points per month --------------------------
CREATE TEMP TABLE monthly_pay_rp AS
SELECT user_id, DATE_TRUNC(date_ast, MONTH) AS month,
       SUM(royal_points_credited_or_debited) AS pay_rp
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs`
WHERE date_ast >= DATE '2021-01-01' AND date_ast < data_to
GROUP BY 1, 2;

-- royal_status (old architecture): split(phylum)[0] = month's royal
-- points, sent at the month-start reset for the previous month.
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
  IFNULL(s.stat_rp, IFNULL(p.pay_rp, 0)) AS rp
FROM monthly_pay_rp p
FULL OUTER JOIN monthly_stat_rp s ON s.user_id = p.user_id AND s.month = p.month;

-- --------------------------- 3. Cohort -------------------------------
CREATE TEMP TABLE cohort AS
WITH fp AS (
  SELECT user_id, MIN(IF(rp >= 100, month, NULL)) AS first_prime_month
  FROM monthly_rp GROUP BY 1
),
q AS (
  SELECT u.user_id, u.month AS m1
  FROM monthly_usd u
  LEFT JOIN fp ON fp.user_id = u.user_id
  WHERE u.month BETWEEN m1_from AND m1_to
    AND u.usd >= m1_min_usd AND u.usd < m1_max_usd
    AND (fp.first_prime_month IS NULL OR fp.first_prime_month > u.month)
),
seg AS (
  SELECT
    q.user_id, q.m1, r2.rp AS m2_rp,
    CASE
      WHEN IFNULL(r2.rp, 0) >= 1000 THEN 'royal'
      WHEN IFNULL(r2.rp, 0) >= 100  THEN '3. Prime in M2 (100-999 RP)'
      WHEN u2.usd > 0 OR r2.pay_rp > 0 THEN '2. Low Payer in M2 (1-99 RP)'
      ELSE 'non_payer'
    END AS segment
  FROM q
  LEFT JOIN monthly_rp r2  ON r2.user_id = q.user_id AND r2.month = DATE_ADD(q.m1, INTERVAL 1 MONTH)
  LEFT JOIN monthly_usd u2 ON u2.user_id = q.user_id AND u2.month = DATE_ADD(q.m1, INTERVAL 1 MONTH)
)
SELECT * FROM seg WHERE segment LIKE '3.%';

CREATE TEMP TABLE cohort_tier AS
SELECT
  user_id, m1, m2_rp,
  CASE WHEN m2_rp >= 500 THEN 'P3' WHEN m2_rp >= 200 THEN 'P2' ELSE 'P1' END AS tier
FROM cohort;

-- -------------- 4. Raw benefit events for cohort users -------------
CREATE TEMP TABLE benefit_ev AS
WITH users AS (SELECT DISTINCT user_id FROM cohort_tier),
e AS (
  -- Royal emoji (new / old)
  SELECT user_id, ts AS event_ts, 'use' AS action, 'Royal emoji' AS category,
         JSON_VALUE(properties, '$.emoji_id') AS item, 1 AS qty, 0 AS hearts
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'emoji_on_mic'
  UNION ALL
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts, 'use', 'Royal emoji',
         SPLIT(class, ',')[SAFE_OFFSET(0)], 1, 0
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'emoji_on_mic'
  UNION ALL
  -- Gifts (new / old); one row per gift transaction
  SELECT user_id, ts, 'use', 'Gift', JSON_VALUE(properties, '$.gift_id'),
         SAFE_CAST(JSON_VALUE(properties, '$.gift_qty') AS INT64),
         SAFE_CAST(JSON_VALUE(properties, '$.hearts_out') AS INT64)
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'send_gift'
  UNION ALL
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts, 'use', 'Gift',
         SPLIT(class, ',')[SAFE_OFFSET(0)],
         SAFE_CAST(SPLIT(class, ',')[SAFE_OFFSET(1)] AS INT64),
         SAFE_CAST(genus AS INT64)
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'send_gift'
  UNION ALL
  -- Prime tier cosmetics granted (new): rwd_type 1 = Royalty tiers, royalty_type 1 = Prime
  SELECT user_id, ts, 'grant', 'Prime cosmetic',
         CONCAT(IFNULL(JSON_VALUE(properties, '$.cosmetic_type'), '?'), ': ', IFNULL(JSON_VALUE(properties, '$.cosmetic_id'), '?')),
         1, 0
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'cosmetic_user'
    AND SAFE_CAST(JSON_VALUE(properties, '$.rwd_type') AS INT64) = 1
    AND SAFE_CAST(JSON_VALUE(properties, '$.royalty_type') AS INT64) = 1
  UNION ALL
  -- (old): rwd_type = order, royalty_type = split(split(subspecies)[0],'_')[0]
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts, 'grant', 'Prime cosmetic',
         CONCAT(IFNULL(SPLIT(phylum, ',')[SAFE_OFFSET(0)], '?'), ': ', IFNULL(SPLIT(class, ',')[SAFE_OFFSET(0)], '?')),
         1, 0
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'cosmetic_user'
    AND SAFE_CAST(`order` AS INT64) = 1
    AND SPLIT(SPLIT(subspecies, ',')[SAFE_OFFSET(0)], '_')[SAFE_OFFSET(0)] = '1'
  UNION ALL
  -- Cosmetic applied (new / old): use_flg = 1
  SELECT user_id, ts, 'apply', 'Prime cosmetic',
         CONCAT(IFNULL(JSON_VALUE(properties, '$.cosmetic_type'), '?'), ': ', IFNULL(JSON_VALUE(properties, '$.cosmetic_id'), '?')),
         1, 0
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND type = 'clubs' AND name = 'use_user_cosmetic'
    AND SAFE_CAST(JSON_VALUE(properties, '$.use_flg') AS INT64) = 1
  UNION ALL
  SELECT SPLIT(user_id, ',')[SAFE_OFFSET(0)], server_ts, 'apply', 'Prime cosmetic',
         CONCAT(IFNULL(SPLIT(phylum, ',')[SAFE_OFFSET(0)], '?'), ': ', IFNULL(SPLIT(class, ',')[SAFE_OFFSET(0)], '?')),
         1, 0
  FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE DATE(server_ts) BETWEEN DATE_SUB(data_from, INTERVAL 1 DAY) AND data_to
    AND kingdom = 'use_user_cosmetic'
    AND SAFE_CAST(genus AS INT64) = 1
)
SELECT DISTINCT
  e.user_id, TIMESTAMP_TRUNC(e.event_ts, SECOND) AS event_ts, e.action, e.category,
  CASE
    WHEN e.category = 'Gift' AND REGEXP_EXTRACT(e.item, r'(\d+)$') = party_cap_gift_id THEN 'Party Cap gift (51)'
    WHEN e.category = 'Gift' AND REGEXP_EXTRACT(e.item, r'(\d+)$') = perfume_gift_id   THEN 'Perfume gift (36)'
    ELSE e.item
  END AS item,
  e.qty, e.hearts
FROM e
JOIN users u ON u.user_id = e.user_id
WHERE (e.category = 'Royal emoji' AND (LOWER(e.item) LIKE '%tiger%' OR LOWER(e.item) LIKE '%panda%'))
   OR (e.category = 'Gift' AND REGEXP_EXTRACT(e.item, r'(\d+)$') IN (party_cap_gift_id, perfume_gift_id))
   OR  e.category = 'Prime cosmetic';

-- -------------- 5. Per cohort row: grants and uses by month ---------
CREATE TEMP TABLE cohort_benefit AS
WITH ev AS (
  SELECT
    c.user_id, c.m1, c.tier, b.*  EXCEPT (user_id),
    DATE_DIFF(DATE_TRUNC(DATE(b.event_ts, 'Asia/Riyadh'), MONTH), c.m1, MONTH) + 1 AS mo
  FROM cohort_tier c
  JOIN benefit_ev b ON b.user_id = c.user_id
),
in_window AS (SELECT * FROM ev WHERE mo IN (1, 2, 3)),
grants AS (
  -- first Prime-reward grant of each cosmetic per cohort row
  SELECT user_id, m1, item, MIN(event_ts) AS grant_ts
  FROM in_window WHERE action = 'grant' GROUP BY 1, 2, 3
)
SELECT
  w.user_id, w.m1, w.tier, w.category, w.item, w.mo, w.action,
  w.qty, w.hearts, w.event_ts
FROM in_window w
LEFT JOIN grants g ON g.user_id = w.user_id AND g.m1 = w.m1 AND g.item = w.item
-- an applied cosmetic only counts if it is one of the user's Prime rewards
-- and was applied after it was granted
WHERE w.action != 'apply' OR (g.grant_ts IS NOT NULL AND w.event_ts >= g.grant_ts);

-- ---------------- A. Breakdown by tier, benefit item and month ------
WITH tiers AS (
  SELECT tier, user_id, m1 FROM cohort_tier
  UNION ALL
  SELECT 'All Prime', user_id, m1 FROM cohort_tier
),
sizes AS (SELECT tier, COUNT(*) AS cohort_user_months FROM tiers GROUP BY 1),
x AS (
  SELECT t.tier, b.category, b.item, b.mo, b.action, b.user_id, b.m1, b.qty, b.hearts
  FROM cohort_benefit b
  JOIN tiers t ON t.user_id = b.user_id AND t.m1 = b.m1
)
SELECT
  x.tier,
  x.category,
  x.item AS benefit_item,
  FORMAT('M%d', x.mo) AS month,
  s.cohort_user_months,
  COUNT(DISTINCT IF(x.action = 'grant', CONCAT(x.user_id, '|', CAST(x.m1 AS STRING)), NULL)) AS users_granted,
  COUNT(DISTINCT IF(x.action IN ('use', 'apply'), CONCAT(x.user_id, '|', CAST(x.m1 AS STRING)), NULL)) AS users_used,
  ROUND(100 * COUNT(DISTINCT IF(x.action IN ('use', 'apply'), CONCAT(x.user_id, '|', CAST(x.m1 AS STRING)), NULL))
        / s.cohort_user_months, 2) AS pct_of_tier_used,
  COUNTIF(x.action IN ('use', 'apply')) AS times_used,
  SUM(IF(x.action = 'use', x.qty, 0)) AS quantity,
  SUM(IF(x.action = 'use', x.hearts, 0)) AS hearts_spent
FROM x
JOIN sizes s USING (tier)
GROUP BY x.tier, x.category, x.item, x.mo, s.cohort_user_months
ORDER BY
  CASE x.tier WHEN 'All Prime' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
  x.category, x.item, x.mo;

-- ---------------- B. M3 view: % of each tier using each item --------
WITH n AS (
  SELECT
    COUNTIF(tier = 'P1') AS p1, COUNTIF(tier = 'P2') AS p2,
    COUNTIF(tier = 'P3') AS p3, COUNT(*) AS all_prime
  FROM cohort_tier
),
u AS (
  SELECT category, item,
    COUNT(DISTINCT IF(tier = 'P1', CONCAT(user_id, '|', CAST(m1 AS STRING)), NULL)) AS p1_users,
    COUNT(DISTINCT IF(tier = 'P2', CONCAT(user_id, '|', CAST(m1 AS STRING)), NULL)) AS p2_users,
    COUNT(DISTINCT IF(tier = 'P3', CONCAT(user_id, '|', CAST(m1 AS STRING)), NULL)) AS p3_users,
    COUNT(DISTINCT CONCAT(user_id, '|', CAST(m1 AS STRING))) AS all_users
  FROM cohort_benefit
  WHERE mo = 3 AND action IN ('use', 'apply')
  GROUP BY 1, 2
)
SELECT
  u.category, u.item AS benefit_item,
  ROUND(100 * SAFE_DIVIDE(u.p1_users, n.p1), 2) AS p1_pct_used_m3,
  ROUND(100 * SAFE_DIVIDE(u.p2_users, n.p2), 2) AS p2_pct_used_m3,
  ROUND(100 * SAFE_DIVIDE(u.p3_users, n.p3), 2) AS p3_pct_used_m3,
  ROUND(100 * SAFE_DIVIDE(u.all_users, n.all_prime), 2) AS all_prime_pct_used_m3,
  u.all_users AS all_prime_users_used_m3
FROM u CROSS JOIN n
ORDER BY u.category, u.all_users DESC;

-- ---------------- C. Cohort size by tier ----------------------------
SELECT FORMAT_DATE('%b %Y', m1) AS month_1, tier, COUNT(*) AS users
FROM cohort_tier GROUP BY m1, tier ORDER BY m1, tier;

-- ---------------- D. Check: Prime cosmetics granted to the cohort ---
SELECT item AS cosmetic, FORMAT('M%d', mo) AS month, COUNT(DISTINCT user_id) AS users_granted
FROM cohort_benefit WHERE action = 'grant'
GROUP BY item, mo ORDER BY users_granted DESC;
