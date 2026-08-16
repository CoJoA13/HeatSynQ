-- Phase 8B §5.1: the practice copy runs against its OWN database (never a per-request switch), so
-- the app-practice compose service is unambiguously practice by database identity (practiceMode()).
-- Provisioned here at first cluster init, the erp_test precedent. NOTE: db-init runs ONLY on a fresh
-- dbdata volume — a box that already ran the prod stack must create it by hand once:
--   docker compose exec db createdb -U erp erp_practice
CREATE DATABASE erp_practice OWNER erp;
