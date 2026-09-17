# nakom-admin

Admin dashboard for nakom.is (https://admin.nakom.is): chat analytics, spam
detection and blocking. AWS account `nakom.is-admin`, eu-west-2. See
`README.md` for architecture, deploy order and development.

Plane project: **Nakom Admin** (`ADMIN`), https://plane.home.nakomis.com.

## ⚠️ Open issue — read before working on analytics (ADMIN-14)

As of 17 Sep 2026 the cv-chat analytics move off Aurora (MULTI-4) is **not
finished**, even though ADMIN-7 and ADMIN-10 sit in "Ready for test":

- Luke's `admin_analytics` database (container `admin-analytics-db`, port 5433,
  HOME-299) has **no tables**. The ADMIN-7 backfill never populated it.
- The old Aurora cluster was **deleted on 17 Sep 2026** (ADMIN-10), along with
  `AdminAnalyticsStack` and the orphan `PostgresQueryStack`. A final snapshot
  is kept: `admin-analytics-aurora-final-2026-09-17`. The source of truth for
  the backfill is DynamoDB `cv-chat-logs` (42 records).
- Because the database is empty, home-infra's `scripts/luke/run-backups.sh`
  no longer backs it up (home-infra #276). Re-add it once there is data.

Work through ADMIN-14 before anything else touching analytics, and delete this
section when it is Done.
