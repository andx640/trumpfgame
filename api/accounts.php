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
const DAILY_PACK_CARDS = 20; // Tagespack: einmal pro Tag und Konto, Tageswechsel um Mitternacht deutscher Zeit
const XP_AI_FACTOR = ['easy' => 0.2, 'medium' => 0.5, 'hard' => 1.0]; // gegen Leicht 20 %, gegen Mittel 50 % der XP

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
            last_daily TEXT NULL,
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
        $db->exec('CREATE TABLE IF NOT EXISTS collection (
            account_id INTEGER NOT NULL,
            card_id TEXT NOT NULL,
            qty INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (account_id, card_id)
        )');
        $db->exec('CREATE TABLE IF NOT EXISTS collection_starter (
            account_id INTEGER PRIMARY KEY
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
        last_daily VARCHAR(10) NULL,
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
    $db->exec("CREATE TABLE IF NOT EXISTS collection (
        account_id INT UNSIGNED NOT NULL,
        card_id VARCHAR(8) NOT NULL,
        qty INT UNSIGNED NOT NULL DEFAULT 1,
        PRIMARY KEY (account_id, card_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
    $db->exec("CREATE TABLE IF NOT EXISTS collection_starter (
        account_id INT UNSIGNED NOT NULL,
        PRIMARY KEY (account_id)
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
    try {
        $db->query('SELECT last_daily FROM accounts LIMIT 1');
    } catch (PDOException $missing) {
        $db->exec('ALTER TABLE accounts ADD COLUMN last_daily VARCHAR(10) NULL');
    }
}

// ---------------------------------------------------------------------------------------------
// Sammlung: eigene Karten pro Konto, Startkarten, Ziehen nach Seltenheit

const STARTER_CARDS = 16;
const DRAW_CHANCES = [1 => 60, 2 => 25, 3 => 10, 4 => 4, 5 => 1]; // Prozent je Seltenheitsstufe (Rarität 1–5)

/** Die schwächsten Autos: niedrigste Rarität zuerst, bei Gleichstand die schlechtesten Werte. */
function trumpf_starter_ids(): array
{
    static $ids = null;
    if ($ids !== null) {
        return $ids;
    }
    $deck = array_values(trumpf_load_deck());
    $score = [];
    foreach (TRUMPF_CATEGORIES as $key => $rule) {
        if ($key === 'raritaet') {
            continue;
        }
        $values = array_map(static function ($card) use ($key) {
            return (float) $card[$key];
        }, $deck);
        foreach ($deck as $card) {
            $value = (float) $card[$key];
            $better = 0;
            foreach ($values as $other) {
                if ($value <= 0) {
                    break; // kein Wert (z. B. Hubraum beim Elektroauto) zählt als schwach
                }
                $better += ($rule['direction'] === 'low' ? $other > $value : $other < $value) ? 1 : 0;
            }
            $score[$card['c_id']] = ($score[$card['c_id']] ?? 0) + $better;
        }
    }
    usort($deck, static function ($a, $b) use ($score) {
        return [(int) $a['raritaet'], $score[$a['c_id']]] <=> [(int) $b['raritaet'], $score[$b['c_id']]];
    });
    $ids = array_map(static function ($card) {
        return (string) $card['c_id'];
    }, array_slice($deck, 0, STARTER_CARDS));
    return $ids;
}

/** Eine zufällige Karte: erst die Stufe nach DRAW_CHANCES (begrenzt auf minTier–maxTier), dann ein Auto dieser Stufe. */
function trumpf_draw_card(int $minTier = 1, int $maxTier = 5): string
{
    $chances = array_filter(DRAW_CHANCES, static function ($level) use ($minTier, $maxTier) {
        return $level >= $minTier && $level <= $maxTier;
    }, ARRAY_FILTER_USE_KEY);
    $roll = random_int(1, array_sum($chances));
    $tier = $minTier;
    foreach ($chances as $level => $chance) {
        if ($roll <= $chance) {
            $tier = $level;
            break;
        }
        $roll -= $chance;
    }
    $pool = [];
    foreach (trumpf_load_deck() as $id => $card) {
        if ((int) $card['raritaet'] === $tier) {
            $pool[] = (string) $id;
        }
    }
    return $pool[random_int(0, count($pool) - 1)];
}

/** Karte(n) gutschreiben. Gibt zurück, ob das Auto vorher noch nicht in der Sammlung war. */
function trumpf_collection_add(PDO $db, int $accountId, string $cardId, int $qty = 1): bool
{
    $query = $db->prepare('SELECT qty FROM collection WHERE account_id = ? AND card_id = ?');
    $query->execute([$accountId, $cardId]);
    $have = $query->fetchColumn();
    if ($have === false) {
        $db->prepare('INSERT INTO collection (account_id, card_id, qty) VALUES (?, ?, ?)')->execute([$accountId, $cardId, $qty]);
        return true;
    }
    $db->prepare('UPDATE collection SET qty = qty + ? WHERE account_id = ? AND card_id = ?')->execute([$qty, $accountId, $cardId]);
    return (int) $have <= 0;
}

/** Eine Karte abgeben (Risiko-Modus). Gibt false zurück, wenn sie nicht (mehr) da ist. */
function trumpf_collection_remove(PDO $db, int $accountId, string $cardId): bool
{
    $query = $db->prepare('SELECT qty FROM collection WHERE account_id = ? AND card_id = ?');
    $query->execute([$accountId, $cardId]);
    $have = (int) $query->fetchColumn();
    if ($have <= 0) {
        return false;
    }
    if ($have === 1) {
        $db->prepare('DELETE FROM collection WHERE account_id = ? AND card_id = ?')->execute([$accountId, $cardId]);
    } else {
        $db->prepare('UPDATE collection SET qty = qty - 1 WHERE account_id = ? AND card_id = ?')->execute([$accountId, $cardId]);
    }
    return true;
}

/** Eigene Karten eines Kontos als [card_id => Anzahl]. Beim ersten Mal gibt es die 16 Startkarten. */
function trumpf_owned_cards(PDO $db, int $accountId): array
{
    trumpf_ensure_schema($db);
    $given = $db->prepare('SELECT COUNT(*) FROM collection_starter WHERE account_id = ?');
    $given->execute([$accountId]);
    if ((int) $given->fetchColumn() === 0) {
        $db->prepare('INSERT INTO collection_starter (account_id) VALUES (?)')->execute([$accountId]);
        foreach (trumpf_starter_ids() as $cardId) {
            trumpf_collection_add($db, $accountId, $cardId);
        }
    }
    $deck = trumpf_load_deck();
    $query = $db->prepare('SELECT card_id, qty FROM collection WHERE account_id = ? AND qty > 0');
    $query->execute([$accountId]);
    $owned = [];
    foreach ($query->fetchAll() as $row) {
        if (isset($deck[(string) $row['card_id']])) {
            $owned[(string) $row['card_id']] = (int) $row['qty'];
        }
    }
    ksort($owned);
    return $owned;
}

/** Zufällige Auswahl aus einer Sammlung (Duplikate nur so oft, wie man sie besitzt). */
function trumpf_random_from_owned(array $owned, int $count, array $taken = []): array
{
    $pool = [];
    foreach ($owned as $cardId => $qty) {
        $free = $qty - count(array_keys($taken, (string) $cardId, true));
        for ($i = 0; $i < $free; $i++) {
            $pool[] = (string) $cardId;
        }
    }
    return array_slice(trumpf_shuffle($pool), 0, max(0, $count));
}

// ---------------------------------------------------------------------------------------------
// Tagespack: einmal pro Tag ein Pack mit DAILY_PACK_CARDS Karten

/** Der heutige Tag (Europe/Berlin) als Y-m-d. */
function trumpf_today(): string
{
    return (new DateTime('now', new DateTimeZone('Europe/Berlin')))->format('Y-m-d');
}

/** Zeitpunkt (ms) des nächsten Mitternachts in Europe/Berlin: ab dann gibt es das nächste Tagespack. */
function trumpf_next_daily_ms(): int
{
    $midnight = (new DateTime('tomorrow', new DateTimeZone('Europe/Berlin')));
    return (int) $midnight->format('U') * 1000;
}

function trumpf_daily_available(array $row): bool
{
    return ($row['last_daily'] ?? null) !== trumpf_today();
}

/** Tagespack abholen: zieht die Karten nach den Seltenheitschancen und schreibt sie gut. Nur einmal pro Tag (auch bei gleichzeitigen Anfragen). */
function trumpf_daily_claim(PDO $db, array $row): array
{
    $today = trumpf_today();
    // Den Tag zuerst reservieren: nur wer ihn damit gewinnt, bekommt die Karten (kein doppeltes Abholen bei zwei Anfragen)
    $claim = $db->prepare('UPDATE accounts SET last_daily = ? WHERE id = ? AND (last_daily IS NULL OR last_daily <> ?)');
    $claim->execute([$today, (int) $row['id'], $today]);
    if ($claim->rowCount() === 0) {
        return ['ok' => false, 'message' => 'Dein Tagespack hast du heute schon geöffnet. Morgen gibt es das nächste.', 'nextAt' => trumpf_next_daily_ms()];
    }
    trumpf_owned_cards($db, (int) $row['id']); // Startkarten zuerst, damit „neu“ stimmt
    $deck = trumpf_load_deck();
    $scores = trumpf_card_scores();
    $cards = [];
    for ($i = 0; $i < DAILY_PACK_CARDS; $i++) {
        $cardId = trumpf_draw_card();
        $isNew = trumpf_collection_add($db, (int) $row['id'], $cardId);
        $cards[] = ['card' => $deck[$cardId] + ['score' => $scores[$cardId] ?? 0], 'isNew' => $isNew];
    }
    return ['ok' => true, 'cards' => $cards, 'categories' => TRUMPF_CATEGORIES, 'nextAt' => trumpf_next_daily_ms()];
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
    $collected = $db->prepare('SELECT COUNT(*) FROM collection WHERE account_id = ? AND qty > 0');
    $collected->execute([(int) $row['id']]);
    return trumpf_account_public($row) + [
        'collected' => (int) $collected->fetchColumn(),
        'totalCards' => count(trumpf_load_deck()),
        'dailyAvailable' => trumpf_daily_available($row),
        'dailyNextAt' => trumpf_next_daily_ms(),
        'dailyCards' => DAILY_PACK_CARDS,
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
            if ($row) {
                trumpf_owned_cards($db, (int) $row['id']); // Startkarten auch für ältere Konten
            }
            respond($row ? ['ok' => true, 'account' => trumpf_account_with_rank($db, $row)] : ['ok' => false, 'code' => 'logged_out', 'message' => 'Bitte melde dich neu an.']);
        }
        if ($action === 'dailyClaim') {
            $row = trumpf_account_by_token(is_string($input['authToken'] ?? null) ? $input['authToken'] : '');
            if (!$row) {
                respond(['ok' => false, 'code' => 'logged_out', 'message' => 'Melde dich an, um dein Tagespack zu öffnen.']);
            }
            respond(trumpf_daily_claim($db, $row));
        }
        if ($action === 'collection') {
            // Nur die eigenen Karten: welche Autos es sonst noch gibt, bleibt geheim.
            $row = trumpf_account_by_token(is_string($input['authToken'] ?? null) ? $input['authToken'] : '');
            if (!$row) {
                respond(['ok' => false, 'code' => 'logged_out', 'message' => 'Melde dich an, um Autos zu sammeln.']);
            }
            $deck = trumpf_load_deck();
            $cards = [];
            foreach (trumpf_owned_cards($db, (int) $row['id']) as $cardId => $qty) {
                $cards[] = $deck[$cardId] + ['qty' => $qty, 'score' => trumpf_card_scores()[$cardId] ?? 0];
            }
            respond(['ok' => true, 'categories' => TRUMPF_CATEGORIES, 'cards' => $cards, 'collected' => count($cards), 'total' => count($deck)]);
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
    trumpf_setup_risk($room);
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
                // Gegen die KI gibt es je nach Stufe weniger XP (Leicht 20 %, Mittel 50 %).
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

            if ($won && !empty($room->data['solo'])) {
                // Belohnung für einen Sieg gegen die KI, je nach Stufe (unabhängig von der Kartenzahl, nur Schwer mit 32 ist größer)
                $per = (int) ($game['cardsPerPlayer'] ?? 0);
                $level = $room->data['aiLevel'] ?? 'medium';
                if ($level === 'hard' && $per >= 32) {
                    [$count, $minTier, $maxTier] = [3, 4, 5];
                } elseif ($level === 'hard') {
                    [$count, $minTier, $maxTier] = [random_int(3, 5), 1, 5];
                } elseif ($level === 'easy') {
                    [$count, $minTier, $maxTier] = [random_int(1, 3), 1, 2];
                } else {
                    [$count, $minTier, $maxTier] = [random_int(1, 3), 1, 4];
                }
                $cards = [];
                trumpf_owned_cards($db, (int) $accountId);
                for ($i = 0; $i < $count; $i++) {
                    $cardId = trumpf_draw_card($minTier, $maxTier);
                    $cards[] = ['id' => $cardId, 'isNew' => trumpf_collection_add($db, (int) $accountId, $cardId)];
                }
                $room->data['game']['cardAwards'][$player['id']] = $cards;
            }

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

// ---------------------------------------------------------------------------------------------
// Deckwertung: Stärke jeder Karte (0–100) aus ihrem Rang in allen Spielkategorien

const AI_DECK_OFFSET = ['easy' => -10, 'medium' => 0, 'hard' => 3]; // KI-Deck im Vergleich zu deinem

/** Stärke je Karte: Durchschnitt, wie viele Karten sie in jeder Kategorie schlägt (0 = schwächste, 100 = stärkste). */
function trumpf_card_scores(): array
{
    static $scores = null;
    if ($scores !== null) {
        return $scores;
    }
    $deck = trumpf_load_deck();
    $total = max(1, count($deck) - 1);
    $sum = array_fill_keys(array_map('strval', array_keys($deck)), 0.0);
    foreach (TRUMPF_CATEGORIES as $key => $rule) {
        $values = [];
        foreach ($deck as $id => $card) {
            $value = (float) $card[$key];
            // kein Wert (z. B. Hubraum beim Elektroauto) zählt als schwächster
            $values[(string) $id] = $value <= 0 ? -INF : ($rule['direction'] === 'low' ? -$value : $value);
        }
        $sorted = array_values($values);
        sort($sorted);
        foreach ($values as $id => $value) {
            // Rang = Anzahl schwächerer Karten (bei Gleichstand Mitte)
            $below = 0;
            $equal = 0;
            foreach ($sorted as $other) {
                if ($other < $value) {
                    $below++;
                } elseif ($other == $value) {
                    $equal++;
                } else {
                    break;
                }
            }
            $sum[$id] += ($below + ($equal - 1) / 2) / $total;
        }
    }
    $scores = [];
    foreach ($sum as $id => $value) {
        $scores[$id] = round(100 * $value / count(TRUMPF_CATEGORIES), 1);
    }
    return $scores;
}

/** Deckwertung = Durchschnitt der Kartenstärken (0–100). */
function trumpf_deck_rating(array $cardIds): int
{
    if (!$cardIds) {
        return 0;
    }
    $scores = trumpf_card_scores();
    $sum = 0.0;
    foreach ($cardIds as $id) {
        $sum += $scores[(string) $id] ?? 0;
    }
    return (int) round($sum / count($cardIds));
}

/** Zufälliges Deck aus allen Autos mit einer Wertung möglichst nah an $target (ohne die Karten aus $exclude). */
function trumpf_balanced_deck(float $target, int $count, array $exclude = []): array
{
    $scores = trumpf_card_scores();
    $pool = array_values(array_diff(array_map('strval', array_keys($scores)), array_map('strval', $exclude)));
    if (count($pool) <= $count) {
        return trumpf_shuffle($pool);
    }
    // Start: Karten aus einem Fenster um den Zielwert, danach tauschen, bis der Schnitt passt
    usort($pool, static function ($a, $b) use ($scores, $target) {
        return abs($scores[$a] - $target) <=> abs($scores[$b] - $target);
    });
    $window = array_slice($pool, 0, max($count * 3, 40));
    $hand = array_slice(trumpf_shuffle($window), 0, $count);
    $rest = array_values(array_diff($pool, $hand));
    $sum = 0.0;
    foreach ($hand as $id) {
        $sum += $scores[$id];
    }
    for ($i = 0; $i < 400 && abs($sum / $count - $target) > 0.5; $i++) {
        $h = random_int(0, $count - 1);
        $r = random_int(0, count($rest) - 1);
        $next = $sum - $scores[$hand[$h]] + $scores[$rest[$r]];
        if (abs($next / $count - $target) < abs($sum / $count - $target)) {
            [$hand[$h], $rest[$r]] = [$rest[$r], $hand[$h]];
            $sum = $next;
        }
    }
    return trumpf_shuffle($hand);
}

/**
 * Gegen die KI mit eigenen Karten: der Spieler bekommt zufällige Karten aus seiner Sammlung
 * (zu wenige werden mit ähnlich starken Leihkarten aufgefüllt), jede KI ein Deck mit passender Wertung.
 * Gibt [playerId => [cardId, …]] zurück oder null (Gast/keine Datenbank → wie bisher zufällig).
 */
function trumpf_solo_hands(TrumpfRoom $room): ?array
{
    $db = trumpf_db();
    $need = (int) $room->data['cardsPerPlayer'];
    $human = null;
    foreach ($room->data['players'] as $player) {
        if (empty($player['bot'])) {
            $human = $player;
        }
    }
    if ($db === null || $human === null || ($human['accountId'] ?? null) === null) {
        return null;
    }
    try {
        $owned = trumpf_owned_cards($db, (int) $human['accountId']);
    } catch (PDOException $error) {
        return null;
    }
    $mine = trumpf_random_from_owned($owned, $need);
    if (count($mine) < $need) {
        $mine = array_merge($mine, trumpf_balanced_deck(trumpf_deck_rating($mine), $need - count($mine), $mine));
    }
    $hands = [$human['id'] => $mine];
    $target = trumpf_deck_rating($mine) + (AI_DECK_OFFSET[$room->data['aiLevel'] ?? 'medium'] ?? 0);
    foreach ($room->data['players'] as $player) {
        if (!empty($player['bot'])) {
            // die KI darf dieselben Autos haben wie du, sonst wäre gegen ein Starterdeck kein schwaches Deck mehr möglich
            $hands[$player['id']] = trumpf_balanced_deck(max(5, min(95, $target)), $need);
        }
    }
    return $hands;
}

/** Sammlungen aller Spieler im Raum für die Modi mit eigenen Karten. Gibt [playerId => [cardId => Anzahl]] oder eine Fehlermeldung zurück. */
function trumpf_room_collections(TrumpfRoom $room)
{
    $db = trumpf_db();
    if ($db === null) {
        return 'Eigene Karten gehen gerade nicht (keine Datenbank).';
    }
    $need = (int) $room->data['cardsPerPlayer'];
    $result = [];
    $guests = [];
    $short = [];
    try {
        foreach ($room->data['players'] as $player) {
            if (($player['accountId'] ?? null) === null) {
                $guests[] = $player['name'];
                continue;
            }
            $owned = trumpf_owned_cards($db, (int) $player['accountId']);
            if (array_sum($owned) < $need) {
                $short[] = $player['name'] . ' (' . array_sum($owned) . ')';
            }
            $result[$player['id']] = $owned;
        }
    } catch (PDOException $error) {
        return 'Datenbankfehler, bitte später nochmal versuchen.';
    }
    if ($guests) {
        return 'Mit eigenen Karten spielen nur angemeldete Spieler. Ohne Konto: ' . implode(', ', $guests) . '.';
    }
    if ($short) {
        return "Für $need Karten pro Spieler haben zu wenige Karten: " . implode(', ', $short) . '.';
    }
    return $result;
}

/** Risiko-Modus nach Spielende: der Gewinner darf sich von jedem Verlierer eine Karte aus dessen Deck aussuchen. */
function trumpf_setup_risk(TrumpfRoom $room): void
{
    $game = $room->data['game'];
    if (($game['deckMode'] ?? '') !== 'risk' || empty($game['decks']) || $game['winnerId'] === null) {
        return;
    }
    $options = [];
    $picks = [];
    foreach ($game['decks'] as $playerId => $cardIds) {
        if ($playerId !== $game['winnerId'] && $cardIds) {
            $options[$playerId] = array_values($cardIds);
            $picks[$playerId] = null;
        }
    }
    if (!$options) {
        return;
    }
    $room->data['risk'] = [
        'winnerId' => $game['winnerId'],
        'deadline' => $room->now + RISK_PICK_MS,
        'options' => $options,
        'picks' => $picks,
        'done' => false,
    ];
    $room->touch();
}

function trumpf_risk_pick(TrumpfRoom $room, string $playerId, string $loserId, string $cardId): ?string
{
    $risk = $room->data['risk'] ?? null;
    if ($risk === null || !empty($risk['done'])) {
        return 'Es gibt gerade nichts auszusuchen.';
    }
    if ($playerId !== $risk['winnerId']) {
        return 'Nur der Gewinner sucht sich eine Karte aus.';
    }
    if (!isset($risk['options'][$loserId]) || !in_array($cardId, $risk['options'][$loserId], true)) {
        return 'Diese Karte steht nicht zur Wahl.';
    }
    $room->data['risk']['picks'][$loserId] = $cardId;
    $room->touch();
    trumpf_settle_risk($room);
    return null;
}

/** Alle gewählt oder Zeit um: fehlende Wahl zufällig, dann wechseln die Karten wirklich den Besitzer. */
function trumpf_settle_risk(TrumpfRoom $room): void
{
    $risk = $room->data['risk'] ?? null;
    if ($risk === null || !empty($risk['done'])) {
        return;
    }
    $open = in_array(null, $risk['picks'], true);
    if ($open && $room->now < $risk['deadline']) {
        return;
    }
    $db = trumpf_db();
    if ($db === null) {
        return;
    }
    $accountOf = [];
    foreach ($room->data['players'] as $player) {
        $accountOf[$player['id']] = $player['accountId'] ?? null;
    }
    $winnerAccount = $accountOf[$risk['winnerId']] ?? null;
    try {
        foreach ($risk['picks'] as $loserId => $cardId) {
            $loserAccount = $accountOf[$loserId] ?? null;
            if ($winnerAccount === null || $loserAccount === null) {
                $risk['picks'][$loserId] = null;
                continue;
            }
            // gewählte Karte zuerst, sonst (oder falls sie inzwischen weg ist) eine zufällige aus dem Deck
            $candidates = array_values(array_unique(array_merge($cardId === null ? [] : [$cardId], trumpf_shuffle($risk['options'][$loserId]))));
            $taken = null;
            foreach ($candidates as $candidate) {
                if (trumpf_collection_remove($db, (int) $loserAccount, (string) $candidate)) {
                    trumpf_collection_add($db, (int) $winnerAccount, (string) $candidate);
                    $taken = (string) $candidate;
                    break;
                }
            }
            $risk['picks'][$loserId] = $taken;
        }
    } catch (PDOException $error) {
        return; // nächster Versuch bei der nächsten Anfrage
    }
    $risk['done'] = true;
    $room->data['risk'] = $risk;
    $room->touch();
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
