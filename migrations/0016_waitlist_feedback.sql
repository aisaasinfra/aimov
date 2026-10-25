-- 公开等待列表：邮箱小写后唯一，重复提交走 ON CONFLICT DO NOTHING，不建账号。
-- source 只记报名入口（waitlist / footer / pricing），不记 IP。
CREATE TABLE waitlist (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  locale TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'waitlist',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_waitlist_created ON waitlist(created_at);

-- 产品反馈，与 contact_messages、takedown_requests 分开。登录用户提交，管理员改状态和一句话回复。
-- 用户只能删除自己 status=open 的条目；注销账号时整表删除。
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'planned', 'shipped', 'closed')),
  admin_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_feedback_user ON feedback(user_id, created_at);
CREATE INDEX idx_feedback_status ON feedback(status, created_at);
