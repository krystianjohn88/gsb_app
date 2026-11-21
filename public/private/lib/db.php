<?php
// Połączenie z bazą (PDO, MySQL). Dane z private/config.php – poza repozytorium.

// Pola informacji o szlaku (kolumny tabeli trails, te same klucze w data/trails.json).
const TRAIL_INFO_FIELDS = ['map_url', 'full_name', 'tagline', 'founded', 'designer', 'length', 'description'];

// Ustawienia w tabeli settings: nazwa => [wartość domyślna, opis]. Zmienia się je tylko w bazie.
const DEFAULT_SETTINGS = [
    'max_users' => ['100', 'Maksymalna liczba kont (wszystkie role). Po osiągnięciu limitu rejestracja jest zablokowana.'],
    'registration_open' => ['1', 'Czy użytkownicy mogą sami zakładać konta: 1 = tak, 0 = nie.'],
];

function setting(string $name): string
{
    $st = db()->prepare('SELECT value FROM settings WHERE name = ?');
    $st->execute([$name]);
    $v = $st->fetchColumn();
    return $v === false ? DEFAULT_SETTINGS[$name][0] : (string) $v;
}

function config(): array
{
    static $cfg = null;
    if ($cfg === null) {
        $file = __DIR__ . '/../config.php';
        if (!is_file($file)) {
            throw new RuntimeException('Brak private/config.php – skopiuj config.example.php i uzupełnij.');
        }
        $cfg = require $file;
    }
    return $cfg;
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo === null) {
        $c = config()['db'];
        $pdo = new PDO(
            "mysql:host={$c['host']};port={$c['port']};dbname={$c['name']};charset=utf8mb4",
            $c['user'],
            $c['pass'],
            [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]
        );
    }
    return $pdo;
}

// Struktura bazy. CREATE ... IF NOT EXISTS – można uruchamiać wielokrotnie.
function create_schema(): void
{
    $sql = [
        "CREATE TABLE IF NOT EXISTS trails (
            id VARCHAR(20) PRIMARY KEY,
            name VARCHAR(200) NOT NULL,
            short VARCHAR(10) NOT NULL,
            color VARCHAR(20) NOT NULL DEFAULT '#c0392b',
            map_url VARCHAR(500) NULL,
            full_name VARCHAR(200) NULL,
            tagline VARCHAR(200) NULL,
            founded VARCHAR(500) NULL,
            designer VARCHAR(500) NULL,
            length VARCHAR(300) NULL,
            description TEXT NULL,
            sort INT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        "CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            login VARCHAR(50) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('admin','editor','user') NOT NULL DEFAULT 'user',
            email VARCHAR(190) NULL UNIQUE,
            email_verified TINYINT(1) NOT NULL DEFAULT 1,
            verify_token_hash CHAR(64) NULL,
            verify_expires DATETIME NULL,
            verify_sent_at DATETIME NULL,
            failed_logins INT NOT NULL DEFAULT 0,
            locked_until DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        // Ustawienia zmieniane tylko w bazie (np. w phpMyAdmin): limit kont, czy rejestracja jest otwarta.
        "CREATE TABLE IF NOT EXISTS settings (
            name VARCHAR(50) PRIMARY KEY,
            value VARCHAR(200) NOT NULL,
            description VARCHAR(300) NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        // Proste ograniczanie liczby prób (rejestracja, ponowne wysłanie linku) – wpis na każdą próbę.
        "CREATE TABLE IF NOT EXISTS rate_limits (
            id INT AUTO_INCREMENT PRIMARY KEY,
            bucket VARCHAR(120) NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_bucket (bucket, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        // Licznik wejść. Bez adresów IP: przeglądarka ma losowy identyfikator, w bazie tylko jego skrót.
        "CREATE TABLE IF NOT EXISTS visit_stats (
            day DATE PRIMARY KEY,
            visits INT NOT NULL DEFAULT 0,
            unique_visitors INT NOT NULL DEFAULT 0,
            new_visitors INT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",
        "CREATE TABLE IF NOT EXISTS visitors (
            visitor_hash CHAR(64) PRIMARY KEY,
            first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",
        "CREATE TABLE IF NOT EXISTS visit_days (
            day DATE NOT NULL,
            visitor_hash CHAR(64) NOT NULL,
            PRIMARY KEY (day, visitor_hash)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        "CREATE TABLE IF NOT EXISTS points (
            id INT AUTO_INCREMENT PRIMARY KEY,
            trail_id VARCHAR(20) NOT NULL,
            position INT NOT NULL,
            region VARCHAR(100) NOT NULL,
            label VARCHAR(200) NOT NULL,
            type ENUM('góra','przełęcz','schronisko','miasto','polana','inne') NOT NULL,
            height SMALLINT NULL,
            difficulty ENUM('łatwy','średni','trudny') NOT NULL DEFAULT 'łatwy',
            on_trail TINYINT(1) NOT NULL DEFAULT 1,
            trails_info VARCHAR(500) NULL,
            notes TEXT NULL,
            map_url VARCHAR(500) NULL,
            lat DECIMAL(10,7) NULL,
            lon DECIMAL(10,7) NULL,
            created_at DATETIME NULL,
            created_by INT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by INT NULL,
            INDEX idx_trail_pos (trail_id, position),
            FOREIGN KEY (trail_id) REFERENCES trails(id) ON DELETE CASCADE,
            FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
            FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        // Historia zmian punktów (audyt). Bez klucza obcego do points – wpisy zostają po usunięciu punktu.
        "CREATE TABLE IF NOT EXISTS point_history (
            id INT AUTO_INCREMENT PRIMARY KEY,
            point_id INT NULL,
            trail_id VARCHAR(20) NOT NULL,
            user_id INT NULL,
            action ENUM('import','create','update','move','delete') NOT NULL,
            label VARCHAR(200) NOT NULL,
            changes JSON NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_point (point_id, created_at),
            INDEX idx_trail (trail_id, created_at),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        "CREATE TABLE IF NOT EXISTS sessions (
            token_hash CHAR(64) PRIMARY KEY,
            user_id INT NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            INDEX idx_user (user_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        "CREATE TABLE IF NOT EXISTS results (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            trail_id VARCHAR(20) NOT NULL,
            region VARCHAR(100) NULL,
            mode ENUM('type','order','between') NOT NULL,
            level ENUM('łatwy','średni','trudny') NULL,
            reversed TINYINT(1) NOT NULL DEFAULT 0,
            total INT NOT NULL,
            correct INT NOT NULL DEFAULT 0,
            close_answers INT NOT NULL DEFAULT 0,
            revealed INT NOT NULL DEFAULT 0,
            mistakes INT NOT NULL DEFAULT 0,
            duration_s INT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user_date (user_id, created_at),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (trail_id) REFERENCES trails(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",
    ];
    foreach ($sql as $q) {
        db()->exec($q);
    }
}

// Zmiany struktury dla istniejącej bazy (bezpieczne do wielokrotnego uruchomienia).
function migrate_schema(): array
{
    $pdo = db();
    $done = [];
    $col = function (string $table, string $column) use ($pdo) {
        $st = $pdo->prepare(
            'SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $st->execute([$table, $column]);
        return $st->fetchColumn();
    };
    // 2026-11-21: tryb „pomiędzy” i poziom trudności w wynikach
    if (strpos((string) $col('results', 'mode'), "'between'") === false) {
        $pdo->exec("ALTER TABLE results MODIFY mode ENUM('type','order','between') NOT NULL");
        $done[] = 'results.mode + between';
    }
    if ($col('results', 'level') === false) {
        $pdo->exec("ALTER TABLE results ADD COLUMN level ENUM('łatwy','średni','trudny') NULL AFTER mode");
        $done[] = 'results.level';
    }
    // 2026-11-21: link do mapy szlaku (mapy.com); wartości z data/trails.json dla szlaków, które go nie mają
    if ($col('trails', 'map_url') === false) {
        $pdo->exec('ALTER TABLE trails ADD COLUMN map_url VARCHAR(500) NULL AFTER color');
        $done[] = 'trails.map_url';
    }
    // 2026-11-21: link do mapy przy punkcie (opcjonalny)
    if ($col('points', 'map_url') === false) {
        $pdo->exec('ALTER TABLE points ADD COLUMN map_url VARCHAR(500) NULL AFTER difficulty');
        $done[] = 'points.map_url';
    }
    // 2026-11-21: dokładne współrzędne punktu (link mapy.com ma tylko środek widoku)
    if ($col('points', 'lat') === false) {
        $pdo->exec('ALTER TABLE points ADD COLUMN lat DECIMAL(10,7) NULL AFTER map_url, ADD COLUMN lon DECIMAL(10,7) NULL AFTER lat');
        $done[] = 'points.lat/lon';
    }
    // 2026-11-21: punkt na szlaku / obok, szlaki przez punkt, ciekawostki
    if ($col('points', 'on_trail') === false) {
        $pdo->exec('ALTER TABLE points ADD COLUMN on_trail TINYINT(1) NOT NULL DEFAULT 1 AFTER difficulty,
            ADD COLUMN trails_info VARCHAR(500) NULL AFTER on_trail, ADD COLUMN notes TEXT NULL AFTER trails_info');
        $done[] = 'points.on_trail/trails_info/notes';
    }
    // 2026-11-21: autor punktu (created_by / created_at); tabela point_history powstaje w create_schema()
    if ($col('points', 'created_by') === false) {
        $pdo->exec('ALTER TABLE points ADD COLUMN created_at DATETIME NULL AFTER lon, ADD COLUMN created_by INT NULL AFTER created_at,
            ADD CONSTRAINT fk_points_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL');
        $done[] = 'points.created_at/created_by';
    }
    // 2026-11-21: rejestracja z weryfikacją e-mail (istniejące konta – zweryfikowane)
    if ($col('users', 'email') === false) {
        $pdo->exec('ALTER TABLE users ADD COLUMN email VARCHAR(190) NULL UNIQUE AFTER role,
            ADD COLUMN email_verified TINYINT(1) NOT NULL DEFAULT 1 AFTER email,
            ADD COLUMN verify_token_hash CHAR(64) NULL AFTER email_verified,
            ADD COLUMN verify_expires DATETIME NULL AFTER verify_token_hash,
            ADD COLUMN verify_sent_at DATETIME NULL AFTER verify_expires');
        $done[] = 'users.email/verification';
    }
    // Domyślne ustawienia (tylko gdy ich jeszcze nie ma – nie nadpisuje zmian w bazie).
    $ins = $pdo->prepare('INSERT IGNORE INTO settings (name, value, description) VALUES (?, ?, ?)');
    foreach (DEFAULT_SETTINGS as $name => [$value, $description]) {
        $ins->execute([$name, $value, $description]);
        if ($ins->rowCount()) {
            $done[] = "settings.{$name}";
        }
    }
    // 2026-11-21: informacje o szlaku (pełna nazwa, rok, projektant, długość, opis)
    if ($col('trails', 'description') === false) {
        $pdo->exec('ALTER TABLE trails ADD COLUMN full_name VARCHAR(200) NULL AFTER map_url,
            ADD COLUMN tagline VARCHAR(200) NULL AFTER full_name, ADD COLUMN founded VARCHAR(500) NULL AFTER tagline,
            ADD COLUMN designer VARCHAR(500) NULL AFTER founded, ADD COLUMN length VARCHAR(300) NULL AFTER designer,
            ADD COLUMN description TEXT NULL AFTER length');
        $done[] = 'trails.info';
    }
    // Wartości z data/trails.json tylko tam, gdzie w bazie jeszcze ich nie ma (nie nadpisuje zmian w bazie).
    $file = __DIR__ . '/../../data/trails.json';
    if (is_file($file)) {
        foreach (json_decode(file_get_contents($file), true) as $t) {
            foreach (TRAIL_INFO_FIELDS as $field) {
                if (empty($t[$field])) {
                    continue;
                }
                $upd = $pdo->prepare("UPDATE trails SET {$field} = ? WHERE id = ? AND {$field} IS NULL");
                $upd->execute([$t[$field], $t['id']]);
                if ($upd->rowCount()) {
                    $done[] = "{$field} {$t['id']}";
                }
            }
        }
    }
    return $done;
}

// Import szlaków z plików data/*.json (tylko gdy tabela szlaków jest pusta).
// Wszystkie punkty dostają poziom trudności „łatwy”.
function import_json_data(string $dataDir): array
{
    $pdo = db();
    if ((int) $pdo->query('SELECT COUNT(*) FROM trails')->fetchColumn() > 0) {
        return ['skipped' => true];
    }
    $trails = json_decode(file_get_contents($dataDir . '/trails.json'), true);
    $counts = [];
    $pdo->beginTransaction();
    try {
        $insTrail = $pdo->prepare('INSERT INTO trails (id, name, short, color, map_url, sort) VALUES (?, ?, ?, ?, ?, ?)');
        $insPoint = $pdo->prepare(
            'INSERT INTO points (trail_id, position, region, label, type, height, difficulty, map_url, lat, lon)
             VALUES (?, ?, ?, ?, ?, ?, \'łatwy\', ?, ?, ?)'
        );
        foreach ($trails as $i => $t) {
            $insTrail->execute([$t['id'], $t['name'], $t['short'], $t['color'], $t['map_url'] ?? null, $i + 1]);
            $points = json_decode(file_get_contents($dataDir . '/' . $t['file']), true);
            usort($points, function ($a, $b) { return $a['id'] <=> $b['id']; });
            foreach ($points as $pos => $p) {
                $insPoint->execute([
                    $t['id'], $pos + 1, $p['name_mountain_part'], $p['label'], $p['typ_punktu'],
                    isset($p['height']) ? (int) $p['height'] : null,
                    $p['map_url'] ?? null,
                    isset($p['lat']) ? (float) $p['lat'] : null,
                    isset($p['lon']) ? (float) $p['lon'] : null,
                ]);
            }
            $counts[$t['id']] = count($points);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    return ['skipped' => false, 'counts' => $counts];
}
