<?php
// Kleiner Ersatz für einen Push-Dienst im Test: speichert die letzte Anfrage (Header und Body) in den Datenordner.
$dir = getenv('TRUMPF_DATA_DIR') ?: sys_get_temp_dir();
file_put_contents($dir . '/push-last.json', json_encode([
    'authorization' => $_SERVER['HTTP_AUTHORIZATION'] ?? '',
    'encoding' => $_SERVER['HTTP_CONTENT_ENCODING'] ?? '',
    'ttl' => $_SERVER['HTTP_TTL'] ?? '',
    'body' => base64_encode(file_get_contents('php://input')),
]));
file_put_contents($dir . '/push-count.txt', (string) (1 + (int) @file_get_contents($dir . '/push-count.txt')));
http_response_code($_SERVER['REQUEST_URI'] === '/gone' ? 410 : 201);
