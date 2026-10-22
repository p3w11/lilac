-- =========================================================
--  FLUX — таблица пользователей flux_users
--
--  Структура повторяет старую таблицу (flute_users на старом
--  сайте), чтобы перенести её без правок кода старого сайта.
--  Создай её в той же базе данных MySQL.
-- =========================================================

CREATE TABLE IF NOT EXISTS `flux_users` (
  `id`                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `created_at`            TIMESTAMP NULL DEFAULT NULL,
  `updated_at`            TIMESTAMP NULL DEFAULT NULL,
  `login`                 VARCHAR(191) NOT NULL,
  `uri`                   VARCHAR(191) NULL DEFAULT NULL,
  `name`                  VARCHAR(191) NULL DEFAULT NULL,
  `avatar`                VARCHAR(191) NULL DEFAULT NULL,
  `banner`                VARCHAR(191) NULL DEFAULT NULL,
  `email`                 VARCHAR(191) NULL DEFAULT NULL,
  `pending_email`         VARCHAR(191) NULL DEFAULT NULL,
  `password`              VARCHAR(255) NOT NULL,
  `verified`              TINYINT(1) NOT NULL DEFAULT 0,
  `approved`              TINYINT(1) NOT NULL DEFAULT 0,
  `hidden`                TINYINT(1) NOT NULL DEFAULT 0,
  `is_temporary`          TINYINT(1) NOT NULL DEFAULT 0,
  `balance`               DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `last_logged`           TIMESTAMP NULL DEFAULT NULL,
  `password_updated_at`   TIMESTAMP NULL DEFAULT NULL,
  `deleted_at`            TIMESTAMP NULL DEFAULT NULL,
  `two_factor_secret`     VARCHAR(255) NULL DEFAULT NULL,
  `two_factor_recovery_codes` TEXT NULL,
  `two_factor_confirmed_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `flux_users_login_unique` (`login`),
  UNIQUE KEY `flux_users_email_unique` (`email`),
  KEY `flux_users_login_index` (`login`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- =========================================================
--  Рекомендуемые дополнения.
--  С ними SteamID, игровой ник и права лежат в той же таблице.
--  Без них портал всё равно работает — эти поля будут храниться
--  в его собственной базе (зеркало), но в одной таблице удобнее.
-- =========================================================
ALTER TABLE `flux_users`
  ADD COLUMN `steam_id`    VARCHAR(32)  NULL DEFAULT NULL,
  ADD COLUMN `game_login`  VARCHAR(64)  NULL DEFAULT NULL,
  ADD COLUMN `game_admin`  TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN `is_admin`    TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN `notes`       VARCHAR(300) NULL DEFAULT NULL;
