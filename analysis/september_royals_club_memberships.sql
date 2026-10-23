-- =====================================================================
-- Clubs: clubs bucketed by how many September 2026 Royals are MEMBERS
-- of them (membership held at the end of September 2026)
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
--   for that club is a join. Only clubs with at least 1 Royal member appear.
--   Old architecture (default): ludo.clubs + yearly archives,
--     join:  member = user_id,               club = split(family)[0]
--     leave: member = split(phylum)[0]       (user_id is removed_by), club = split(family)[0]
--   New architecture (ludo.events, type 'clubs') is added too in case the
--   old table stops receiving events after the migration; duplicates do
--   not matter because only each user-club's latest event is used.
--
-- Results: A. # clubs by # Royal members (1, 2, 3, 4-5, 6-8, 9-12, 13-20, 21+)
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

-- ---------------- 3. Royals who are members of each club -----------
CREATE TEMP TABLE club_royals AS
WITH latest AS (
  SELECT member_id, club_id, action
  FROM member_events
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY member_id, club_id
    ORDER BY ts DESC, IF(action = 'club_member_leave', 0, 1), src  -- same second: leave wins
  ) = 1
)
SELECT
  l.club_id,
  COUNT(DISTINCT l.member_id) AS royal_members,
  COUNT(DISTINCT IF(r.sep_net_usd >= 1000, l.member_id, NULL)) AS royal_members_1000_usd
FROM latest l
JOIN royals r ON r.user_id = l.member_id
WHERE l.action = 'club_member_join'
GROUP BY 1;

-- ---------------- A. Bucketed table: # clubs by # Royal members -----
WITH b AS (
  SELECT
    CASE
      WHEN royal_members = 1 THEN 1 WHEN royal_members = 2 THEN 2
      WHEN royal_members = 3 THEN 3 WHEN royal_members <= 5 THEN 4
      WHEN royal_members <= 8 THEN 5 WHEN royal_members <= 12 THEN 6
      WHEN royal_members <= 20 THEN 7 ELSE 8
    END AS sort_key,
    CASE
      WHEN royal_members <= 3 THEN CAST(royal_members AS STRING)
      WHEN royal_members <= 5 THEN '4-5'
      WHEN royal_members <= 8 THEN '6-8'
      WHEN royal_members <= 12 THEN '9-12'
      WHEN royal_members <= 20 THEN '13-20'
      ELSE '21+'
    END AS royal_members_bucket,
    royal_members
  FROM club_royals
)
SELECT
  royal_members_bucket,
  COUNT(*) AS clubs,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_of_clubs,
  ROUND(100 * SUM(COUNT(*)) OVER (ORDER BY sort_key) / SUM(COUNT(*)) OVER (), 1) AS cumulative_pct_clubs,
  SUM(royal_members) AS royal_memberships,
  ROUND(100 * SUM(royal_members) / SUM(SUM(royal_members)) OVER (), 1) AS pct_of_royal_memberships
FROM b
GROUP BY sort_key, royal_members_bucket
ORDER BY sort_key;

-- ---------------- B. Summary stats ----------------------------------
SELECT
  (SELECT COUNT(*) FROM royals) AS september_royals,
  (SELECT COUNT(DISTINCT member_id) FROM member_events) AS royals_with_any_membership_event,
  COUNT(*) AS clubs_with_1plus_royal_member,
  SUM(royal_members) AS royal_memberships,
  ROUND(AVG(royal_members), 2) AS avg_royals_per_club,
  APPROX_QUANTILES(royal_members, 2)[OFFSET(1)] AS median_royals_per_club,
  MAX(royal_members) AS max_royals_in_one_club
FROM club_royals;

-- ---------------- C. Check: membership events per source / year -----
-- If 'old' stops in 2026 (migration), the 'new' rows carry the recent months.
SELECT src, EXTRACT(YEAR FROM ts) AS year, action, COUNT(*) AS events,
       COUNT(DISTINCT member_id) AS royals_with_events
FROM member_events
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;
