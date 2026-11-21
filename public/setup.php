<?php
// Instalacja „Szlaki”: tworzy tabele, przenosi szlaki z data/*.json do bazy
// (wszystkie punkty z trudnością „łatwy”) i zakłada pierwsze konto administratora.
// Działa tylko dopóki nie ma żadnego administratora – potem plik można usunąć.

require_once __DIR__ . '/private/lib/api.php';

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store');

$messages = [];
$error = null;
$done = false;

try {
    create_schema();
    migrate_schema();
    $import = import_json_data(__DIR__ . '/data');
    migrate_schema(); // po imporcie: uzupełnia informacje o szlakach z data/trails.json
    if (!$import['skipped']) {
        foreach ($import['counts'] as $trail => $n) {
            $messages[] = "Zaimportowano szlak " . strtoupper($trail) . ": {$n} punktów (trudność: łatwy).";
        }
    }

    if (admin_count() > 0) {
        $done = true;
    } elseif (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
        if (($_POST['password'] ?? '') !== ($_POST['password2'] ?? '')) {
            throw new ApiError(422, 'Hasła się różnią.');
        }
        create_user(['login' => $_POST['login'] ?? '', 'password' => $_POST['password'] ?? '', 'role' => 'admin']);
        $done = true;
        $messages[] = 'Konto administratora założone.';
    }
} catch (ApiError $e) {
    $error = $e->getMessage();
} catch (Throwable $e) {
    error_log('setup szlaki: ' . $e->getMessage());
    $error = 'Błąd serwera lub bazy – sprawdź private/config.php.';
}

$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');

function e(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
}
?>
<!doctype html>
<html lang="pl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Szlaki – instalacja</title>
  <style>
    body { margin: 0; background: #f4f1ea; color: #1d2a22; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    main { max-width: 420px; margin: 0 auto; padding: 24px 16px; }
    h1 { color: #1f5130; margin: 0 0 12px; }
    .ok { color: #2e7d4f; } .bad { color: #c0392b; font-weight: 600; } .warn { color: #b5651d; }
    label { display: grid; gap: 4px; margin: 12px 0; }
    input { font: inherit; padding: 10px 12px; border: 2px solid #ddd6c8; border-radius: 10px; }
    button { font: inherit; font-weight: 600; width: 100%; padding: 12px; border: 0; border-radius: 12px; background: #1f5130; color: #fff; margin-top: 8px; }
    a { color: #1f5130; }
  </style>
</head>
<body>
<main>
  <h1>⛰️ Szlaki – instalacja</h1>
  <?php foreach ($messages as $m): ?><p class="ok">✓ <?= e($m) ?></p><?php endforeach; ?>
  <?php if ($error): ?><p class="bad">✗ <?= e($error) ?></p><?php endif; ?>

  <?php if ($done): ?>
    <p class="ok">✓ Instalacja zakończona – administrator istnieje.</p>
    <p>Ten plik (<code>setup.php</code>) można już usunąć z serwera.</p>
    <p><a href="./">→ Przejdź do aplikacji</a></p>
  <?php elseif (!$error || ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST'): ?>
    <?php if (!$https): ?>
      <p class="warn">⚠️ Połączenie nie jest szyfrowane (HTTP). Hasło administratora najlepiej ustawić, gdy zadziała
        <a href="https://<?= e($_SERVER['HTTP_HOST'] ?? '') ?>/setup.php">HTTPS</a>.</p>
    <?php endif; ?>
    <p>Załóż pierwsze konto administratora:</p>
    <form method="post" autocomplete="off">
      <label>Login <input name="login" required minlength="3" maxlength="50" autocomplete="username"></label>
      <label>Hasło (min. 8 znaków) <input name="password" type="password" required minlength="8" autocomplete="new-password"></label>
      <label>Powtórz hasło <input name="password2" type="password" required minlength="8" autocomplete="new-password"></label>
      <button type="submit">Załóż administratora</button>
    </form>
  <?php endif; ?>
</main>
</body>
</html>
