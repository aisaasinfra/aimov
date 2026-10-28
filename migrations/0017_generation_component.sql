-- 生成单记下创建时的组件身份。旧行留空。不回填，也不按皮肤名改写。
ALTER TABLE generations ADD COLUMN component_id TEXT;
ALTER TABLE generations ADD COLUMN component_version INTEGER;
