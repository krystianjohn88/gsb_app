<?php
// Punkt wejścia API: /api/?r=<trasa>. Token logowania w nagłówku X-Auth-Token
// (nie Authorization – na części hostingów PHP go nie widzi).

require_once __DIR__ . '/../private/lib/api.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$route = preg_replace('/[^a-z_]/', '', (string) ($_GET['r'] ?? ''));

$body = [];
if ($method !== 'GET') {
    $raw = file_get_contents('php://input');
    $body = $raw === '' ? [] : json_decode($raw, true);
    if (!is_array($body)) {
        http_response_code(400);
        echo json_encode(['error' => 'Nieprawidłowy JSON.']);
        exit;
    }
}

$token = $_SERVER['HTTP_X_AUTH_TOKEN'] ?? null;

try {
    [$status, $data] = handle_request($method, $route, $_GET, $body, $token);
} catch (Throwable $e) {
    error_log('API szlaki: ' . $e->getMessage());
    $status = 500;
    $data = ['error' => 'Błąd serwera.'];
}

http_response_code($status);
echo json_encode($data, JSON_UNESCAPED_UNICODE);
