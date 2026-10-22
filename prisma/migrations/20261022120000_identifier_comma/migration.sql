-- Student labels were saved as "Name — RegNumber". The app no longer uses
-- dashes in text it shows, so existing labels switch to "Name, RegNumber".
-- Data only: no tables or columns change.
UPDATE "Script"
SET "studentIdentifier" = replace("studentIdentifier", ' — ', ', ')
WHERE "studentIdentifier" LIKE '% — %';
