-- Tabelle für die freiwilligen Spielerkonten (MySQL/MariaDB bei All-Inkl).
-- Einmal in phpMyAdmin in der Datenbank ausführen.
CREATE TABLE IF NOT EXISTS accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(20) NOT NULL,
  password VARCHAR(100) NOT NULL,
  auth_token CHAR(48) NULL,
  games_played INT UNSIGNED NOT NULL DEFAULT 0,
  wins INT UNSIGNED NOT NULL DEFAULT 0,
  losses INT UNSIGNED NOT NULL DEFAULT 0,
  xp INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_name (name),
  UNIQUE KEY uniq_auth_token (auth_token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
