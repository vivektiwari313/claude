-- =====================================================================
-- Clubs: September 2026 Royals bucketed by how many clubs each is a
-- MEMBER of (membership held at the end of September 2026)
--
-- Royals of September: 1000+ royal points in Sep 2026 (AST), from
--   ludo.D_all_payers_clubs (the Clubs payer ledger). RP = SUM of
--   royal_points_credited_or_debited on purchase_complete, refund_debit and
--   royal_points_addition rows (bonus / offer / RM points included);
--   monthly_reset rows are left out so the reset of the previous month's
--   points does not cancel this month's. Fraud transactions in
--   ludo.fraud_txn_id are excluded. A USD view ($1000+ net spend) is also
--   given as a flag, because RP includes bonus and streak points.
-- Membership: rebuilt from every club_member_join / club_member_leave up to
--   the snapshot time. A user is a member of a club if their latest event
--   for that club is a join.
--   Old architecture (default): ludo.clubs + yearly archives,
--     join:  member = user_id,               club = split(family)[0]
--     leave: member = split(phylum)[0]       (user_id is removed_by), club = split(family)[0]
--   New architecture (ludo.events, type 'clubs') is added too in case the
--   old table stops receiving events after the migration; duplicates do
--   not matter because only each user-club's latest event is used.
--
-- Results: A. # Royals by # clubs they are a member of
--             (0, 1, 2, 3, 4-5, 6-8, 9-12, 13-20, 21+)
--          B. Summary stats   C. Check: events per source
-- Dry-run first: the membership scan covers all history since 2022.
-- =====================================================================

DECLARE royal_month DATE DEFAULT DATE '2026-09-01';
DECLARE snapshot_ts TIMESTAMP DEFAULT TIMESTAMP('2026-10-01 00:00:00', 'Asia/Riyadh');  -- end of Sep (AST)

-- ---------------- 1. Royals of September ----------------------------
CREATE TEMP TABLE royals AS
SELECT
  p.user_id,
  SUM(IF(p.kingdom != 'monthly_reset', p.royal_points_credited_or_debited, 0)) AS sep_rp,
  SUM(IF(p.kingdom IN ('purchase_complete', 'refund_debit'), p.dollar_value, 0)) AS sep_net_usd
FROM `parcheesi-star-7168863.ludo.D_all_payers_clubs` p
LEFT JOIN `parcheesi-star-7168863.ludo.fraud_txn_id` f ON f.family = p.txn_id
WHERE p.date_ast >= royal_month
  AND p.date_ast < DATE_ADD(royal_month, INTERVAL 1 MONTH)
  AND f.family IS NULL
GROUP BY 1
HAVING SUM(IF(p.kingdom != 'monthly_reset', p.royal_points_credited_or_debited, 0)) >= 1000;

-- ---------------- 2. Membership events (all history) ----------------
CREATE TEMP TABLE member_events AS
WITH royal_ids AS (SELECT user_id FROM royals),
old_arch AS (
  SELECT server_ts, kingdom, user_id, phylum, family FROM `parcheesi-star-7168863.ludo.clubs_2022`
  WHERE server_ts >= TIMESTAMP('2022-05-31') AND server_ts < TIMESTAMP('2023-01-01')
    AND kingdom IN ('club_member_join', 'club_member_leave')
  UNION ALL
  SELECT server_ts, kingdom, user_id, phylum, family FROM `parcheesi-star-7168863.ludo.clubs_2023`
  WHERE server_ts >= TIMESTAMP('2023-01-01') AND server_ts < TIMESTAMP('2024-01-01')
    AND kingdom IN ('club_member_join', 'club_member_leave')
  UNION ALL
  SELECT server_ts, kingdom, user_id, phylum, family FROM `parcheesi-star-7168863.ludo.clubs_2024`
  WHERE server_ts >= TIMESTAMP('2024-01-01') AND server_ts < TIMESTAMP('2025-01-01')
    AND kingdom IN ('club_member_join', 'club_member_leave')
  UNION ALL
  SELECT server_ts, kingdom, user_id, phylum, family FROM `parcheesi-star-7168863.ludo.clubs_2025`
  WHERE server_ts >= TIMESTAMP('2025-01-01') AND server_ts < TIMESTAMP('2025-03-01')
    AND kingdom IN ('club_member_join', 'club_member_leave')
  UNION ALL
  SELECT server_ts, kingdom, user_id, phylum, family FROM `parcheesi-star-7168863.ludo.clubs`
  WHERE server_ts >= TIMESTAMP('2025-03-01') AND server_ts < snapshot_ts
    AND kingdom IN ('club_member_join', 'club_member_leave')
),
ev AS (
  SELECT
    'old' AS src,
    IF(kingdom = 'club_member_join',
       SPLIT(user_id, ',')[SAFE_OFFSET(0)],
       SPLIT(phylum, ',')[SAFE_OFFSET(0)]) AS member_id,
    SPLIT(family, ',')[SAFE_OFFSET(0)] AS club_id,
    kingdom AS action,
    server_ts AS ts
  FROM old_arch
  UNION ALL
  SELECT
    'new',
    -- join: member id may sit inside properties (data validation note)
    IF(name = 'club_member_join',
       COALESCE(JSON_VALUE(properties, '$.user_id'), user_id),
       user_id),
    JSON_VALUE(properties, '$.club_id'),
    name,
    ts
  FROM `parcheesi-star-7168863.ludo.events`
  WHERE DATE(ts) >= DATE '2025-01-01' AND ts < snapshot_ts
    AND type = 'clubs' AND name IN ('club_member_join', 'club_member_leave')
)
SELECT ev.*
FROM ev
JOIN royal_ids r ON r.user_id = ev.member_id
WHERE ev.club_id IS NOT NULL AND ev.club_id != '';

-- ---------------- 3. Clubs each Royal is a member of ----------------
CREATE TEMP TABLE royal_clubs AS
WITH latest AS (
  SELECT member_id, club_id, action
  FROM member_events
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY member_id, club_id
    ORDER BY ts DESC, IF(action = 'club_member_leave', 0, 1), src  -- same second: leave wins
  ) = 1
)
SELECT
  r.user_id,
  r.sep_rp,
  r.sep_net_usd,
  COUNT(DISTINCT IF(l.action = 'club_member_join', l.club_id, NULL)) AS clubs_member_of
FROM royals r
LEFT JOIN latest l ON l.member_id = r.user_id
GROUP BY 1, 2, 3;

-- ---------------- A. # Royals by # clubs they are a member of ------
WITH b AS (
  SELECT
    CASE
      WHEN clubs_member_of = 0 THEN 0 WHEN clubs_member_of = 1 THEN 1
      WHEN clubs_member_of = 2 THEN 2 WHEN clubs_member_of = 3 THEN 3
      WHEN clubs_member_of <= 5 THEN 4 WHEN clubs_member_of <= 8 THEN 5
      WHEN clubs_member_of <= 12 THEN 6 WHEN clubs_member_of <= 20 THEN 7
      ELSE 8
    END AS sort_key,
    CASE
      WHEN clubs_member_of <= 3 THEN CAST(clubs_member_of AS STRING)
      WHEN clubs_member_of <= 5 THEN '4-5'
      WHEN clubs_member_of <= 8 THEN '6-8'
      WHEN clubs_member_of <= 12 THEN '9-12'
      WHEN clubs_member_of <= 20 THEN '13-20'
      ELSE '21+'
    END AS clubs_member_of_bucket,
    clubs_member_of,
    sep_net_usd
  FROM royal_clubs
)
SELECT
  clubs_member_of_bucket,
  COUNT(*) AS royals,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_of_royals,
  ROUND(100 * SUM(COUNT(*)) OVER (ORDER BY sort_key) / SUM(COUNT(*)) OVER (), 1) AS cumulative_pct,
  COUNTIF(sep_net_usd >= 1000) AS royals_with_1000_usd_spend
FROM b
GROUP BY sort_key, clubs_member_of_bucket
ORDER BY sort_key;

-- ---------------- B. Summary stats ----------------------------------
SELECT
  COUNT(*) AS september_royals,
  ROUND(AVG(clubs_member_of), 2) AS avg_clubs_member_of,
  APPROX_QUANTILES(clubs_member_of, 2)[OFFSET(1)] AS median_clubs_member_of,
  MAX(clubs_member_of) AS max_clubs_member_of,
  COUNTIF(clubs_member_of = 0) AS royals_in_no_club,
  COUNTIF(sep_net_usd >= 1000) AS royals_with_1000_usd_spend
FROM royal_clubs;

-- ---------------- C. Check: membership events per source / year -----
-- If 'old' stops in 2026 (migration), the 'new' rows carry the recent months.
SELECT src, EXTRACT(YEAR FROM ts) AS year, action, COUNT(*) AS events,
       COUNT(DISTINCT member_id) AS royals_with_events
FROM member_events
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
