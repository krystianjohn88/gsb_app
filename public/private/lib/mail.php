<?php
// Wysyłka e-maili (weryfikacja konta). Bez zewnętrznych bibliotek.
//
// Konfiguracja w private/config.php (klucz 'mail'), np.:
//   'mail' => [
//       'from' => 'serwis@szlaki.kj88.pl',
//       'from_name' => 'Szlaki długodystansowe Beskidów',
//       'base_url' => 'https://szlaki.kj88.pl',
//       'smtp' => ['host' => 'serwer2630505.hosting-home.pl', 'port' => 465, 'secure' => 'ssl',
//                  'user' => 'serwis@szlaki.kj88.pl', 'pass' => 'HASŁO_SKRZYNKI'],
//   ],
// Bez 'smtp' (albo bez hasła) wiadomość idzie funkcją mail() serwera.

const MAIL_DEFAULTS = [
    'from' => 'serwis@szlaki.kj88.pl',
    'from_name' => 'Szlaki długodystansowe Beskidów',
    'base_url' => 'https://szlaki.kj88.pl',
];

function mail_config(): array
{
    $cfg = config()['mail'] ?? [];
    return array_merge(MAIL_DEFAULTS, is_array($cfg) ? $cfg : []);
}

function mail_uses_smtp(): bool
{
    $smtp = mail_config()['smtp'] ?? null;
    return is_array($smtp) && !empty($smtp['host']) && !empty($smtp['pass'])
        && strpos((string) $smtp['pass'], 'WPISZ') === false;
}

function mime_header(string $text): string
{
    return '=?UTF-8?B?' . base64_encode($text) . '?=';
}

/**
 * Wysyła wiadomość tekstową. Zwraca true, gdy serwer przyjął ją do wysłania.
 * Błędy trafiają do error_log (bez haseł).
 */
function send_mail(string $to, string $subject, string $text): bool
{
    // Tryb testowy: skrypty testowe ustawiają $GLOBALS['MAIL_SINK'] = [] – wiadomości trafiają tam, nic nie jest wysyłane.
    if (isset($GLOBALS['MAIL_SINK']) && is_array($GLOBALS['MAIL_SINK'])) {
        $GLOBALS['MAIL_SINK'][] = ['to' => $to, 'subject' => $subject, 'text' => $text];
        return true;
    }
    $c = mail_config();
    $from = $c['from'];
    $headers = [
        'From' => mime_header($c['from_name']) . " <{$from}>",
        'Reply-To' => $from,
        'MIME-Version' => '1.0',
        'Content-Type' => 'text/plain; charset=UTF-8',
        'Content-Transfer-Encoding' => 'base64',
        'X-Mailer' => 'szlaki.kj88.pl',
    ];
    $body = chunk_split(base64_encode(str_replace("\n", "\r\n", str_replace("\r\n", "\n", $text))));

    if (mail_uses_smtp()) {
        try {
            smtp_send($c['smtp'], $from, $to, mime_header($subject), $headers, $body);
            return true;
        } catch (Throwable $e) {
            error_log('szlaki SMTP: ' . $e->getMessage());
            return false;
        }
    }
    $lines = [];
    foreach ($headers as $k => $v) {
        $lines[] = "{$k}: {$v}";
    }
    $ok = mail($to, mime_header($subject), $body, implode("\r\n", $lines), '-f' . $from);
    if (!$ok) {
        error_log('szlaki mail(): serwer nie przyjął wiadomości do ' . $to);
    }
    return $ok;
}

// Minimalny klient SMTP: SSL (465) albo STARTTLS (587), AUTH LOGIN.
function smtp_send(array $s, string $from, string $to, string $encodedSubject, array $headers, string $body): void
{
    $host = $s['host'];
    $port = (int) ($s['port'] ?? 465);
    $secure = $s['secure'] ?? ($port === 465 ? 'ssl' : 'tls');
    $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $fp = stream_socket_client(($secure === 'ssl' ? 'ssl://' : 'tcp://') . "{$host}:{$port}", $errno, $errstr, 15,
        STREAM_CLIENT_CONNECT, $ctx);
    if (!$fp) {
        throw new RuntimeException("połączenie z {$host}:{$port}: {$errstr}");
    }
    stream_set_timeout($fp, 15);
    $read = function () use ($fp): string {
        $out = '';
        while (($line = fgets($fp, 1024)) !== false) {
            $out .= $line;
            if (strlen($line) < 4 || $line[3] === ' ') {
                break;
            }
        }
        return $out;
    };
    $cmd = function (?string $line, array $okCodes) use ($fp, $read): string {
        if ($line !== null) {
            fwrite($fp, $line . "\r\n");
        }
        $resp = $read();
        if (!in_array((int) substr($resp, 0, 3), $okCodes, true)) {
            // Nie logujemy treści AUTH – odpowiedź serwera wystarczy do diagnozy.
            throw new RuntimeException('SMTP: ' . trim($resp));
        }
        return $resp;
    };
    try {
        $cmd(null, [220]);
        $helo = 'szlaki.kj88.pl';
        $cmd("EHLO {$helo}", [250]);
        if ($secure === 'tls') {
            $cmd('STARTTLS', [220]);
            if (!stream_socket_enable_crypto($fp, true, STREAM_CRYPTO_METHOD_TLS_CLIENT)) {
                throw new RuntimeException('SMTP: nie udało się włączyć TLS');
            }
            $cmd("EHLO {$helo}", [250]);
        }
        $cmd('AUTH LOGIN', [334]);
        $cmd(base64_encode($s['user'] ?? $from), [334]);
        $cmd(base64_encode($s['pass']), [235]);
        $cmd("MAIL FROM:<{$from}>", [250]);
        $cmd("RCPT TO:<{$to}>", [250, 251]);
        $cmd('DATA', [354]);
        $msg = 'Date: ' . date('r') . "\r\n"
            . 'Message-ID: <' . bin2hex(random_bytes(12)) . '@szlaki.kj88.pl>' . "\r\n"
            . "To: <{$to}>\r\n"
            . "Subject: {$encodedSubject}\r\n";
        foreach ($headers as $k => $v) {
            $msg .= "{$k}: {$v}\r\n";
        }
        $msg .= "\r\n" . $body;
        // Kropka na początku linii musi być podwojona (body w base64 jej nie zawiera, ale na wszelki wypadek).
        $msg = preg_replace('/^\./m', '..', $msg);
        $cmd($msg . "\r\n.", [250]);
        $cmd('QUIT', [221]);
    } finally {
        fclose($fp);
    }
}
