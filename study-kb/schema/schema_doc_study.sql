-- Chinese labels for study-kb tables and views in 3dworkbench.

INSERT OR IGNORE INTO schema_doc (kind, name, name_zh, description_zh, sort_order) VALUES
  ('view', 'v_study_due_cards', '今日到期', '当前已到复习时间的卡片，含正反面与章节信息。', 1),
  ('view', 'v_study_node_cards', '章节卡片', '按章节浏览所有活跃卡片。', 2),
  ('view', 'v_study_scope_tree', '学习树', '按 scope 展开的章节树，含卡片数与到期数。', 3),
  ('view', 'v_study_review_stats', '复习统计', '每个学习 scope 的活跃卡数、到期数与 FSRS 均值。', 4),
  ('table', 'study_node', '章节节点', '书 / 章 / 节 / 主题树节点。', 10),
  ('table', 'study_scope', '学习视角', '可切换的学习根节点（任意章节都可作 anchor）。', 11),
  ('table', 'study_card', '知识卡片', '单条可背诵知识点（front/back）。', 12),
  ('table', 'study_card_fsrs', 'FSRS 调度', '每张卡的下次复习时间与稳定性参数。', 13),
  ('table', 'study_review_log', '复习日志', '每次打分的 before/after 状态。', 14);

INSERT OR IGNORE INTO studio_view_meta (name, name_zh, sql, edit_contract_json) VALUES
  ('v_study_due_cards', '今日到期', '', '{}'),
  ('v_study_node_cards', '章节卡片', '', '{}'),
  ('v_study_scope_tree', '学习树', '', '{}'),
  ('v_study_review_stats', '复习统计', '', '{}');
