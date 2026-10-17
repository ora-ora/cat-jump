-- 启用 pg_cron 扩展，供 20261017010900_cron_jobs.sql 使用。
-- 若托管项目的迁移角色权限不足导致这条失败，见 PLAN.md 13.4 节的手动兜底方式
-- （控制台 Database -> Extensions 手动启用后，这条迁移因为 if not exists 不会再报错）。
create extension if not exists pg_cron;
