-- Add 'paywall' and 'login_required' report types to the quality-reports
-- check constraint. These are access-quality signals (the source itself
-- is fine, but the reader can't get past the wall) rather than content
-- complaints, so they get their own bucket in the admin stats and are
-- excluded from the "serious_reports" count that drives auto-hides.
ALTER TABLE news_quality_reports
  DROP CONSTRAINT IF EXISTS news_quality_reports_report_type_check;

ALTER TABLE news_quality_reports
  ADD CONSTRAINT news_quality_reports_report_type_check
  CHECK (report_type = ANY (ARRAY[
    'misleading', 'false_info', 'spam', 'outdated',
    'duplicate', 'low_quality', 'offensive', 'other',
    'rerun_requested',
    'paywall', 'login_required'
  ]));