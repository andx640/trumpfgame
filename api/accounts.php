<?php
// Spielerkonten (freiwillig): Name + Passwort, Statistik und XP in der Datenbank.
// Zugangsdaten stehen in api/config.php (wird beim Deploy aus GitHub-Secrets erzeugt, nicht im Repository)
// oder in den Umgebungsvariablen TRUMPF_DB_DSN / TRUMPF_DB_USER / TRUMPF_DB_PASSWORD (für Tests).
declare(strict_types=1);

require_once __DIR__ . '/push.php';

const XP_WIN = 100;
const XP_PLAYED = 25;
const XP_PER_TRICK = 10;
const XP_PER_OPPONENT = 25; // Sieg gegen mehr Gegner bringt mehr
const ONLINE_WINDOW_S = 75;   // so lange nach dem letzten Lebenszeichen gilt ein Spieler als online
const INVITE_TTL_S = 1800;    // Einladungen verfallen nach 30 Minuten
const XP_AI_FACTOR = ['easy' => 0.0, 'medium' => 0.35, 'hard' => 1.0]; // gegen Leicht gibt es keine XP

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
    } catch (PDOException $error) {
        $pdo = null;
    }
    return $pdo;
}

/** Legt die Tabellen an, falls es sie noch nicht gibt (MySQL bei All-Inkl und SQLite für Tests). */
function trumpf_ensure_schema(PDO $db): void
{
    static $done = false;
    if ($done) {
        return;
    }
    $done = true;
    if ($db->getAttribute(PDO::ATTR_DRIVER_NAME) === 'sqlite') {
        $db->exec('CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE COLLATE NOCASE,
            password TEXT NOT NULL,
            auth_token TEXT UNIQUE,
            games_played INTEGER NOT NULL DEFAULT 0,
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            xp INTEGER NOT NULL DEFAULT 0,
            current_streak INTEGER NOT NULL DEFAULT 0,
            best_streak INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            last_login TEXT NULL
        )');
        $db->exec("CREATE TABLE IF NOT EXISTS friendships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            friend_id INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, friend_id)
        )");
        $db->exec("CREATE TABLE IF NOT EXISTS invites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            from_id INTEGER NOT NULL,
            to_id INTEGER NOT NULL,
            room TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (from_id, to_id, room)
        )");
        $db->exec('CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )');
        trumpf_add_streak_columns($db);
        return;
    }
    $db->exec('CREATE TABLE IF NOT EXISTS accounts (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(20) NOT NULL,
        password VARCHAR(100) NOT NULL,
        auth_token CHAR(48) NULL,
        games_played INT UNSIGNED NOT NULL DEFAULT 0,
        wins INT UNSIGNED NOT NULL DEFAULT 0,
        losses INT UNSIGNED NOT NULL DEFAULT 0,
        xp INT UNSIGNED NOT NULL DEFAULT 0,
        current_streak INT UNSIGNED NOT NULL DEFAULT 0,
        best_streak INT UNSIGNED NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_name (name),
        UNIQUE KEY uniq_auth_token (auth_token)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    $db->exec("CREATE TABLE IF NOT EXISTS friendships (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id INT UNSIGNED NOT NULL,
        friend_id INT UNSIGNED NOT NULL,
        status VARCHAR(10) NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_pair (user_id, friend_id),
        KEY idx_friend (friend_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $db->exec("CREATE TABLE IF NOT EXISTS invites (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        from_id INT UNSIGNED NOT NULL,
        to_id INT UNSIGNED NOT NULL,
        room VARCHAR(8) NOT NULL,
        created_at INT UNSIGNED NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_invite (from_id, to_id, room),
        KEY idx_to (to_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $db->exec("CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        account_id INT UNSIGNED NOT NULL,
        endpoint VARCHAR(500) NOT NULL,
        p256dh VARCHAR(200) NOT NULL,
        auth VARCHAR(100) NOT NULL,
        created_at INT UNSIGNED NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_endpoint (endpoint(255)),
        KEY idx_account (account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    trumpf_add_streak_columns($db);
}

/** Ältere accounts-Tabellen ohne Siegesserie-Spalten nachrüsten. */
function trumpf_add_streak_columns(PDO $db): void
{
    foreach (['current_streak', 'best_streak', 'last_seen'] as $column) {
        try {
            $db->query("SELECT $column FROM accounts LIMIT 1");
        } catch (PDOException $missing) {
            $db->exec("ALTER TABLE accounts ADD COLUMN $column INT NOT NULL DEFAULT 0");
        }
    }
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
        'currentStreak' => (int) ($row['current_streak'] ?? 0),
        'bestStreak' => (int) ($row['best_streak'] ?? 0),
    ] + trumpf_level((int) $row['xp']);
}

function trumpf_account_by_token(string $token): ?array
{
    $db = trumpf_db();
    if ($db === null || !preg_match('/^[a-f0-9]{48}$/', $token)) {
        return null;
    }
    try {
        $query = $db->prepare('SELECT * FROM accounts WHERE auth_token = ?');
        $query->execute([$token]);
        $row = $query->fetch();
        return $row ?: null;
    } catch (PDOException $error) {
        return null; // Tabelle fehlt noch
    }
}

function trumpf_account_by_name(string $name): ?array
{
    $db = trumpf_db();
    if ($db === null) {
        return null;
    }
    try {
        $query = $db->prepare('SELECT * FROM accounts WHERE LOWER(name) = LOWER(?)');
        $query->execute([$name]);
        $row = $query->fetch();
        return $row ?: null;
    } catch (PDOException $error) {
        return null; // Tabelle fehlt noch
    }
}

function trumpf_data_dir(): string
{
    return getenv('TRUMPF_DATA_DIR') ?: __DIR__ . '/data';
}

function trumpf_is_online(array $row): bool
{
    return time() - (int) ($row['last_seen'] ?? 0) <= ONLINE_WINDOW_S;
}

/** Offene Einladungen für ein Konto. Einladungen zu Räumen, die nicht mehr in der Lobby sind, werden dabei aufgeräumt. */
function trumpf_pending_invites(PDO $db, int $accountId): array
{
    $db->prepare('DELETE FROM invites WHERE created_at < ?')->execute([time() - INVITE_TTL_S]);
    $query = $db->prepare('SELECT invites.id, invites.room, invites.created_at, accounts.name AS from_name FROM invites JOIN accounts ON accounts.id = invites.from_id WHERE invites.to_id = ? ORDER BY invites.id DESC');
    $query->execute([$accountId]);
    $result = [];
    foreach ($query->fetchAll() as $row) {
        $file = trumpf_data_dir() . '/room_' . $row['room'] . '.json';
        $room = is_file($file) ? json_decode((string) file_get_contents($file), true) : null;
        $open = is_array($room) && ($room['status'] ?? '') === 'lobby' && count($room['players'] ?? []) < MAX_PLAYERS && empty($room['solo']);
        if (!$open) {
            $db->prepare('DELETE FROM invites WHERE id = ?')->execute([$row['id']]);
            continue;
        }
        $result[] = ['id' => (int) $row['id'], 'from' => $row['from_name'], 'room' => $row['room'], 'at' => (int) $row['created_at'] * 1000];
    }
    return $result;
}

/** Einladung in die Lobby, in der der Absender sitzt. Gibt eine Antwort für den Browser zurück. */
function trumpf_send_invite(PDO $db, TrumpfRoom $room, int $selfIndex, string $roomCode, string $targetName): array
{
    trumpf_ensure_schema($db);
    $self = $room->data['players'][$selfIndex];
    if (($self['accountId'] ?? null) === null) {
        return ['ok' => false, 'message' => 'Zum Einladen musst du angemeldet sein.'];
    }
    if ($room->data['status'] !== 'lobby' || !empty($room->data['solo'])) {
        return ['ok' => false, 'message' => 'Eingeladen wird nur in einer offenen Lobby.'];
    }
    if (count($room->data['players']) >= MAX_PLAYERS) {
        return ['ok' => false, 'message' => 'Die Lobby ist schon voll.'];
    }
    $target = trumpf_account_by_name(cleanName($targetName));
    if ($target === null) {
        return ['ok' => false, 'message' => 'Diesen Spieler gibt es nicht.'];
    }
    $myId = (int) $self['accountId'];
    $targetId = (int) $target['id'];
    foreach ($room->data['players'] as $player) {
        if ((int) ($player['accountId'] ?? 0) === $targetId) {
            return ['ok' => false, 'message' => $target['name'] . ' ist schon in der Lobby.'];
        }
    }
    $friendship = $db->prepare("SELECT COUNT(*) FROM friendships WHERE status = 'accepted' AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))");
    $friendship->execute([$myId, $targetId, $targetId, $myId]);
    if ((int) $friendship->fetchColumn() === 0) {
        return ['ok' => false, 'message' => 'Du kannst nur Freunde einladen.'];
    }
    $existing = $db->prepare('SELECT COUNT(*) FROM invites WHERE from_id = ? AND to_id = ? AND room = ?');
    $existing->execute([$myId, $targetId, $roomCode]);
    if ((int) $existing->fetchColumn() > 0) {
        return ['ok' => false, 'message' => $target['name'] . ' wurde schon eingeladen.'];
    }
    $db->prepare('INSERT INTO invites (from_id, to_id, room, created_at) VALUES (?, ?, ?, ?)')->execute([$myId, $targetId, $roomCode, time()]);
    $pushed = trumpf_push_to_account($db, $targetId, [
        'title' => 'Einladung von ' . $self['name'],
        'body' => $self['name'] . ' lädt dich zu einem Spiel ein.',
        'url' => '/',
        'tag' => 'invite-' . $roomCode,
    ]);
    return ['ok' => true, 'message' => $target['name'] . ' wurde eingeladen.', 'pushed' => $pushed];
}

/** Push an alle Geräte eines Kontos. Gibt die Zahl der zugestellten Nachrichten zurück; tote Abos werden gelöscht. */
function trumpf_push_to_account(PDO $db, int $accountId, array $message): int
{
    $query = $db->prepare('SELECT * FROM push_subscriptions WHERE account_id = ? ORDER BY id DESC LIMIT 5');
    $query->execute([$accountId]);
    $delivered = 0;
    foreach ($query->fetchAll() as $subscription) {
        $status = push_send(trumpf_data_dir(), $subscription, $message);
        if ($status !== null && $status >= 200 && $status < 300) {
            $delivered++;
        } elseif ($status === 404 || $status === 410) {
            $db->prepare('DELETE FROM push_subscriptions WHERE id = ?')->execute([$subscription['id']]);
        }
    }
    return $delivered;
}

/** Rangplatz in der Gesamtrangliste (gleiche Sortierung wie die Top 10: XP, dann Siege, dann wer zuerst da war). */
function trumpf_account_rank(PDO $db, array $row): int
{
    $query = $db->prepare('SELECT COUNT(*) FROM accounts WHERE xp > ? OR (xp = ? AND wins > ?) OR (xp = ? AND wins = ? AND id < ?)');
    $xp = (int) $row['xp'];
    $wins = (int) $row['wins'];
    $query->execute([$xp, $xp, $wins, $xp, $wins, (int) $row['id']]);
    return (int) $query->fetchColumn() + 1;
}

/** Öffentliches Profil mit Rangplatz und Zahl aller Spieler. */
function trumpf_account_with_rank(PDO $db, array $row): array
{
    return trumpf_account_public($row) + [
        'rank' => trumpf_account_rank($db, $row),
        'players' => (int) $db->query('SELECT COUNT(*) FROM accounts')->fetchColumn(),
    ];
}

/** Aktionen register / login / profile. Antwortet direkt und beendet die Anfrage. */
function trumpf_account_action(string $action, array $input): void
{
    $db = trumpf_db();
    if ($db === null) {
        respond(['ok' => false, 'message' => 'Konten sind gerade nicht verfügbar (keine Datenbank).']);
    }
    try {
        trumpf_ensure_schema($db);
        if ($action === 'profile') {
            $row = trumpf_account_by_token(is_string($input['authToken'] ?? null) ? $input['authToken'] : '');
            respond($row ? ['ok' => true, 'account' => trumpf_account_with_rank($db, $row)] : ['ok' => false, 'code' => 'logged_out', 'message' => 'Bitte melde dich neu an.']);
        }
        if (in_array($action, ['heartbeat', 'inviteDecline', 'pushKey', 'pushSubscribe', 'pushUnsubscribe'], true)) {
            $me = trumpf_account_by_token(is_string($input['authToken'] ?? null) ? $input['authToken'] : '');
            if ($me === null) {
                respond(['ok' => false, 'code' => 'logged_out', 'message' => 'Bitte melde dich neu an.']);
            }
            $myId = (int) $me['id'];
            if ($action === 'heartbeat') {
                // Lebenszeichen der App: macht den Spieler für Freunde „on“ und liefert offene Einladungen
                $db->prepare('UPDATE accounts SET last_seen = ? WHERE id = ?')->execute([time(), $myId]);
                respond(['ok' => true, 'invites' => trumpf_pending_invites($db, $myId)]);
            }
            if ($action === 'inviteDecline') {
                $db->prepare('DELETE FROM invites WHERE id = ? AND to_id = ?')->execute([(int) ($input['id'] ?? 0), $myId]);
                respond(['ok' => true, 'invites' => trumpf_pending_invites($db, $myId)]);
            }
            if ($action === 'pushKey') {
                $keys = push_vapid_keys(trumpf_data_dir());
                respond($keys === null ? ['ok' => false, 'message' => 'Push ist auf diesem Server nicht verfügbar.'] : ['ok' => true, 'key' => push_b64url($keys['public'])]);
            }
            $sub = is_array($input['subscription'] ?? null) ? $input['subscription'] : [];
            $endpoint = is_string($sub['endpoint'] ?? null) ? $sub['endpoint'] : (is_string($input['endpoint'] ?? null) ? $input['endpoint'] : '');
            if ($action === 'pushUnsubscribe') {
                $db->prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND account_id = ?')->execute([$endpoint, $myId]);
                respond(['ok' => true]);
            }
            $p256dh = is_string($sub['keys']['p256dh'] ?? null) ? $sub['keys']['p256dh'] : '';
            $authKey = is_string($sub['keys']['auth'] ?? null) ? $sub['keys']['auth'] : '';
            if (!push_endpoint_ok($endpoint) || strlen(push_b64url_decode($p256dh)) !== 65 || strlen(push_b64url_decode($authKey)) !== 16) {
                respond(['ok' => false, 'message' => 'Ungültiges Push-Abo.']);
            }
            $db->prepare('DELETE FROM push_subscriptions WHERE endpoint = ?')->execute([$endpoint]);
            $db->prepare('INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)')->execute([$myId, $endpoint, $p256dh, $authKey, time()]);
            respond(['ok' => true]);
        }
        if ($action === 'playerProfile') {
            // Profil eines beliebigen Spielers (wie in der Rangliste öffentlich, ohne Passwort)
            $row = trumpf_account_by_name(cleanName($input['name'] ?? ''));
            respond($row ? ['ok' => true, 'account' => trumpf_account_with_rank($db, $row)] : ['ok' => false, 'message' => 'Diesen Spieler gibt es nicht.']);
        }
        if ($action === 'leaderboard') {
            // Top 10 nach XP (Level ergibt sich aus XP), bei Gleichstand mehr Siege zuerst
            $rows = $db->query('SELECT * FROM accounts ORDER BY xp DESC, wins DESC, id ASC LIMIT 10')->fetchAll();
            $players = [];
            foreach ($rows as $index => $row) {
                $players[] = trumpf_account_public($row) + ['rank' => $index + 1];
            }
            respond(['ok' => true, 'players' => $players]);
        }
        if (in_array($action, ['friends', 'friendAdd', 'friendAccept', 'friendRemove', 'friendProfile'], true)) {
            trumpf_friend_action($db, $action, $input);
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
            if (strpos(trumpf_lower($name), 'ki ') === 0) {
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
    $opponents = !empty($game['teams']) ? 1 : max(1, count($room->data['players']) - 1);
    $awards = [];
    try {
        trumpf_ensure_schema($db);
        foreach ($room->data['players'] as $index => $player) {
            $accountId = $player['accountId'] ?? null;
            if ($accountId === null) {
                continue;
            }
            $won = in_array($player['id'], $game['winnerIds'] ?? [$game['winnerId']], true);
            $tricks = (int) ($room->data['stats']['players'][$player['id']]['tricks'] ?? 0);
            $xp = ($won ? XP_WIN + XP_PER_OPPONENT * ($opponents - 1) : XP_PLAYED) + XP_PER_TRICK * $tricks;
            if (!empty($room->data['solo'])) {
                // Gegen die KI gibt es je nach Stufe weniger XP, gegen Leicht gar keine.
                $xp = (int) round($xp * (XP_AI_FACTOR[$room->data['aiLevel'] ?? 'medium'] ?? 0.7));
            }

            $query = $db->prepare('SELECT xp, current_streak, best_streak FROM accounts WHERE id = ?');
            $query->execute([$accountId]);
            $row = $query->fetch() ?: ['xp' => 0, 'current_streak' => 0, 'best_streak' => 0];
            $before = (int) $row['xp'];
            // Siegesserie: gewonnene Partien am Stück, Rekord bleibt
            $streak = $won ? (int) $row['current_streak'] + 1 : 0;
            $best = max((int) $row['best_streak'], $streak);
            $db->prepare('UPDATE accounts SET games_played = games_played + 1, wins = wins + ?, losses = losses + ?, xp = xp + ?, current_streak = ?, best_streak = ? WHERE id = ?')
                ->execute([$won ? 1 : 0, $won ? 0 : 1, $xp, $streak, $best, $accountId]);

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

/** Freundschaften: Anfrage per Name senden, annehmen, entfernen; Freundesliste mit Profilen. */
function trumpf_friend_action(PDO $db, string $action, array $input): void
{
    $me = trumpf_account_by_token(is_string($input['authToken'] ?? null) ? $input['authToken'] : '');
    if ($me === null) {
        respond(['ok' => false, 'code' => 'logged_out', 'message' => 'Bitte melde dich neu an.']);
    }
    $myId = (int) $me['id'];
    $other = null;
    if ($action !== 'friends') {
        $other = trumpf_account_by_name(cleanName($input['name'] ?? ''));
        if ($other === null) {
            respond(['ok' => false, 'message' => 'Diesen Spieler gibt es nicht.']);
        }
        if ((int) $other['id'] === $myId) {
            respond(['ok' => false, 'message' => 'Das bist du selbst.']);
        }
    }
    $otherId = $other === null ? 0 : (int) $other['id'];
    $relation = static function (int $from, int $to) use ($db): ?array {
        $query = $db->prepare('SELECT * FROM friendships WHERE user_id = ? AND friend_id = ?');
        $query->execute([$from, $to]);
        $row = $query->fetch();
        return $row ?: null;
    };

    if ($action === 'friendAdd') {
        $mine = $relation($myId, $otherId);
        $theirs = $relation($otherId, $myId);
        if (($mine && $mine['status'] === 'accepted') || ($theirs && $theirs['status'] === 'accepted')) {
            respond(['ok' => false, 'message' => $other['name'] . ' ist schon dein Freund.']);
        }
        if ($theirs) {
            // Der andere hat dir schon eine Anfrage geschickt: gleich annehmen.
            $db->prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?")->execute([$theirs['id']]);
            respond(['ok' => true, 'message' => 'Du und ' . $other['name'] . ' seid jetzt Freunde.']);
        }
        if ($mine) {
            respond(['ok' => false, 'message' => 'Deine Anfrage an ' . $other['name'] . ' läuft schon.']);
        }
        $db->prepare("INSERT INTO friendships (user_id, friend_id, status) VALUES (?, ?, 'pending')")->execute([$myId, $otherId]);
        respond(['ok' => true, 'message' => 'Anfrage an ' . $other['name'] . ' gesendet.']);
    }

    if ($action === 'friendAccept') {
        $theirs = $relation($otherId, $myId);
        if (!$theirs) {
            respond(['ok' => false, 'message' => 'Es gibt keine Anfrage von ' . $other['name'] . '.']);
        }
        $db->prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?")->execute([$theirs['id']]);
        respond(['ok' => true, 'message' => 'Du und ' . $other['name'] . ' seid jetzt Freunde.']);
    }

    if ($action === 'friendRemove') {
        // entfernt Freundschaft, offene Anfrage (gesendet oder erhalten)
        $db->prepare('DELETE FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
            ->execute([$myId, $otherId, $otherId, $myId]);
        respond(['ok' => true]);
    }

    if ($action === 'friendProfile') {
        $mine = $relation($myId, $otherId);
        $theirs = $relation($otherId, $myId);
        if (!(($mine && $mine['status'] === 'accepted') || ($theirs && $theirs['status'] === 'accepted'))) {
            respond(['ok' => false, 'message' => 'Das Profil siehst du nur bei Freunden.']);
        }
        respond(['ok' => true, 'account' => trumpf_account_public($other)]);
    }

    // friends: Liste mit Profilen, erhaltene und gesendete Anfragen
    $query = $db->prepare('SELECT * FROM friendships WHERE user_id = ? OR friend_id = ?');
    $query->execute([$myId, $myId]);
    $friends = [];
    $incoming = [];
    $outgoing = [];
    $ids = [];
    foreach ($query->fetchAll() as $row) {
        $isMine = (int) $row['user_id'] === $myId;
        $otherRowId = (int) ($isMine ? $row['friend_id'] : $row['user_id']);
        $ids[$otherRowId] = [$row['status'], $isMine];
    }
    if ($ids) {
        $marks = implode(',', array_fill(0, count($ids), '?'));
        $accounts = $db->prepare("SELECT * FROM accounts WHERE id IN ($marks)");
        $accounts->execute(array_keys($ids));
        foreach ($accounts->fetchAll() as $account) {
            [$status, $isMine] = $ids[(int) $account['id']];
            $public = trumpf_account_public($account);
            if ($status === 'accepted') {
                $friends[] = $public + ['online' => trumpf_is_online($account)];
            } elseif ($isMine) {
                $outgoing[] = ['name' => $public['name'], 'level' => $public['level']];
            } else {
                $incoming[] = ['name' => $public['name'], 'level' => $public['level']];
            }
        }
    }
    usort($friends, static function ($a, $b) {
        return [(int) $b['online'], $b['level'], $b['xp']] <=> [(int) $a['online'], $a['level'], $a['xp']];
    });
    respond(['ok' => true, 'friends' => $friends, 'incoming' => $incoming, 'outgoing' => $outgoing]);
}
