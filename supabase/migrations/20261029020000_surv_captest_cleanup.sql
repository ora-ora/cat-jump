-- 清理上线后服务器上限测试留下的行（固定测试 client_id，全部为 rejected，从未进榜）
delete from surv_runs where client_id = '00000000-0000-4000-8000-00000000ca7e';
