-- =========================================================
--  FLUX — роли пользователей
--
--  flux_roles      — сами роли (user / admin и любые новые)
--  flux_user_roles — кто какую роль имеет (связь с flux_users)
--
--  Портал читает роли отсюда и умеет их выдавать в админке.
-- =========================================================

CREATE TABLE IF NOT EXISTS `flux_roles` (
  `id`          INT NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(64) NOT NULL,
  `title`       VARCHAR(191) NULL DEFAULT NULL,
  `permissions` TEXT NULL,
  `is_admin`    TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`  DATETIME NULL DEFAULT NULL,
  `updated_at`  DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `flux_roles_name_unique` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `flux_user_roles` (
  `user_id`    INT NOT NULL,
  `role_id`    INT NOT NULL,
  `created_at` DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (`user_id`, `role_id`),
  KEY `flux_user_roles_role_id` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Базовые роли
INSERT INTO `flux_roles` (`name`, `title`, `permissions`, `is_admin`, `created_at`, `updated_at`)
VALUES
  ('user',  'Пользователь',  '[]', 0, NOW(), NOW()),
  ('admin', 'Администратор', '["admin_panel","users","content","balance"]', 1, NOW(), NOW())
ON DUPLICATE KEY UPDATE `title` = VALUES(`title`);
