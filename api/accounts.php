<?php
// Spielerkonten (freiwillig): Name + Passwort, Statistik und XP in der Datenbank.
// Zugangsdaten stehen in api/config.php (wird beim Deploy aus GitHub-Secrets erzeugt, nicht im Repository)
// oder in den Umgebungsvariablen TRUMPF_DB_DSN / TRUMPF_DB_USER / TRUMPF_DB_PASSWORD (für Tests).
declare(strict_types=1);

const XP_WIN = 100;
const XP_PLAYED = 25;
const XP_PER_TRICK = 10;
const XP_PER_OPPONENT = 25; // Sieg gegen mehr Gegner bringt mehr

function trumpf_db(): ?PDO
{
    static $pdo = false;
    if ($pdo !== false) {
        return $pdo;
    }
    $pdo = null;
    $config = null;
    if (getenv('TRUMPF_DB_DSN')) {
        $config = ['dsn' => getenv('TRUMPF_DB_DSN'), 'user' => getenv('TRUMPF_DB_USER') ?: null, 'password' => getenv('TRUMPF_DB_PASSWORD') ?: null];
    } elseif (is_file(__DIR__ . '/config.php')) {
        $config = require __DIR__ . '/config.php';
    }
    if (!is_array($config) || empty($config['dsn'])) {
        return null;
    }
    try {
        $pdo = new PDO($config['dsn'], $config['user'] ?? null, $config['password'] ?? null, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ]);
        if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') {
            $pdo->exec('CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password TEXT NOT NULL,
                auth_token TEXT UNIQUE,
                games_played INTEGER NOT NULL DEFAULT 0,
                wins INTEGER NOT NULL DEFAULT 0,
                losses INTEGER NOT NULL DEFAULT 0,
                xp INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                last_login TEXT NULL
            )');
        }
    } catch (PDOException $error) {
        $pdo = null;
    }
    return $pdo;
}

/** Level aus Gesamt-XP. Von Level L nach L+1 braucht man 100 + 50·(L−1) XP, jedes Level also 50 mehr. */
function trumpf_level(int $xp): array
{
    $level = 1;
    $need = 100;
    while ($xp >= $need) {
        $xp -= $need;
        $level++;
        $need = 100 + 50 * ($level - 1);
    }
    return ['level' => $level, 'xpInLevel' => $xp, 'xpForLevel' => $need];
}

function trumpf_account_public(array $row): array
{
    $played = (int) $row['games_played'];
    return [
        'name' => $row['name'],
        'gamesPlayed' => $played,
        'wins' => (int) $row['wins'],
        'losses' => (int) $row['losses'],
        'winRate' => $played > 0 ? (int) round(100 * (int) $row['wins'] / $played) : 0,
        'xp' => (int) $row['xp'],
    ] + trumpf_level((int) $row['xp']);
}

function trumpf_account_by_token(string $token): ?array
{
    $db = trumpf_db();
    if ($db === null || !preg_match('/^[a-f0-9]{48}$/', $token)) {
        return null;
    }
    $query = $db->prepare('SELECT * FROM accounts WHERE auth_token = ?');
    $query->execute([$token]);
    $row = $query->fetch();
    return $row ?: null;
}

function trumpf_account_by_name(string $name): ?array
{
    $db = trumpf_db();
    if ($db === null) {
        return null;
    }
    $query = $db->prepare('SELECT * FROM accounts WHERE LOWER(name) = LOWER(?)');
    $query->execute([$name]);
    $row = $query->fetch();
    return $row ?: null;
}

/** Aktionen register / login / profile. Antwortet direkt und beendet die Anfrage. */
function trumpf_account_action(string $action, array $input): void
{
    $db = trumpf_db();
    if ($db === null) {
        respond(['ok' => false, 'message' => 'Konten sind gerade nicht verfügbar (keine Datenbank).']);
    }
    try {
        if ($action === 'profile') {
            $row = trumpf_account_by_token(is_string($input['authToken'] ?? null) ? $input['authToken'] : '');
            respond($row ? ['ok' => true, 'account' => trumpf_account_public($row)] : ['ok' => false, 'code' => 'logged_out', 'message' => 'Bitte melde dich neu an.']);
        }

        $name = cleanName($input['name'] ?? '');
        $password = is_string($input['password'] ?? null) ? $input['password'] : '';
        if ($name === '' || $password === '') {
            respond(['ok' => false, 'message' => 'Bitte Spielername und Passwort eingeben.']);
        }
        if (strlen($password) > 100) {
            respond(['ok' => false, 'message' => 'Das Passwort ist zu lang.']);
        }

        if ($action === 'register') {
            if (trumpf_lower($name) === 'test-bot') {
                respond(['ok' => false, 'message' => 'Dieser Name ist reserviert.']);
            }
            if (trumpf_account_by_name($name) !== null) {
                respond(['ok' => false, 'message' => 'Diesen Spielernamen gibt es schon. Melde dich an oder nimm einen anderen.']);
            }
            $token = bin2hex(random_bytes(24));
            // Passwort bewusst im Klartext (Vorgabe für den Anfang).
            $insert = $db->prepare('INSERT INTO accounts (name, password, auth_token, last_login) VALUES (?, ?, ?, CURRENT_TIMESTAMP)');
            $insert->execute([$name, $password, $token]);
            respond(['ok' => true, 'authToken' => $token, 'account' => trumpf_account_public(trumpf_account_by_token($token))]);
        }

        // login
        $row = trumpf_account_by_name($name);
        if ($row === null || !hash_equals((string) $row['password'], $password)) {
            respond(['ok' => false, 'message' => 'Spielername oder Passwort stimmt nicht.']);
        }
        $token = $row['auth_token'] ?: bin2hex(random_bytes(24));
        $db->prepare('UPDATE accounts SET auth_token = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?')->execute([$token, $row['id']]);
        respond(['ok' => true, 'authToken' => $token, 'account' => trumpf_account_public(trumpf_account_by_token($token))]);
    } catch (PDOException $error) {
        respond(['ok' => false, 'message' => 'Datenbankfehler, bitte später nochmal versuchen.']);
    }
}

/**
 * Nach Spielende: Spiele, Siege, Niederlagen und XP der angemeldeten Spieler speichern (genau einmal pro Partie).
 * Das Ergebnis pro Spieler steht danach in game.xpAwards.
 */
function trumpf_record_results(TrumpfRoom $room): void
{
    $game = $room->data['game'] ?? null;
    if ($room->data['status'] !== 'finished' || $game === null || !empty($game['accountsSaved'])) {
        return;
    }
    $room->data['game']['accountsSaved'] = true;
    $room->touch();
    $db = trumpf_db();
    if ($db === null) {
        return;
    }
    $opponents = max(1, count($room->data['players']) - 1);
    $awards = [];
    try {
        foreach ($room->data['players'] as $index => $player) {
            $accountId = $player['accountId'] ?? null;
            if ($accountId === null) {
                continue;
            }
            $won = $player['id'] === $game['winnerId'];
            $tricks = (int) ($room->data['stats']['players'][$player['id']]['tricks'] ?? 0);
            $xp = ($won ? XP_WIN + XP_PER_OPPONENT * ($opponents - 1) : XP_PLAYED) + XP_PER_TRICK * $tricks;

            $query = $db->prepare('SELECT xp FROM accounts WHERE id = ?');
            $query->execute([$accountId]);
            $before = (int) ($query->fetchColumn() ?: 0);
            $db->prepare('UPDATE accounts SET games_played = games_played + 1, wins = wins + ?, losses = losses + ?, xp = xp + ? WHERE id = ?')
                ->execute([$won ? 1 : 0, $won ? 0 : 1, $xp, $accountId]);

            $levelBefore = trumpf_level($before)['level'];
            $after = trumpf_level($before + $xp);
            $awards[$player['id']] = ['xp' => $xp, 'levelBefore' => $levelBefore] + $after;
            $room->data['players'][$index]['accountLevel'] = $after['level'];
        }
    } catch (PDOException $error) {
        // Statistik ist Zusatz: Fehler dürfen das Spiel nicht stören.
    }
    $room->data['game']['xpAwards'] = $awards;
}
