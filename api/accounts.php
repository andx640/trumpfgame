<?php
// Spielerkonten (freiwillig): Name + Passwort, Statistik und XP in der Datenbank.
// Zugangsdaten stehen in api/config.php (wird beim Deploy aus GitHub-Secrets erzeugt, nicht im Repository)
// oder in den Umgebungsvariablen TRUMPF_DB_DSN / TRUMPF_DB_USER / TRUMPF_DB_PASSWORD (für Tests).
declare(strict_types=1);

const XP_WIN = 100;
const XP_PLAYED = 25;
const XP_PER_TRICK = 10;
const XP_PER_OPPONENT = 25; // Sieg gegen mehr Gegner bringt mehr
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
            respond($row ? ['ok' => true, 'account' => trumpf_account_public($row)] : ['ok' => false, 'code' => 'logged_out', 'message' => 'Bitte melde dich neu an.']);
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
            if (!empty($room->data['solo'])) {
                // Gegen die KI gibt es je nach Stufe weniger XP, gegen Leicht gar keine.
                $xp = (int) round($xp * (XP_AI_FACTOR[$room->data['aiLevel'] ?? 'medium'] ?? 0.7));
            }

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
                $friends[] = $public;
            } elseif ($isMine) {
                $outgoing[] = ['name' => $public['name'], 'level' => $public['level']];
            } else {
                $incoming[] = ['name' => $public['name'], 'level' => $public['level']];
            }
        }
    }
    usort($friends, static function ($a, $b) {
        return [$b['level'], $b['xp']] <=> [$a['level'], $a['xp']];
    });
    respond(['ok' => true, 'friends' => $friends, 'incoming' => $incoming, 'outgoing' => $outgoing]);
}
