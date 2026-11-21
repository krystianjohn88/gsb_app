<?php
// Logika API „Szlaki”. Wszystko przechodzi przez handle_request() – api/index.php tylko
// tłumaczy żądanie HTTP, dzięki czemu tę samą logikę da się przetestować bez HTTP.
//
// Role: admin – wszystko (także konta), editor – punkty, user – własne wyniki.

require_once __DIR__ . '/db.php';

const TYPES = ['góra', 'przełęcz', 'schronisko', 'miasto', 'polana', 'inne'];
const DIFFICULTIES = ['łatwy', 'średni', 'trudny'];
const ROLES = ['admin', 'editor', 'user'];
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

class ApiError extends Exception
{
    public $status;

    public function __construct(int $status, string $message)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function fail(int $status, string $message): void
{
    throw new ApiError($status, $message);
}

// --- sesje i uprawnienia ------------------------------------------------------------

function current_user(?string $token): ?array
{
    if (!$token) {
        return null;
    }
    $st = db()->prepare(
        'SELECT u.id, u.login, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > NOW()'
    );
    $st->execute([hash('sha256', $token)]);
    $u = $st->fetch();
    return $u ? ['id' => (int) $u['id'], 'login' => $u['login'], 'role' => $u['role']] : null;
}

function require_role(?array $user, array $roles): array
{
    if (!$user) {
        fail(401, 'Zaloguj się.');
    }
    if (!in_array($user['role'], $roles, true)) {
        fail(403, 'Brak uprawnień.');
    }
    return $user;
}

// --- walidacja ----------------------------------------------------------------------

function str_field(array $b, string $key, int $max, bool $required = true): ?string
{
    $v = isset($b[$key]) ? trim((string) $b[$key]) : '';
    if ($v === '') {
        if ($required) {
            fail(422, "Pole „{$key}” jest wymagane.");
        }
        return null;
    }
    if (mb_strlen($v) > $max) {
        fail(422, "Pole „{$key}” może mieć najwyżej {$max} znaków.");
    }
    return $v;
}

function enum_field(array $b, string $key, array $allowed): string
{
    $v = isset($b[$key]) ? (string) $b[$key] : '';
    if (!in_array($v, $allowed, true)) {
        fail(422, "Nieprawidłowa wartość pola „{$key}”.");
    }
    return $v;
}

function height_field(array $b): ?int
{
    if (!isset($b['height']) || $b['height'] === '' || $b['height'] === null) {
        return null;
    }
    $h = filter_var($b['height'], FILTER_VALIDATE_INT);
    if ($h === false || $h < 0 || $h > 3000) {
        fail(422, 'Wysokość musi być liczbą od 0 do 3000.');
    }
    return $h;
}

function int_field(array $b, string $key, int $min = 0, int $max = 100000, bool $required = true): ?int
{
    if (!isset($b[$key]) || $b[$key] === '' || $b[$key] === null) {
        if ($required) {
            fail(422, "Pole „{$key}” jest wymagane.");
        }
        return null;
    }
    $v = filter_var($b[$key], FILTER_VALIDATE_INT);
    if ($v === false || $v < $min || $v > $max) {
        fail(422, "Nieprawidłowa wartość pola „{$key}”.");
    }
    return $v;
}

function password_field(array $b, string $key = 'password'): string
{
    $p = isset($b[$key]) ? (string) $b[$key] : '';
    if (mb_strlen($p) < 8) {
        fail(422, 'Hasło musi mieć co najmniej 8 znaków.');
    }
    if (mb_strlen($p) > 200) {
        fail(422, 'Hasło jest za długie.');
    }
    return $p;
}

function login_field(array $b): string
{
    $l = str_field($b, 'login', 50);
    if (!preg_match('/^[\p{L}0-9._-]{3,50}$/u', $l)) {
        fail(422, 'Login: 3–50 znaków – litery, cyfry, kropka, myślnik, podkreślnik.');
    }
    return $l;
}

// --- punkty -------------------------------------------------------------------------

function point_out(array $p): array
{
    return [
        'id' => (int) $p['id'],
        'position' => (int) $p['position'],
        'name_mountain_part' => $p['region'],
        'label' => $p['label'],
        'typ_punktu' => $p['type'],
        'height' => $p['height'] === null ? null : (int) $p['height'],
        'difficulty' => $p['difficulty'],
        'map_url' => $p['map_url'] ?? null,
        'lat' => isset($p['lat']) ? (float) $p['lat'] : null,
        'lon' => isset($p['lon']) ? (float) $p['lon'] : null,
    ];
}

// Opcjonalne współrzędne punktu z pola „coords”. Przyjmuje m.in. format z mapy.com
// („49.7211110N, 18.8156131E”), zwykły „49.72111, 18.81561” i przecinki dziesiętne („49,72111 18,81561”).
// Zwraca [lat, lon] albo [null, null] dla pustego pola.
function coords_field(array $b): array
{
    $v = isset($b['coords']) ? trim((string) $b['coords']) : '';
    if ($v === '') {
        return [null, null];
    }
    if (!preg_match_all('/(-?\d{1,3}(?:[.,]\d+)?)\s*°?\s*([NSEWnsew])?/u', $v, $m, PREG_SET_ORDER) || count($m) < 2) {
        fail(422, 'Współrzędne: podaj szerokość i długość, np. 49.72111, 18.81561 (albo 49.72111N, 18.81561E).');
    }
    $lat = null;
    $lon = null;
    foreach (array_slice($m, 0, 2) as $i => $hit) {
        $num = (float) str_replace(',', '.', $hit[1]);
        $dir = strtoupper($hit[2] ?? '');
        if ($dir === 'S' || $dir === 'W') {
            $num = -abs($num);
        }
        if ($dir === 'E' || $dir === 'W' || ($dir === '' && $i === 1)) {
            $lon = $num;
        } else {
            $lat = $num;
        }
    }
    if ($lat === null || $lon === null || abs($lat) > 90 || abs($lon) > 180) {
        fail(422, 'Nieprawidłowe współrzędne – szerokość od -90 do 90, długość od -180 do 180.');
    }
    return [round($lat, 7), round($lon, 7)];
}

// Opcjonalny link do mapy: tylko https i tylko mapy.com / mapy.cz.
function map_url_field(array $b): ?string
{
    $v = isset($b['map_url']) ? trim((string) $b['map_url']) : '';
    // Wklejony cały kod osadzenia z mapy.com (<iframe … src="https://mapy.com/s/…">) – bierzemy sam adres.
    if (stripos($v, '<iframe') !== false) {
        if (!preg_match('/\ssrc\s*=\s*["\']([^"\']+)["\']/i', $v, $m)) {
            fail(422, 'Nie znaleziono adresu mapy w kodzie <iframe>.');
        }
        $v = trim(html_entity_decode($m[1], ENT_QUOTES, 'UTF-8'));
    }
    if ($v === '') {
        return null;
    }
    if (mb_strlen($v) > 500) {
        fail(422, 'Link do mapy jest za długi (max 500 znaków).');
    }
    $p = parse_url($v);
    $host = strtolower($p['host'] ?? '');
    if (($p['scheme'] ?? '') !== 'https' || !preg_match('/(^|\.)mapy\.(com|cz)$/', $host)) {
        fail(422, 'Link do mapy musi zaczynać się od https://mapy.com/ (albo mapy.cz).');
    }
    return $v;
}

function find_point(int $id): array
{
    $st = db()->prepare('SELECT * FROM points WHERE id = ?');
    $st->execute([$id]);
    $p = $st->fetch();
    if (!$p) {
        fail(404, 'Nie ma takiego punktu.');
    }
    return $p;
}

function point_fields(array $b): array
{
    return [
        'region' => str_field($b, 'region', 100),
        'label' => str_field($b, 'label', 200),
        'type' => enum_field($b, 'type', TYPES),
        'height' => height_field($b),
        'difficulty' => enum_field($b, 'difficulty', DIFFICULTIES),
        'map_url' => map_url_field($b),
        'coords' => coords_field($b),
    ];
}

// --- historia zmian punktów (audyt) ---------------------------------------------------
// Każda zmiana punktu trafia do point_history: kto, kiedy, co (stara → nowa wartość).

const HISTORY_FIELDS = ['label', 'region', 'type', 'height', 'difficulty', 'map_url', 'lat', 'lon'];

function point_snapshot(array $p): array
{
    return [
        'label' => $p['label'],
        'region' => $p['region'],
        'type' => $p['type'],
        'height' => $p['height'] === null ? null : (int) $p['height'],
        'difficulty' => $p['difficulty'],
        'map_url' => $p['map_url'] ?? null,
        'lat' => isset($p['lat']) ? (float) $p['lat'] : null,
        'lon' => isset($p['lon']) ? (float) $p['lon'] : null,
        'position' => (int) $p['position'],
    ];
}

function log_point(?int $userId, array $p, string $action, ?array $changes): void
{
    db()->prepare(
        'INSERT INTO point_history (point_id, trail_id, user_id, action, label, changes) VALUES (?, ?, ?, ?, ?, ?)'
    )->execute([
        (int) $p['id'], $p['trail_id'], $userId, $action, $p['label'],
        $changes === null ? null : json_encode($changes, JSON_UNESCAPED_UNICODE),
    ]);
}

function history_entries(PDOStatement $st): array
{
    return array_map(function ($h) {
        return [
            'id' => (int) $h['id'],
            'point_id' => $h['point_id'] === null ? null : (int) $h['point_id'],
            'trail' => $h['trail_id'],
            'action' => $h['action'],
            'label' => $h['label'],
            'login' => $h['login'],
            'changes' => $h['changes'] === null ? null : json_decode($h['changes'], true),
            'created_at' => $h['created_at'],
        ];
    }, $st->fetchAll());
}

// Historia jednego punktu + kto i kiedy go utworzył.
function point_history(array $q): array
{
    $id = int_field($q, 'id', 1, PHP_INT_MAX);
    $st = db()->prepare(
        'SELECT p.created_at, u.login AS created_by FROM points p LEFT JOIN users u ON u.id = p.created_by WHERE p.id = ?'
    );
    $st->execute([$id]);
    $p = $st->fetch() ?: ['created_at' => null, 'created_by' => null];
    $st = db()->prepare(
        'SELECT h.*, u.login FROM point_history h LEFT JOIN users u ON u.id = h.user_id
         WHERE h.point_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT 200'
    );
    $st->execute([$id]);
    return ['point_id' => $id, 'created_at' => $p['created_at'], 'created_by' => $p['created_by'], 'entries' => history_entries($st)];
}

// Ostatnie zmiany na szlaku (także usunięte punkty).
function trail_changes(array $q): array
{
    $trail = str_field($q, 'trail', 20);
    $st = db()->prepare(
        "SELECT h.*, u.login FROM point_history h LEFT JOIN users u ON u.id = h.user_id
         WHERE h.trail_id = ? AND h.action <> 'import' ORDER BY h.created_at DESC, h.id DESC LIMIT 150"
    );
    $st->execute([$trail]);
    return history_entries($st);
}

// --- punkty -------------------------------------------------------------------------

function create_point(array $user, array $b): array
{
    $pdo = db();
    $trail = str_field($b, 'trail', 20);
    $st = $pdo->prepare('SELECT 1 FROM trails WHERE id = ?');
    $st->execute([$trail]);
    if (!$st->fetchColumn()) {
        fail(404, 'Nie ma takiego szlaku.');
    }
    $f = point_fields($b);

    // Nowy punkt wstawiamy za wskazanym (after_id) albo na początek szlaku.
    $afterId = int_field($b, 'after_id', 1, PHP_INT_MAX, false);
    if ($afterId) {
        $after = find_point($afterId);
        if ($after['trail_id'] !== $trail) {
            fail(422, 'Punkt „po” należy do innego szlaku.');
        }
        $pos = (int) $after['position'] + 1;
    } else {
        $pos = 1;
    }
    $pdo->prepare('UPDATE points SET position = position + 1 WHERE trail_id = ? AND position >= ?')
        ->execute([$trail, $pos]);
    $pdo->prepare(
        'INSERT INTO points (trail_id, position, region, label, type, height, difficulty, map_url, lat, lon,
                             created_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)'
    )->execute([$trail, $pos, $f['region'], $f['label'], $f['type'], $f['height'], $f['difficulty'], $f['map_url'],
        $f['coords'][0], $f['coords'][1], $user['id'], $user['id']]);
    $new = find_point((int) $pdo->lastInsertId());
    log_point($user['id'], $new, 'create', point_snapshot($new));
    return point_out($new);
}

function update_point(array $user, array $b): array
{
    $id = int_field($b, 'id', 1, PHP_INT_MAX);
    $before = find_point($id);
    $f = point_fields($b);
    db()->prepare(
        'UPDATE points SET region = ?, label = ?, type = ?, height = ?, difficulty = ?, map_url = ?, lat = ?, lon = ?,
         updated_by = ? WHERE id = ?'
    )->execute([$f['region'], $f['label'], $f['type'], $f['height'], $f['difficulty'], $f['map_url'],
        $f['coords'][0], $f['coords'][1], $user['id'], $id]);
    $after = find_point($id);
    // Do historii tylko pola, które naprawdę się zmieniły.
    $old = point_snapshot($before);
    $new = point_snapshot($after);
    $diff = [];
    foreach (HISTORY_FIELDS as $k) {
        if ($old[$k] !== $new[$k]) {
            $diff[$k] = [$old[$k], $new[$k]];
        }
    }
    if ($diff) {
        log_point($user['id'], $after, 'update', $diff);
    }
    return point_out($after);
}

function delete_point(array $user, array $b): array
{
    $p = find_point(int_field($b, 'id', 1, PHP_INT_MAX));
    $pdo = db();
    log_point($user['id'], $p, 'delete', point_snapshot($p));
    $pdo->prepare('DELETE FROM points WHERE id = ?')->execute([$p['id']]);
    $pdo->prepare('UPDATE points SET position = position - 1 WHERE trail_id = ? AND position > ?')
        ->execute([$p['trail_id'], $p['position']]);
    return ['deleted' => (int) $p['id']];
}

// Przesunięcie o jedno miejsce w górę (dir = -1) albo w dół (dir = 1).
function move_point(array $user, array $b): array
{
    $p = find_point(int_field($b, 'id', 1, PHP_INT_MAX));
    $dir = (int) ($b['dir'] ?? 0);
    if ($dir !== -1 && $dir !== 1) {
        fail(422, 'Kierunek przesunięcia: -1 albo 1.');
    }
    $st = db()->prepare(
        $dir < 0
            ? 'SELECT * FROM points WHERE trail_id = ? AND position < ? ORDER BY position DESC LIMIT 1'
            : 'SELECT * FROM points WHERE trail_id = ? AND position > ? ORDER BY position ASC LIMIT 1'
    );
    $st->execute([$p['trail_id'], $p['position']]);
    $other = $st->fetch();
    if (!$other) {
        return point_out($p); // już na brzegu
    }
    $upd = db()->prepare('UPDATE points SET position = ?, updated_by = ? WHERE id = ?');
    $upd->execute([$other['position'], $user['id'], $p['id']]);
    $upd->execute([$p['position'], $user['id'], $other['id']]);
    log_point($user['id'], $p, 'move', ['position' => [(int) $p['position'], (int) $other['position']]]);
    return point_out(find_point((int) $p['id']));
}

// Które punkty „przeniesiono” przy nowej kolejności: wszystkie poza najdłuższym podciągiem,
// który zachował dotychczasową kolejność (przeciągnięcie jednego kafelka = jeden wpis w historii).
function moved_point_ids(array $newIds, array $oldPos): array
{
    $seq = array_map(function ($id) use ($oldPos) { return $oldPos[$id]; }, $newIds);
    $tails = [];
    $tailIdx = [];
    $prev = [];
    foreach ($seq as $i => $v) {
        $lo = 0;
        $hi = count($tails);
        while ($lo < $hi) {
            $mid = intdiv($lo + $hi, 2);
            if ($tails[$mid] < $v) {
                $lo = $mid + 1;
            } else {
                $hi = $mid;
            }
        }
        $tails[$lo] = $v;
        $tailIdx[$lo] = $i;
        $prev[$i] = $lo > 0 ? $tailIdx[$lo - 1] : -1;
    }
    $keep = [];
    for ($i = $tails ? $tailIdx[count($tails) - 1] : -1; $i >= 0; $i = $prev[$i]) {
        $keep[$newIds[$i]] = true;
    }
    return array_values(array_filter($newIds, function ($id) use ($keep) { return !isset($keep[$id]); }));
}

// Nowa kolejność całego szlaku (po przeciąganiu kafelków): ids = wszystkie punkty szlaku
// w kolejności od pierwszego. Musi to być dokładnie ten sam zestaw punktów co w bazie.
function reorder_points(array $user, array $b): array
{
    $pdo = db();
    $trail = str_field($b, 'trail', 20);
    $ids = $b['ids'] ?? null;
    if (!is_array($ids) || !$ids) {
        fail(422, 'Brak listy punktów.');
    }
    $ids = array_map('intval', $ids);
    $st = $pdo->prepare('SELECT * FROM points WHERE trail_id = ?');
    $st->execute([$trail]);
    $rows = [];
    foreach ($st->fetchAll() as $r) {
        $rows[(int) $r['id']] = $r;
    }
    $current = array_keys($rows);
    $sortedNew = $ids;
    sort($sortedNew);
    sort($current);
    if ($sortedNew !== $current) {
        fail(409, 'Lista punktów się zmieniła (ktoś inny edytował szlak?) – odśwież i spróbuj ponownie.');
    }
    $oldPos = array_map(function ($r) { return (int) $r['position']; }, $rows);
    $moved = moved_point_ids($ids, $oldPos);
    $newPos = array_flip($ids);
    $ownTx = !$pdo->inTransaction();
    if ($ownTx) {
        $pdo->beginTransaction();
    }
    try {
        $upd = $pdo->prepare('UPDATE points SET position = ?, updated_by = ? WHERE id = ? AND position <> ?');
        foreach ($ids as $i => $id) {
            $upd->execute([$i + 1, $user['id'], $id, $i + 1]);
        }
        foreach ($moved as $id) {
            log_point($user['id'], $rows[$id], 'move', ['position' => [$oldPos[$id], $newPos[$id] + 1]]);
        }
        if ($ownTx) {
            $pdo->commit();
        }
    } catch (Throwable $e) {
        if ($ownTx) {
            $pdo->rollBack();
        }
        throw $e;
    }
    return ['trail' => $trail, 'count' => count($ids), 'moved' => count($moved)];
}

// --- konta --------------------------------------------------------------------------

function user_out(array $u): array
{
    return [
        'id' => (int) $u['id'],
        'login' => $u['login'],
        'role' => $u['role'],
        'created_at' => $u['created_at'] ?? null,
        'last_login' => $u['last_login'] ?? null,
    ];
}

function login(array $b): array
{
    $pdo = db();
    $login = trim((string) ($b['login'] ?? ''));
    $password = (string) ($b['password'] ?? '');
    $st = $pdo->prepare('SELECT * FROM users WHERE login = ?');
    $st->execute([$login]);
    $u = $st->fetch();

    if ($u && $u['locked_until'] && strtotime($u['locked_until']) > time()) {
        fail(429, 'Za dużo nieudanych prób. Spróbuj za kilkanaście minut.');
    }
    if (!$u || !password_verify($password, $u['password_hash'])) {
        if ($u) {
            $failed = (int) $u['failed_logins'] + 1;
            $lock = $failed >= MAX_FAILED_LOGINS ? date('Y-m-d H:i:s', time() + LOCK_MINUTES * 60) : null;
            $pdo->prepare('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?')
                ->execute([$lock ? 0 : $failed, $lock, $u['id']]);
        }
        usleep(400000); // spowalnia zgadywanie haseł
        fail(401, 'Nieprawidłowy login lub hasło.');
    }

    $token = bin2hex(random_bytes(32));
    $pdo->prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        ->execute([hash('sha256', $token), $u['id'], date('Y-m-d H:i:s', time() + SESSION_DAYS * 86400)]);
    $pdo->prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login = NOW() WHERE id = ?')
        ->execute([$u['id']]);
    $pdo->exec('DELETE FROM sessions WHERE expires_at < NOW()');
    if (password_needs_rehash($u['password_hash'], PASSWORD_DEFAULT)) {
        $pdo->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
            ->execute([password_hash($password, PASSWORD_DEFAULT), $u['id']]);
    }
    return ['token' => $token, 'user' => user_out($u)];
}

function create_user(array $b): array
{
    $login = login_field($b);
    $hash = password_hash(password_field($b), PASSWORD_DEFAULT);
    $role = enum_field($b, 'role', ROLES);
    $st = db()->prepare('SELECT 1 FROM users WHERE login = ?');
    $st->execute([$login]);
    if ($st->fetchColumn()) {
        fail(409, 'Taki login już istnieje.');
    }
    db()->prepare('INSERT INTO users (login, password_hash, role) VALUES (?, ?, ?)')->execute([$login, $hash, $role]);
    return user_out(find_user((int) db()->lastInsertId()));
}

function find_user(int $id): array
{
    $st = db()->prepare('SELECT * FROM users WHERE id = ?');
    $st->execute([$id]);
    $u = $st->fetch();
    if (!$u) {
        fail(404, 'Nie ma takiego konta.');
    }
    return $u;
}

function admin_count(): int
{
    return (int) db()->query("SELECT COUNT(*) FROM users WHERE role = 'admin'")->fetchColumn();
}

function update_user(array $me, array $b): array
{
    $u = find_user(int_field($b, 'id', 1, PHP_INT_MAX));
    if (isset($b['role'])) {
        $role = enum_field($b, 'role', ROLES);
        if ($u['role'] === 'admin' && $role !== 'admin' && admin_count() <= 1) {
            fail(422, 'To jedyny administrator – nie można zmienić mu roli.');
        }
        db()->prepare('UPDATE users SET role = ? WHERE id = ?')->execute([$role, $u['id']]);
    }
    if (isset($b['password']) && $b['password'] !== '') {
        db()->prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL WHERE id = ?')
            ->execute([password_hash(password_field($b), PASSWORD_DEFAULT), $u['id']]);
        // Nowe hasło wylogowuje wszystkie inne sesje tego konta.
        db()->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$u['id']]);
    }
    return user_out(find_user((int) $u['id']));
}

function delete_user(array $me, array $b): array
{
    $u = find_user(int_field($b, 'id', 1, PHP_INT_MAX));
    if ((int) $u['id'] === $me['id']) {
        fail(422, 'Nie możesz usunąć własnego konta.');
    }
    if ($u['role'] === 'admin' && admin_count() <= 1) {
        fail(422, 'Nie można usunąć jedynego administratora.');
    }
    db()->prepare('DELETE FROM users WHERE id = ?')->execute([$u['id']]);
    return ['deleted' => (int) $u['id']];
}

// Zmiana własnego hasła (każda rola).
function change_own_password(array $me, array $b): array
{
    $u = find_user($me['id']);
    if (!password_verify((string) ($b['current'] ?? ''), $u['password_hash'])) {
        fail(422, 'Obecne hasło jest nieprawidłowe.');
    }
    db()->prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        ->execute([password_hash(password_field($b), PASSWORD_DEFAULT), $me['id']]);
    return ['changed' => true];
}

// --- wyniki -------------------------------------------------------------------------

function save_result(array $me, array $b): array
{
    $trail = str_field($b, 'trail', 20);
    $st = db()->prepare('SELECT 1 FROM trails WHERE id = ?');
    $st->execute([$trail]);
    if (!$st->fetchColumn()) {
        fail(404, 'Nie ma takiego szlaku.');
    }
    $row = [
        $me['id'],
        $trail,
        str_field($b, 'region', 100, false),
        enum_field($b, 'mode', ['type', 'order', 'between']),
        isset($b['level']) && $b['level'] !== null ? enum_field($b, 'level', DIFFICULTIES) : null,
        empty($b['reversed']) ? 0 : 1,
        int_field($b, 'total', 1, 10000),
        int_field($b, 'correct', 0, 10000, false) ?? 0,
        int_field($b, 'close', 0, 10000, false) ?? 0,
        int_field($b, 'revealed', 0, 10000, false) ?? 0,
        int_field($b, 'mistakes', 0, 100000, false) ?? 0,
        int_field($b, 'duration_s', 0, 86400, false),
    ];
    db()->prepare(
        'INSERT INTO results (user_id, trail_id, region, mode, level, reversed, total, correct, close_answers, revealed, mistakes, duration_s)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )->execute($row);
    return ['id' => (int) db()->lastInsertId()];
}

// Historia wyników: własna, a administrator może podać ?user=<id>, żeby zobaczyć cudzą.
function list_results(array $me, array $query = []): array
{
    $userId = $me['id'];
    if (isset($query['user']) && $query['user'] !== '' && (int) $query['user'] !== $me['id']) {
        if ($me['role'] !== 'admin') {
            fail(403, 'Tylko administrator może oglądać wyniki innych osób.');
        }
        $userId = (int) find_user(int_field($query, 'user', 1, PHP_INT_MAX))['id'];
    }
    $st = db()->prepare(
        'SELECT r.*, t.short FROM results r JOIN trails t ON t.id = r.trail_id
         WHERE r.user_id = ? ORDER BY r.created_at DESC, r.id DESC LIMIT 200'
    );
    $st->execute([$userId]);
    return array_map(function ($r) {
        return [
            'id' => (int) $r['id'],
            'trail' => $r['trail_id'],
            'short' => $r['short'],
            'region' => $r['region'],
            'mode' => $r['mode'],
            'level' => $r['level'] ?? null,
            'reversed' => (bool) $r['reversed'],
            'total' => (int) $r['total'],
            'correct' => (int) $r['correct'],
            'close' => (int) $r['close_answers'],
            'revealed' => (int) $r['revealed'],
            'mistakes' => (int) $r['mistakes'],
            'duration_s' => $r['duration_s'] === null ? null : (int) $r['duration_s'],
            'created_at' => $r['created_at'],
        ];
    }, $st->fetchAll());
}

// --- router -------------------------------------------------------------------------

/**
 * @return array{0:int,1:mixed} [status HTTP, dane]
 */
function handle_request(string $method, string $route, array $query, array $body, ?string $token): array
{
    try {
        $me = current_user($token);
        $pdo = db();

        switch ("{$method} {$route}") {
            case 'GET trails':
                $rows = $pdo->query('SELECT id, name, short, color, map_url FROM trails ORDER BY sort, id')->fetchAll();
                return [200, $rows];

            case 'GET points':
                $st = $pdo->prepare('SELECT * FROM points WHERE trail_id = ? ORDER BY position, id');
                $st->execute([(string) ($query['trail'] ?? '')]);
                return [200, array_map('point_out', $st->fetchAll())];

            case 'POST login':
                return [200, login($body)];

            case 'POST logout':
                if ($token) {
                    $pdo->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
                }
                return [200, ['ok' => true]];

            case 'GET me':
                return [200, $me];

            case 'POST password':
                return [200, change_own_password(require_role($me, ROLES), $body)];

            case 'POST points':
                return [201, create_point(require_role($me, ['admin', 'editor']), $body)];
            case 'PUT points':
                return [200, update_point(require_role($me, ['admin', 'editor']), $body)];
            case 'DELETE points':
                require_role($me, ['admin', 'editor']);
                return [200, delete_point($me, $body)];
            case 'GET point_history':
                require_role($me, ['admin', 'editor']);
                return [200, point_history($query)];
            case 'GET changes':
                require_role($me, ['admin', 'editor']);
                return [200, trail_changes($query)];
            case 'POST points_move':
                return [200, move_point(require_role($me, ['admin', 'editor']), $body)];
            case 'POST points_reorder':
                return [200, reorder_points(require_role($me, ['admin', 'editor']), $body)];

            case 'GET users':
                require_role($me, ['admin']);
                $rows = $pdo->query('SELECT * FROM users ORDER BY role, login')->fetchAll();
                return [200, array_map('user_out', $rows)];
            case 'POST users':
                require_role($me, ['admin']);
                return [201, create_user($body)];
            case 'PUT users':
                return [200, update_user(require_role($me, ['admin']), $body)];
            case 'DELETE users':
                return [200, delete_user(require_role($me, ['admin']), $body)];

            case 'POST results':
                return [201, save_result(require_role($me, ROLES), $body)];
            case 'GET results':
                return [200, list_results(require_role($me, ROLES), $query)];
        }
        return [404, ['error' => 'Nieznany adres API.']];
    } catch (ApiError $e) {
        return [$e->status, ['error' => $e->getMessage()]];
    }
}
