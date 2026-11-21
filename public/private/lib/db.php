<?php
// Połączenie z bazą (PDO, MySQL). Dane z private/config.php – poza repozytorium.

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
            sort INT NOT NULL DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_polish_ci",

        "CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            login VARCHAR(50) NOT NULL UNIQUE,
            password_hash VARCHAR(255) NOT NULL,
            role ENUM('admin','editor','user') NOT NULL DEFAULT 'user',
            failed_logins INT NOT NULL DEFAULT 0,
            locked_until DATETIME NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_login DATETIME NULL
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
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by INT NULL,
            INDEX idx_trail_pos (trail_id, position),
            FOREIGN KEY (trail_id) REFERENCES trails(id) ON DELETE CASCADE,
            FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
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
        $insTrail = $pdo->prepare('INSERT INTO trails (id, name, short, color, sort) VALUES (?, ?, ?, ?, ?)');
        $insPoint = $pdo->prepare(
            'INSERT INTO points (trail_id, position, region, label, type, height, difficulty)
             VALUES (?, ?, ?, ?, ?, ?, \'łatwy\')'
        );
        foreach ($trails as $i => $t) {
            $insTrail->execute([$t['id'], $t['name'], $t['short'], $t['color'], $i + 1]);
            $points = json_decode(file_get_contents($dataDir . '/' . $t['file']), true);
            usort($points, function ($a, $b) { return $a['id'] <=> $b['id']; });
            foreach ($points as $pos => $p) {
                $insPoint->execute([
                    $t['id'], $pos + 1, $p['name_mountain_part'], $p['label'], $p['typ_punktu'],
                    isset($p['height']) ? (int) $p['height'] : null,
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
