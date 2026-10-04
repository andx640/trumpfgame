<?php
// Web-Push ohne Fremdbibliothek: VAPID-Schlüssel, Verschlüsselung nach RFC 8291 (aes128gcm) und Versand.
declare(strict_types=1);

/** Nur https-Endpunkte; für Tests darf ein lokaler http-Endpunkt erlaubt werden (TRUMPF_PUSH_ALLOW_HTTP=1). */
function push_endpoint_ok(string $endpoint): bool
{
    if (strlen($endpoint) > 500) {
        return false;
    }
    if (strpos($endpoint, 'https://') === 0) {
        return true;
    }
    return getenv('TRUMPF_PUSH_ALLOW_HTTP') === '1' && strpos($endpoint, 'http://127.0.0.1') === 0;
}

function push_b64url(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function push_b64url_decode(string $data): string
{
    return (string) base64_decode(strtr($data, '-_', '+/') . str_repeat('=', (4 - strlen($data) % 4) % 4), true);
}

/** Rohen öffentlichen P-256-Punkt (65 Byte) in einen OpenSSL-Schlüssel umwandeln. */
function push_public_key_resource(string $point)
{
    $der = hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point;
    $pem = "-----BEGIN PUBLIC KEY-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END PUBLIC KEY-----\n";
    return openssl_pkey_get_public($pem);
}

/** @return array{pem:string, public:string}|null Schlüsselpaar aus 32-Byte-Teilen */
function push_new_key_pair(): ?array
{
    $key = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    if ($key === false) {
        return null;
    }
    $details = openssl_pkey_get_details($key);
    if (!isset($details['ec']['x'], $details['ec']['y'])) {
        return null;
    }
    openssl_pkey_export($key, $pem);
    return [
        'pem' => $pem,
        'public' => "\x04" . str_pad($details['ec']['x'], 32, "\0", STR_PAD_LEFT) . str_pad($details['ec']['y'], 32, "\0", STR_PAD_LEFT),
    ];
}

/** VAPID-Schlüssel des Servers (wird beim ersten Bedarf erzeugt und im Datenordner gespeichert). */
function push_vapid_keys(string $dataDir): ?array
{
    static $cache = null;
    if ($cache !== null) {
        return $cache;
    }
    $file = $dataDir . '/vapid.json';
    $stored = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
    if (is_array($stored) && !empty($stored['pem']) && !empty($stored['public'])) {
        return $cache = ['pem' => $stored['pem'], 'public' => push_b64url_decode($stored['public'])];
    }
    $pair = push_new_key_pair();
    if ($pair === null) {
        return null;
    }
    @file_put_contents($file, json_encode(['pem' => $pair['pem'], 'public' => push_b64url($pair['public'])]), LOCK_EX);
    return $cache = $pair;
}

/** Signiertes VAPID-Token (ES256) für den Push-Dienst. */
function push_vapid_jwt(string $audience, array $keys): string
{
    $head = push_b64url((string) json_encode(['typ' => 'JWT', 'alg' => 'ES256']));
    $claims = push_b64url((string) json_encode(['aud' => $audience, 'exp' => time() + 12 * 3600, 'sub' => 'https://andi-trumpf.de']));
    openssl_sign("$head.$claims", $der, $keys['pem'], OPENSSL_ALGO_SHA256);
    // DER-Signatur (SEQUENCE { INTEGER r, INTEGER s }) in die rohe 64-Byte-Form umwandeln
    $offset = 4;
    $rLength = ord($der[3]);
    $r = substr($der, $offset, $rLength);
    $offset += $rLength + 2;
    $sLength = ord($der[$offset - 1]);
    $s = substr($der, $offset, $sLength);
    $raw = str_pad(ltrim($r, "\0"), 32, "\0", STR_PAD_LEFT) . str_pad(ltrim($s, "\0"), 32, "\0", STR_PAD_LEFT);
    return "$head.$claims." . push_b64url($raw);
}

/** Nachricht für ein Gerät verschlüsseln (RFC 8291, aes128gcm). */
function push_encrypt(string $payload, string $uaPublic, string $authSecret): ?string
{
    $server = push_new_key_pair();
    $uaKey = push_public_key_resource($uaPublic);
    if ($server === null || $uaKey === false) {
        return null;
    }
    $serverKey = openssl_pkey_get_private($server['pem']);
    $shared = openssl_pkey_derive($uaKey, $serverKey, 32);
    if ($shared === false) {
        return null;
    }
    $ikm = hash_hkdf('sha256', $shared, 32, "WebPush: info\0" . $uaPublic . $server['public'], $authSecret);
    $salt = random_bytes(16);
    $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
    $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
    $cipher = openssl_encrypt($payload . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);
    if ($cipher === false) {
        return null;
    }
    return $salt . pack('N', 4096) . chr(65) . $server['public'] . $cipher . $tag;
}

/**
 * Push an ein Gerät senden. Gibt den HTTP-Status zurück (0 = nicht erreichbar, null = Fehler beim Vorbereiten).
 * 404/410 bedeuten: Abo ist abgelaufen und sollte gelöscht werden.
 */
function push_send(string $dataDir, array $subscription, array $message): ?int
{
    $keys = push_vapid_keys($dataDir);
    $endpoint = (string) ($subscription['endpoint'] ?? '');
    $parts = parse_url($endpoint);
    if ($keys === null || !isset($parts['scheme'], $parts['host']) || !push_endpoint_ok($endpoint)) {
        return null;
    }
    $body = push_encrypt((string) json_encode($message, JSON_UNESCAPED_UNICODE), push_b64url_decode((string) $subscription['p256dh']), push_b64url_decode((string) $subscription['auth']));
    if ($body === null) {
        return null;
    }
    $audience = $parts['scheme'] . '://' . $parts['host'] . (isset($parts['port']) ? ':' . $parts['port'] : '');
    $headers = [
        'Authorization: vapid t=' . push_vapid_jwt($audience, $keys) . ', k=' . push_b64url($keys['public']),
        'Content-Encoding: aes128gcm',
        'Content-Type: application/octet-stream',
        'TTL: 1800',
        'Urgency: high',
        'Content-Length: ' . strlen($body),
    ];
    $context = stream_context_create(['http' => [
        'method' => 'POST',
        'header' => implode("\r\n", $headers),
        'content' => $body,
        'timeout' => 4,
        'ignore_errors' => true,
    ]]);
    $result = @file_get_contents($endpoint, false, $context);
    $status = 0;
    foreach ($http_response_header ?? [] as $line) {
        if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $match)) {
            $status = (int) $match[1];
        }
    }
    return $result === false && $status === 0 ? 0 : $status;
}
