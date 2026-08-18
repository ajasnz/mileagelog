<?php
ob_start();
ini_set('display_errors', '0');
error_reporting(E_ALL);

require_once __DIR__ . '/db.php';

// Keep users signed in across app restarts/closes (30-day persistent session cookie)
session_set_cookie_params([
    'lifetime' => 60 * 60 * 24 * 30,
    'path'     => '/',
    'secure'   => !empty($_SERVER['HTTPS']),
    'httponly' => true,
    'samesite' => 'Lax',
]);
ini_set('session.gc_maxlifetime', (string)(60 * 60 * 24 * 30));
session_start();
// Refresh the cookie expiry on every request so it keeps sliding forward
if (!empty($_SESSION['user_id'])) {
    setcookie(session_name(), session_id(), [
        'expires'  => time() + 60 * 60 * 24 * 30,
        'path'     => '/',
        'secure'   => !empty($_SERVER['HTTPS']),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
}
ob_clean();

header('Content-Type: application/json');
header('X-Content-Type-Options: nosniff');

set_exception_handler(function (Throwable $e) {
    error_log('[mileageLog] ' . $e->getMessage() . ' in ' . $e->getFile() . ':' . $e->getLine());
    ob_clean();
    http_response_code(500);
    header('Content-Type: application/json');
    // Don't leak internal exception messages (file paths, SQL, etc.) to the client.
    echo json_encode(['error' => 'Something went wrong. Please try again.']);
    exit;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(mixed $data, int $code = 200): never {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

// Shared sanity checks for the single-trip POST/PUT payload. Kept separate
// from the group/leg endpoint, which derives odometers by chaining and so
// can't produce an inconsistent start/end pair on its own.
function validateTripDistanceAndOdo(array $d, string $status): void {
    if ($status !== 'pending') {
        $distance = isset($d['distance']) ? (float)$d['distance'] : 0;
        if ($distance <= 0) {
            jsonResponse(['error' => 'Distance must be greater than 0'], 422);
        }
    }
    if (isset($d['start_odometer']) && isset($d['end_odometer']) && $d['start_odometer'] !== null && $d['end_odometer'] !== null) {
        if ((float)$d['end_odometer'] < (float)$d['start_odometer']) {
            jsonResponse(['error' => 'End odometer must be greater than or equal to start odometer'], 422);
        }
    }
}

function requireAuth(): int {
    if (empty($_SESSION['user_id'])) jsonResponse(['error' => 'Unauthorized'], 401);
    return (int)$_SESSION['user_id'];
}

function requireAdmin(): int {
    $uid = requireAuth();
    $db  = getDb();
    $row = $db->prepare('SELECT is_admin FROM users WHERE id = ?');
    $row->execute([$uid]);
    $u = $row->fetch();
    if (!$u || !$u['is_admin']) jsonResponse(['error' => 'Admin access required'], 403);
    return $uid;
}

function input(): array {
    return json_decode(file_get_contents('php://input'), true) ?? [];
}

function getSetting(PDO $db, string $key, string $default = ''): string {
    $s = $db->prepare('SELECT value FROM settings WHERE key = ?');
    $s->execute([$key]);
    $r = $s->fetch();
    return $r ? $r['value'] : $default;
}

// ── Router ────────────────────────────────────────────────────────────────────

$method   = $_SERVER['REQUEST_METHOD'];
$path     = trim(parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH), '/');
$path     = preg_replace('#^.*?api\.php/?#', '', $path);
$segments = explode('/', $path);
$resource = $segments[0] ?? '';
$id       = isset($segments[1]) && ctype_digit($segments[1]) ? (int)$segments[1] : null;
$sub      = $segments[2] ?? null;

// ── Auth ──────────────────────────────────────────────────────────────────────

if ($resource === 'auth') {
    $action = $segments[1] ?? '';

    if ($action === 'status' && $method === 'GET') {
        $db = getDb();
        $userCount = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();
        $open = $userCount === 0 || getSetting($db, 'registrations_open', '1') === '1';
        jsonResponse(['registrations_open' => $open]);
    }

    if ($action === 'login' && $method === 'POST') {
        $data = input();
        $db   = getDb();
        $stmt = $db->prepare('SELECT id, password_hash, totp_enabled FROM users WHERE username = ?');
        $stmt->execute([trim($data['username'] ?? '')]);
        $user = $stmt->fetch();
        if ($user && password_verify($data['password'] ?? '', $user['password_hash'])) {
            if (!empty($user['totp_enabled'])) {
                // Password is correct but 2FA isn't satisfied yet — hold the login in a
                // short-lived pending state rather than setting user_id.
                unset($_SESSION['user_id']);
                $_SESSION['totp_pending_uid']     = $user['id'];
                $_SESSION['totp_pending_attempts'] = 0;
                jsonResponse(['totp_required' => true]);
            }
            $_SESSION['user_id'] = $user['id'];
            jsonResponse(['ok' => true]);
        }
        jsonResponse(['error' => 'Invalid username or password'], 401);
    }

    if ($action === 'totp' && ($segments[2] ?? '') === 'verify' && $method === 'POST') {
        $data = input();
        if (empty($_SESSION['totp_pending_uid'])) jsonResponse(['error' => 'No login in progress'], 400);
        if (($_SESSION['totp_pending_attempts'] ?? 0) >= 8) {
            unset($_SESSION['totp_pending_uid'], $_SESSION['totp_pending_attempts']);
            jsonResponse(['error' => 'Too many attempts. Please log in again.'], 429);
        }
        $db   = getDb();
        $stmt = $db->prepare('SELECT id, totp_secret, totp_backup_codes FROM users WHERE id = ?');
        $stmt->execute([$_SESSION['totp_pending_uid']]);
        $user = $stmt->fetch();
        if (!$user) jsonResponse(['error' => 'No login in progress'], 400);

        $code = trim((string)($data['code'] ?? ''));
        $ok   = $user['totp_secret'] && totpVerify($user['totp_secret'], $code);

        // Fall back to a single-use backup code if the TOTP code didn't match.
        if (!$ok && $user['totp_backup_codes']) {
            $codes = json_decode($user['totp_backup_codes'], true) ?: [];
            foreach ($codes as $i => $hash) {
                if (password_verify(strtolower(str_replace('-', '', $code)), $hash)) {
                    unset($codes[$i]);
                    $db->prepare('UPDATE users SET totp_backup_codes = ? WHERE id = ?')
                       ->execute([json_encode(array_values($codes)), $user['id']]);
                    $ok = true;
                    break;
                }
            }
        }

        if (!$ok) {
            $_SESSION['totp_pending_attempts'] = ($_SESSION['totp_pending_attempts'] ?? 0) + 1;
            jsonResponse(['error' => 'Invalid code'], 401);
        }
        $_SESSION['user_id'] = $user['id'];
        unset($_SESSION['totp_pending_uid'], $_SESSION['totp_pending_attempts']);
        jsonResponse(['ok' => true]);
    }

    // ── TOTP enrollment (must already be logged in) ──────────────────────────
    if ($action === 'totp' && ($segments[2] ?? '') === 'setup' && $method === 'POST') {
        $uid  = requireAuth();
        $db   = getDb();
        $stmt = $db->prepare('SELECT username FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $username = $stmt->fetchColumn();

        // Store as a pending (not-yet-enabled) secret until confirmed with a valid code.
        $secret = totpGenerateSecret();
        $db->prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?')
           ->execute([$secret, $uid]);

        jsonResponse(['secret' => $secret, 'otpauth_url' => totpOtpAuthUrl($secret, $username)]);
    }

    if ($action === 'totp' && ($segments[2] ?? '') === 'confirm' && $method === 'POST') {
        $uid  = requireAuth();
        $data = input();
        $db   = getDb();
        $stmt = $db->prepare('SELECT totp_secret FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $secret = $stmt->fetchColumn();
        if (!$secret) jsonResponse(['error' => 'Run setup first'], 400);
        if (!totpVerify($secret, trim((string)($data['code'] ?? '')))) {
            jsonResponse(['error' => 'Invalid code'], 401);
        }

        $backupCodes = totpGenerateBackupCodes();
        $hashed      = array_map(fn($c) => password_hash($c, PASSWORD_DEFAULT), $backupCodes);
        $db->prepare('UPDATE users SET totp_enabled = 1, totp_backup_codes = ? WHERE id = ?')
           ->execute([json_encode($hashed), $uid]);

        // Backup codes are shown to the user exactly once, here.
        jsonResponse(['ok' => true, 'backup_codes' => $backupCodes]);
    }

    if ($action === 'totp' && ($segments[2] ?? '') === 'disable' && $method === 'POST') {
        $uid  = requireAuth();
        $data = input();
        $db   = getDb();
        $stmt = $db->prepare('SELECT password_hash FROM users WHERE id = ?');
        $stmt->execute([$uid]);
        $hash = $stmt->fetchColumn();
        if (!$hash || !password_verify($data['password'] ?? '', $hash)) {
            jsonResponse(['error' => 'Incorrect password'], 401);
        }
        $db->prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0, totp_backup_codes = NULL WHERE id = ?')
           ->execute([$uid]);
        jsonResponse(['ok' => true]);
    }

    if ($action === 'register' && $method === 'POST') {
        $db   = getDb();

        // Check if registrations are open (skip check for very first user)
        $userCount = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();
        if ($userCount > 0 && getSetting($db, 'registrations_open', '1') !== '1') {
            jsonResponse(['error' => 'Registrations are currently closed'], 403);
        }

        $data     = input();
        $username = trim($data['username'] ?? '');
        $password = $data['password'] ?? '';
        if (strlen($username) < 2 || strlen($password) < 6) {
            jsonResponse(['error' => 'Username ≥ 2 chars and password ≥ 6 chars required'], 422);
        }
        $chk = $db->prepare('SELECT id FROM users WHERE username = ?');
        $chk->execute([$username]);
        if ($chk->fetch()) jsonResponse(['error' => 'Username already taken'], 409);

        $hash    = password_hash($password, PASSWORD_DEFAULT);
        $isAdmin = $userCount === 0 ? 1 : 0; // first user is admin
        $ins     = $db->prepare('INSERT INTO users (username, email, password_hash, is_admin) VALUES (?,?,?,?)');
        $ins->execute([$username, trim($data['email'] ?? ''), $hash, $isAdmin]);
        $_SESSION['user_id'] = (int)$db->lastInsertId();
        jsonResponse(['ok' => true, 'is_admin' => (bool)$isAdmin]);
    }

    if ($action === 'logout' && $method === 'POST') {
        session_destroy();
        jsonResponse(['ok' => true]);
    }

    if ($action === 'me' && $method === 'GET') {
        if (empty($_SESSION['user_id'])) jsonResponse(['user' => null]);
        $db   = getDb();
        $stmt = $db->prepare('SELECT id, username, email, is_admin, totp_enabled FROM users WHERE id = ?');
        $stmt->execute([$_SESSION['user_id']]);
        $user = $stmt->fetch();
        if ($user) { $user['is_admin'] = (bool)$user['is_admin']; $user['totp_enabled'] = (bool)$user['totp_enabled']; }
        jsonResponse(['user' => $user ?: null]);
    }

    jsonResponse(['error' => 'Not found'], 404);
}

// ── Settings (admin only) ─────────────────────────────────────────────────────

if ($resource === 'settings') {
    $uid = requireAdmin();
    $db  = getDb();

    if ($method === 'GET') {
        $rows = $db->query('SELECT key, value FROM settings')->fetchAll();
        $out  = [];
        foreach ($rows as $r) $out[$r['key']] = $r['value'];
        jsonResponse($out);
    }

    if ($method === 'PUT') {
        $data = input();
        $stmt = $db->prepare("INSERT INTO settings (key, value, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
        foreach ($data as $k => $v) {
            $stmt->execute([preg_replace('/[^a-z_]/', '', $k), (string)$v]);
        }
        jsonResponse(['ok' => true]);
    }

    jsonResponse(['error' => 'Not found'], 404);
}

// ── User settings (per-user, e.g. Invoice Ninja credentials) ─────────────────

if ($resource === 'user_settings') {
    $uid = requireAuth();
    $db  = getDb();

    if ($method === 'GET') {
        $rows = $db->prepare('SELECT key, value FROM user_settings WHERE user_id = ?');
        $rows->execute([$uid]);
        $out = [];
        foreach ($rows->fetchAll() as $r) {
            // Never expose the raw token — mask it
            $out[$r['key']] = $r['key'] === 'in_token' && $r['value']
                ? str_repeat('•', max(0, strlen($r['value']) - 4)) . substr($r['value'], -4)
                : $r['value'];
        }
        jsonResponse($out);
    }

    if ($method === 'PUT') {
        $data = input();
        $allowed = ['in_url', 'in_token', 'in_currency_id'];
        $stmt = $db->prepare('INSERT INTO user_settings (user_id, key, value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value');
        foreach ($allowed as $k) {
            if (array_key_exists($k, $data)) {
                // Don't overwrite token if the submitted value is the masked placeholder
                if ($k === 'in_token' && str_contains((string)$data[$k], '•')) continue;
                $stmt->execute([$uid, $k, $data[$k] === '' ? null : (string)$data[$k]]);
            }
        }
        jsonResponse(['ok' => true]);
    }

    jsonResponse(['error' => 'Not found'], 404);
}

// ── Invoice Ninja proxy ───────────────────────────────────────────────────────

if ($resource === 'invoiceninja') {
    $uid    = requireAuth();
    $db     = getDb();
    $action = $segments[1] ?? '';

    // Load this user's IN credentials
    $rows = $db->prepare('SELECT key, value FROM user_settings WHERE user_id = ? AND key IN (\'in_url\',\'in_token\',\'in_currency_id\')');
    $rows->execute([$uid]);
    $cfg = [];
    foreach ($rows->fetchAll() as $r) $cfg[$r['key']] = $r['value'];

    if (empty($cfg['in_url']) || empty($cfg['in_token'])) {
        jsonResponse(['error' => 'Invoice Ninja not configured. Add your URL and API token in profile settings.'], 422);
    }

    $inBase  = rtrim($cfg['in_url'], '/');
    $inToken = $cfg['in_token'];

    function inRequest(string $method, string $inBase, string $inToken, string $endpoint, ?array $body = null): array {
        $url  = $inBase . '/api/v1/' . ltrim($endpoint, '/');
        $opts = [
            CURLOPT_URL            => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 15,
            CURLOPT_HTTPHEADER     => [
                'X-API-TOKEN: ' . $inToken,
                'X-Requested-With: XMLHttpRequest',
                'Content-Type: application/json',
                'Accept: application/json',
            ],
            CURLOPT_SSL_VERIFYPEER => true,
        ];
        if ($method === 'POST') {
            $opts[CURLOPT_POST]       = true;
            $opts[CURLOPT_POSTFIELDS] = json_encode($body);
        }
        $ch  = curl_init();
        curl_setopt_array($ch, $opts);
        $res  = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $err  = curl_error($ch);
        curl_close($ch);
        if ($err) throw new RuntimeException("Invoice Ninja connection error: {$err}");
        $json = json_decode($res, true);
        if ($json === null) throw new RuntimeException("Invoice Ninja returned non-JSON response (HTTP {$code})");
        if ($code >= 400) throw new RuntimeException($json['message'] ?? "Invoice Ninja error (HTTP {$code})");
        return $json;
    }

    // GET /invoiceninja/clients — fetch client list for matching
    if ($action === 'clients' && $method === 'GET') {
        $search = $_GET['search'] ?? '';
        $ep     = 'clients?per_page=50&status=active' . ($search ? '&filter=' . urlencode($search) : '');
        try {
            $resp = inRequest('GET', $inBase, $inToken, $ep);
            $clients = array_map(fn($c) => [
                'id'   => $c['id'],
                'name' => $c['name'],
            ], $resp['data'] ?? []);
            jsonResponse($clients);
        } catch (RuntimeException $e) {
            jsonResponse(['error' => $e->getMessage()], 502);
        }
    }

    // POST /invoiceninja/expense — create an expense from a trip
    if ($action === 'expense' && $method === 'POST') {
        $d      = input();
        $tripId = (int)($d['trip_id'] ?? 0);

        // Load the trip + vehicle fuel type + IRD rate
        $tripStmt = $db->prepare('SELECT t.*, v.fuel_type FROM trips t JOIN vehicles v ON t.vehicle_id=v.id WHERE t.id=? AND t.user_id=?');
        $tripStmt->execute([$tripId, $uid]);
        $trip = $tripStmt->fetch();
        if (!$trip) jsonResponse(['error' => 'Trip not found'], 404);

        // Calculate amount using IRD rate
        $taxYear = nzTaxYear($trip['date']);
        $ft      = $trip['fuel_type'];
        $rateRow = $db->prepare('SELECT rate_standard FROM ird_rates WHERE tax_year=? AND fuel_type=?');
        $rateRow->execute([$taxYear, $ft]);
        $rate    = $rateRow->fetchColumn();

        // Amount: use caller-supplied override, or calculated, or raw distance
        $amount = isset($d['amount']) && $d['amount'] > 0
            ? (float)$d['amount']
            : ($rate ? round((float)$trip['distance'] * (float)$rate, 2) : (float)$trip['distance']);

        $notes = isset($d['notes']) && $d['notes'] !== ''
            ? $d['notes']
            : trim(implode("\n", array_filter([
                $trip['purpose'],
                $trip['start_location'] && $trip['end_location'] ? $trip['start_location'] . ' → ' . $trip['end_location'] : ($trip['start_location'] ?? $trip['end_location'] ?? ''),
                number_format((float)$trip['distance'], 1) . ' km' . ($rate ? ' × $' . number_format((float)$rate, 2) . '/km' : ''),
                $trip['notes'] ?? '',
            ])));

        $expense = [
            'amount'       => $amount,
            'date'         => $trip['date'],
            'notes'        => $notes,
            'public_notes' => $trip['purpose'],
        ];
        if (!empty($d['client_id']))   $expense['client_id']   = $d['client_id'];
        if (!empty($d['category_id'])) $expense['category_id'] = $d['category_id'];
        if (!empty($cfg['in_currency_id'])) $expense['currency_id'] = (int)$cfg['in_currency_id'];

        // Mark trip as sent to IN
        $expense['custom_value1'] = 'MileageLog trip #' . $tripId;

        try {
            $resp = inRequest('POST', $inBase, $inToken, 'expenses', $expense);
            // Save the IN expense ID on the trip
            $db->prepare("UPDATE trips SET notes = CASE WHEN notes IS NULL THEN ? ELSE notes || '\n' || ? END WHERE id=?")
               ->execute(["[IN expense #{$resp['data']['id']}]", "[IN expense #{$resp['data']['id']}]", $tripId]);
            jsonResponse(['ok' => true, 'expense_id' => $resp['data']['id'] ?? null]);
        } catch (RuntimeException $e) {
            jsonResponse(['error' => $e->getMessage()], 502);
        }
    }

    jsonResponse(['error' => 'Not found'], 404);
}

// ── Trip client autocomplete ──────────────────────────────────────────────────

if ($resource === 'trips' && isset($segments[1]) && $segments[1] === 'clients' && $method === 'GET') {
    $uid  = requireAuth();
    $db   = getDb();
    $stmt = $db->prepare("SELECT DISTINCT client_name FROM trips WHERE user_id=? AND client_name IS NOT NULL AND client_name != '' ORDER BY client_name");
    $stmt->execute([$uid]);
    jsonResponse($stmt->fetchAll(PDO::FETCH_COLUMN));
}

if ($resource === 'trips' && isset($segments[1]) && $segments[1] === 'purposes' && $method === 'GET') {
    $uid  = requireAuth();
    $db   = getDb();
    $stmt = $db->prepare("SELECT DISTINCT purpose FROM trips WHERE user_id=? AND purpose IS NOT NULL AND purpose != '' ORDER BY purpose");
    $stmt->execute([$uid]);
    jsonResponse($stmt->fetchAll(PDO::FETCH_COLUMN));
}

// ── IRD Rates (read: any auth; write: admin only) ─────────────────────────────

if ($resource === 'ird_rates') {
    $db = getDb();

    if ($method === 'GET') {
        requireAuth();
        $rows = $db->query('SELECT * FROM ird_rates ORDER BY tax_year DESC, fuel_type')->fetchAll();
        jsonResponse($rows);
    }

    if ($method === 'POST') {
        requireAdmin();
        $d = input();
        if (!$d['tax_year'] || !$d['fuel_type'] || !isset($d['rate_standard']) || !isset($d['rate_over14k'])) {
            jsonResponse(['error' => 'tax_year, fuel_type, rate_standard and rate_over14k required'], 422);
        }
        $stmt = $db->prepare('INSERT INTO ird_rates (tax_year, fuel_type, rate_standard, rate_over14k, notes) VALUES (?,?,?,?,?)');
        $stmt->execute([(int)$d['tax_year'], $d['fuel_type'], (float)$d['rate_standard'], (float)$d['rate_over14k'], $d['notes'] ?? null]);
        jsonResponse(['id' => (int)$db->lastInsertId(), 'ok' => true], 201);
    }

    if ($id !== null && $method === 'PUT') {
        requireAdmin();
        $d = input();
        $db->prepare('UPDATE ird_rates SET tax_year=?, fuel_type=?, rate_standard=?, rate_over14k=?, notes=? WHERE id=?')
           ->execute([(int)$d['tax_year'], $d['fuel_type'], (float)$d['rate_standard'], (float)$d['rate_over14k'], $d['notes'] ?? null, $id]);
        jsonResponse(['ok' => true]);
    }

    if ($id !== null && $method === 'DELETE') {
        requireAdmin();
        $db->prepare('DELETE FROM ird_rates WHERE id = ?')->execute([$id]);
        jsonResponse(['ok' => true]);
    }

    jsonResponse(['error' => 'Not found'], 404);
}

// ── Vehicles ──────────────────────────────────────────────────────────────────

if ($resource === 'vehicles') {
    $uid = requireAuth();
    $db  = getDb();

    if ($method === 'GET') {
        $stmt = $db->prepare('SELECT * FROM vehicles WHERE user_id = ? AND is_active = 1 ORDER BY name');
        $stmt->execute([$uid]);
        jsonResponse($stmt->fetchAll());
    }

    if ($method === 'POST') {
        $d = input();
        if (empty($d['name'])) jsonResponse(['error' => 'Name required'], 422);
        $ft = in_array($d['fuel_type'] ?? '', ['petrol','diesel','hybrid','ev']) ? $d['fuel_type'] : 'petrol';
        $stmt = $db->prepare('INSERT INTO vehicles (user_id, name, registration, make, model, year, fuel_type) VALUES (?,?,?,?,?,?,?)');
        $stmt->execute([$uid, $d['name'], $d['registration'] ?? null, $d['make'] ?? null, $d['model'] ?? null, $d['year'] ?? null, $ft]);
        $newId = (int)$db->lastInsertId();
        $stmt2 = $db->prepare('SELECT * FROM vehicles WHERE id = ?');
        $stmt2->execute([$newId]);
        jsonResponse($stmt2->fetch(), 201);
    }

    if ($id !== null && $method === 'PUT') {
        $d  = input();
        $ft = in_array($d['fuel_type'] ?? '', ['petrol','diesel','hybrid','ev']) ? $d['fuel_type'] : 'petrol';
        $db->prepare('UPDATE vehicles SET name=?, registration=?, make=?, model=?, year=?, fuel_type=? WHERE id=? AND user_id=?')
           ->execute([$d['name'] ?? '', $d['registration'] ?? null, $d['make'] ?? null, $d['model'] ?? null, $d['year'] ?? null, $ft, $id, $uid]);
        jsonResponse(['ok' => true]);
    }

    if ($id !== null && $method === 'DELETE') {
        $db->prepare('UPDATE vehicles SET is_active=0 WHERE id=? AND user_id=?')->execute([$id, $uid]);
        jsonResponse(['ok' => true]);
    }

    jsonResponse(['error' => 'Not found'], 404);
}

// ── Trips ─────────────────────────────────────────────────────────────────────

if ($resource === 'trips') {
    $uid = requireAuth();
    $db  = getDb();

    // Multi-leg / return trip: create a chain of trip rows sharing one trip_group_id.
    // Each leg's start_location/start_odometer is chained from the previous leg's end.
    if (isset($segments[1]) && $segments[1] === 'group' && $method === 'POST') {
        $d    = input();
        $legs = $d['legs'] ?? [];
        if (empty($d['vehicle_id']) || empty($d['date']) || !is_array($legs) || count($legs) < 1) {
            jsonResponse(['error' => 'vehicle_id, date, and at least one leg are required'], 422);
        }
        $tripType = in_array($d['trip_type'] ?? 'business', ['business','private']) ? $d['trip_type'] : 'business';
        if ($tripType === 'business' && empty($d['purpose'])) {
            jsonResponse(['error' => 'Purpose is required for business trips'], 422);
        }
        $chk = $db->prepare('SELECT id FROM vehicles WHERE id=? AND user_id=?');
        $chk->execute([(int)$d['vehicle_id'], $uid]);
        if (!$chk->fetch()) jsonResponse(['error' => 'Vehicle not found'], 404);

        foreach ($legs as $leg) {
            if (empty($leg['distance']) || (float)$leg['distance'] <= 0) {
                jsonResponse(['error' => 'Each leg needs a distance greater than 0'], 422);
            }
        }

        $groupId = bin2hex(random_bytes(6));
        $stmt = $db->prepare('INSERT INTO trips (vehicle_id, user_id, date, start_odometer, end_odometer, distance, purpose, trip_type, client_name, billable, start_location, end_location, notes, status, trip_group_id, leg_order, is_return_leg) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');

        $prevLocation = $d['start_location'] ?? null;
        $prevOdo      = isset($d['start_odometer']) ? (float)$d['start_odometer'] : null;
        $created      = [];

        $db->beginTransaction();
        try {
            foreach ($legs as $i => $leg) {
                $distance = (float)$leg['distance'];
                $endLoc   = $leg['end_location'] ?? null;
                $endOdo   = $prevOdo !== null ? $prevOdo + $distance : null;

                $stmt->execute([
                    (int)$d['vehicle_id'], $uid,
                    $d['date'],
                    $prevOdo, $endOdo, $distance,
                    $d['purpose'] ?? '',
                    $tripType,
                    $d['client_name'] ?? null,
                    !empty($d['billable']) ? 1 : 0,
                    $prevLocation, $endLoc,
                    $d['notes'] ?? null,
                    'completed',
                    $groupId, $i + 1,
                    !empty($leg['is_return']) ? 1 : 0,
                ]);
                $created[] = (int)$db->lastInsertId();
                $prevLocation = $endLoc;
                $prevOdo      = $endOdo;
            }
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            throw $e;
        }

        $placeholders = implode(',', array_fill(0, count($created), '?'));
        $out = $db->prepare("SELECT t.*, v.name AS vehicle_name, v.fuel_type FROM trips t JOIN vehicles v ON t.vehicle_id=v.id WHERE t.id IN ({$placeholders}) ORDER BY t.leg_order");
        $out->execute($created);
        jsonResponse($out->fetchAll(), 201);
    }

    if ($method === 'GET' && $id === null) {
        $where  = ['t.user_id = ?'];
        $params = [$uid];
        if (!empty($_GET['vehicle_id'])) { $where[] = 't.vehicle_id = ?'; $params[] = (int)$_GET['vehicle_id']; }
        if (!empty($_GET['from']))       { $where[] = 't.date >= ?';      $params[] = $_GET['from']; }
        if (!empty($_GET['to']))         { $where[] = 't.date <= ?';      $params[] = $_GET['to']; }
        if (!empty($_GET['trip_type']))  { $where[] = 't.trip_type = ?';  $params[] = $_GET['trip_type']; }
        if (!empty($_GET['billable']))   { $where[] = 't.billable = 1'; }

        $limit    = min((int)($_GET['limit'] ?? 100), 500);
        $offset   = (int)($_GET['offset'] ?? 0);
        $wSql     = implode(' AND ', $where);
        $sql      = "SELECT t.*, v.name AS vehicle_name, v.registration, v.fuel_type FROM trips t JOIN vehicles v ON t.vehicle_id=v.id WHERE {$wSql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?";
        $params[] = $limit;
        $params[] = $offset;
        $stmt     = $db->prepare($sql);
        $stmt->execute($params);
        jsonResponse($stmt->fetchAll());
    }

    if ($method === 'GET' && $id !== null) {
        $stmt = $db->prepare('SELECT t.*, v.name AS vehicle_name, v.fuel_type FROM trips t JOIN vehicles v ON t.vehicle_id=v.id WHERE t.id=? AND t.user_id=?');
        $stmt->execute([$id, $uid]);
        $row = $stmt->fetch();
        if (!$row) jsonResponse(['error' => 'Not found'], 404);
        jsonResponse($row);
    }

    if ($method === 'POST') {
        $d      = input();
        $status = in_array($d['status'] ?? 'completed', ['pending','completed']) ? $d['status'] : 'completed';
        if (empty($d['vehicle_id']) || empty($d['date']) || (!isset($d['distance']) && $status !== 'pending')) {
            jsonResponse(['error' => 'vehicle_id, date, and distance are required'], 422);
        }
        // purpose required for business trips
        $tripType = in_array($d['trip_type'] ?? 'business', ['business','private']) ? $d['trip_type'] : 'business';
        if ($tripType === 'business' && $status === 'completed' && empty($d['purpose'])) {
            jsonResponse(['error' => 'Purpose is required for business trips'], 422);
        }
        validateTripDistanceAndOdo($d, $status);
        $chk = $db->prepare('SELECT id FROM vehicles WHERE id=? AND user_id=?');
        $chk->execute([(int)$d['vehicle_id'], $uid]);
        if (!$chk->fetch()) jsonResponse(['error' => 'Vehicle not found'], 404);

        $stmt = $db->prepare('INSERT INTO trips (vehicle_id, user_id, date, start_odometer, end_odometer, distance, purpose, trip_type, client_name, billable, start_location, end_location, notes, gps_track, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        $stmt->execute([
            (int)$d['vehicle_id'], $uid,
            $d['date'],
            isset($d['start_odometer']) ? (float)$d['start_odometer'] : null,
            isset($d['end_odometer'])   ? (float)$d['end_odometer']   : null,
            isset($d['distance']) ? (float)$d['distance'] : 0,
            $d['purpose'] ?? '',
            $tripType,
            $d['client_name']     ?? null,
            !empty($d['billable']) ? 1 : 0,
            $d['start_location']  ?? null,
            $d['end_location']    ?? null,
            $d['notes']           ?? null,
            isset($d['gps_track']) ? json_encode($d['gps_track']) : null,
            $status,
        ]);
        $newId = (int)$db->lastInsertId();
        $stmt2 = $db->prepare('SELECT t.*, v.name AS vehicle_name, v.fuel_type FROM trips t JOIN vehicles v ON t.vehicle_id=v.id WHERE t.id=?');
        $stmt2->execute([$newId]);
        jsonResponse($stmt2->fetch(), 201);
    }

    if ($id !== null && $method === 'PUT') {
        $d        = input();
        $chk      = $db->prepare('SELECT id FROM trips WHERE id=? AND user_id=?');
        $chk->execute([$id, $uid]);
        if (!$chk->fetch()) jsonResponse(['error' => 'Not found'], 404);
        $tripType = in_array($d['trip_type'] ?? 'business', ['business','private']) ? $d['trip_type'] : 'business';
        $status   = in_array($d['status'] ?? 'completed', ['pending','completed']) ? $d['status'] : 'completed';
        validateTripDistanceAndOdo($d, $status);
        $db->prepare("UPDATE trips SET date=?, start_odometer=?, end_odometer=?, distance=?, purpose=?, trip_type=?, client_name=?, billable=?, start_location=?, end_location=?, notes=?, status=?, updated_at=datetime('now') WHERE id=? AND user_id=?")
           ->execute([
               $d['date'],
               isset($d['start_odometer']) ? (float)$d['start_odometer'] : null,
               isset($d['end_odometer'])   ? (float)$d['end_odometer']   : null,
               isset($d['distance']) ? (float)$d['distance'] : 0,
               $d['purpose'] ?? '',
               $tripType,
               $d['client_name']    ?? null,
               !empty($d['billable']) ? 1 : 0,
               $d['start_location'] ?? null,
               $d['end_location']   ?? null,
               $d['notes']          ?? null,
               $status,
               $id, $uid,
           ]);
        jsonResponse(['ok' => true]);
    }

    if ($id !== null && $method === 'DELETE') {
        $db->prepare('DELETE FROM trips WHERE id=? AND user_id=?')->execute([$id, $uid]);
        jsonResponse(['ok' => true]);
    }

    jsonResponse(['error' => 'Not found'], 404);
}

// ── Reports ───────────────────────────────────────────────────────────────────

if ($resource === 'reports') {
    $uid = requireAuth();
    $db  = getDb();

    if ($segments[1] === 'summary' && $method === 'GET') {
        $from = $_GET['from'] ?? date('Y-01-01');
        $to   = $_GET['to']   ?? date('Y-m-d');

        $where  = ['t.user_id = ?', 't.date >= ?', 't.date <= ?'];
        $params = [$uid, $from, $to];
        if (!empty($_GET['vehicle_id'])) { $where[] = 't.vehicle_id = ?'; $params[] = (int)$_GET['vehicle_id']; }

        $wSql = implode(' AND ', $where);

        $totals = $db->prepare("
            SELECT COUNT(*) AS trip_count,
                   COALESCE(SUM(distance),0) AS total_km,
                   COALESCE(SUM(CASE WHEN trip_type='business' THEN distance ELSE 0 END),0) AS business_km,
                   COALESCE(SUM(CASE WHEN trip_type='private'  THEN distance ELSE 0 END),0) AS private_km,
                   COALESCE(SUM(CASE WHEN billable=1 THEN distance ELSE 0 END),0) AS billable_km
            FROM trips t WHERE {$wSql}
        ");
        $totals->execute($params);
        $summary = $totals->fetch();
        $summary['business_pct'] = $summary['total_km'] > 0
            ? round($summary['business_km'] / $summary['total_km'] * 100, 1) : 0;
        $summary['from'] = $from;
        $summary['to']   = $to;

        // Monthly breakdown
        $monthly = $db->prepare("
            SELECT strftime('%Y-%m', date) AS month,
                   COUNT(*) AS trips,
                   SUM(distance) AS total_km,
                   SUM(CASE WHEN trip_type='business' THEN distance ELSE 0 END) AS business_km
            FROM trips t WHERE {$wSql} GROUP BY month ORDER BY month
        ");
        $monthly->execute($params);
        $summary['monthly'] = $monthly->fetchAll();

        // ── IRD deduction calculation ────────────────────────────────────────
        // Load all IRD rates
        $rates = [];
        foreach ($db->query('SELECT * FROM ird_rates')->fetchAll() as $r) {
            $rates[$r['tax_year']][$r['fuel_type']] = $r;
        }

        // Get ALL business trips in period with vehicle fuel type
        $tripRows = $db->prepare("
            SELECT t.date, t.distance, t.trip_type, t.vehicle_id, v.fuel_type
            FROM trips t JOIN vehicles v ON t.vehicle_id = v.id
            WHERE {$wSql} ORDER BY t.vehicle_id, t.date
        ");
        $tripRows->execute($params);

        // Accumulate per vehicle × tax year
        $vtData = []; // [vid][taxYear] => {fuel_type, period_total, period_business}
        foreach ($tripRows->fetchAll() as $row) {
            $ty  = nzTaxYear($row['date']);
            $vid = $row['vehicle_id'];
            if (!isset($vtData[$vid][$ty])) {
                $vtData[$vid][$ty] = ['fuel_type' => $row['fuel_type'], 'period_total' => 0, 'period_business' => 0];
            }
            $vtData[$vid][$ty]['period_total'] += $row['distance'];
            if ($row['trip_type'] === 'business') {
                $vtData[$vid][$ty]['period_business'] += $row['distance'];
            }
        }

        $deductions = [];
        foreach ($vtData as $vid => $taxYears) {
            foreach ($taxYears as $ty => $data) {
                // Fetch FULL tax-year km for accurate tier determination
                // Prefer odometer spread (captures unlogged personal trips) over sum of logged trips
                $yearFrom = ($ty - 1) . '-04-01';
                $yearTo   = $ty . '-03-31';
                $odo = $db->prepare("SELECT MIN(start_odometer) AS first_odo, MAX(end_odometer) AS last_odo FROM trips WHERE vehicle_id=? AND user_id=? AND date>=? AND date<=? AND (start_odometer IS NOT NULL OR end_odometer IS NOT NULL)");
                $odo->execute([$vid, $uid, $yearFrom, $yearTo]);
                $odoRow = $odo->fetch();
                $firstOdo = $odoRow['first_odo'] !== null ? (float)$odoRow['first_odo'] : null;
                $lastOdo  = $odoRow['last_odo']  !== null ? (float)$odoRow['last_odo']  : null;
                $odoYearKm = ($firstOdo !== null && $lastOdo !== null && $lastOdo > $firstOdo) ? ($lastOdo - $firstOdo) : null;

                $ys = $db->prepare("SELECT COALESCE(SUM(distance),0) AS total_km FROM trips WHERE vehicle_id=? AND user_id=? AND date>=? AND date<=?");
                $ys->execute([$vid, $uid, $yearFrom, $yearTo]);
                $yearTotalKm = $odoYearKm ?? (float)$ys->fetchColumn();

                $ft   = $data['fuel_type'];
                $rate = $rates[$ty][$ft] ?? null;
                if (!$rate) continue;

                $periodBusiness = $data['period_business'];
                if ($periodBusiness <= 0) continue;

                // Prorate: what fraction of the full-year business km is in this period?
                $ysb = $db->prepare("SELECT COALESCE(SUM(distance),0) FROM trips WHERE vehicle_id=? AND user_id=? AND date>=? AND date<=? AND trip_type='business'");
                $ysb->execute([$vid, $uid, $yearFrom, $yearTo]);
                $yearBusinessKm = (float)$ysb->fetchColumn();

                // Calculate full-year deduction, then take period fraction
                if ($yearTotalKm <= 14000) {
                    $yearDeduction = $yearBusinessKm * $rate['rate_standard'];
                } else {
                    $bFrac         = $yearTotalKm > 0 ? $yearBusinessKm / $yearTotalKm : 0;
                    $tier1Business = 14000 * $bFrac;
                    $tier2Business = $yearBusinessKm - $tier1Business;
                    $yearDeduction = ($tier1Business * $rate['rate_standard']) + ($tier2Business * $rate['rate_over14k']);
                }

                $periodFrac      = $yearBusinessKm > 0 ? $periodBusiness / $yearBusinessKm : 0;
                $periodDeduction = $yearDeduction * $periodFrac;

                $deductions[] = [
                    'vehicle_id'        => $vid,
                    'tax_year'          => $ty,
                    'fuel_type'         => $ft,
                    'rate_standard'     => $rate['rate_standard'],
                    'rate_over14k'      => $rate['rate_over14k'],
                    'year_total_km'     => round($yearTotalKm, 1),
                    'year_total_from_odo' => $odoYearKm !== null,
                    'year_business_km'  => round($yearBusinessKm, 1),
                    'period_business_km'=> round($periodBusiness, 1),
                    'deduction'         => round($periodDeduction, 2),
                    'tier'              => $yearTotalKm > 14000 ? 'mixed' : 'standard',
                ];
            }
        }

        $summary['deductions']       = $deductions;
        $summary['total_deduction']  = round(array_sum(array_column($deductions, 'deduction')), 2);

        // ── Odometer-derived totals for inferred private km ──────────────────
        // Personal trips are optional; derive total vehicle use from odo spread
        $odoStmt = $db->prepare("
            SELECT t.vehicle_id, v.name AS vehicle_name,
                   MIN(t.start_odometer) AS first_odo,
                   MAX(t.end_odometer)   AS last_odo
            FROM trips t JOIN vehicles v ON t.vehicle_id = v.id
            WHERE {$wSql}
              AND (t.start_odometer IS NOT NULL OR t.end_odometer IS NOT NULL)
            GROUP BY t.vehicle_id
        ");
        $odoStmt->execute($params);
        $odoTotalKm  = 0.0;
        $odoVehicles = [];
        foreach ($odoStmt->fetchAll() as $row) {
            $firstOdo = $row['first_odo'] !== null ? (float)$row['first_odo'] : null;
            $lastOdo  = $row['last_odo']  !== null ? (float)$row['last_odo']  : null;
            $odoKm    = ($firstOdo !== null && $lastOdo !== null && $lastOdo > $firstOdo)
                        ? round($lastOdo - $firstOdo, 1) : null;
            $odoVehicles[] = [
                'vehicle_id'   => (int)$row['vehicle_id'],
                'vehicle_name' => $row['vehicle_name'],
                'first_odo'    => $firstOdo,
                'last_odo'     => $lastOdo,
                'odo_km'       => $odoKm,
            ];
            if ($odoKm !== null) $odoTotalKm += $odoKm;
        }
        $hasOdoData = $odoTotalKm > 0;
        $summary['has_odo_data']   = $hasOdoData;
        $summary['odo_total_km']   = $hasOdoData ? round($odoTotalKm, 1) : null;
        $summary['odo_private_km'] = $hasOdoData
            ? max(0.0, round($odoTotalKm - (float)$summary['business_km'], 1)) : null;
        $summary['odo_vehicles']   = $odoVehicles;

        jsonResponse($summary);
    }

    if ($segments[1] === 'export' && $method === 'GET') {
        $from = $_GET['from'] ?? date('Y-01-01');
        $to   = $_GET['to']   ?? date('Y-m-d');

        $where  = ['t.user_id = ?', 't.date >= ?', 't.date <= ?'];
        $params = [$uid, $from, $to];
        if (!empty($_GET['vehicle_id'])) { $where[] = 't.vehicle_id = ?'; $params[] = (int)$_GET['vehicle_id']; }

        $stmt = $db->prepare("
            SELECT t.date, v.name AS vehicle, v.registration, v.fuel_type,
                   t.start_odometer, t.end_odometer, t.distance,
                   t.trip_type, t.purpose, t.client_name, t.billable,
                   t.start_location, t.end_location, t.notes
            FROM trips t JOIN vehicles v ON t.vehicle_id=v.id
            WHERE " . implode(' AND ', $where) . "
            ORDER BY t.date ASC, t.id ASC
        ");
        $stmt->execute($params);
        $rows = $stmt->fetchAll();

        ob_clean();
        header('Content-Type: text/csv; charset=UTF-8');
        header('Content-Disposition: attachment; filename="mileage-log-' . $from . '-to-' . $to . '.csv"');

        $out = fopen('php://output', 'w');
        fputcsv($out, ['IRD Vehicle Logbook Export', 'Period: ' . $from . ' to ' . $to]);
        fputcsv($out, []);
        fputcsv($out, ['Date','Vehicle','Registration','Fuel Type','Start Odo (km)','End Odo (km)','Distance (km)','Trip Type','Business Purpose','Client','Billable','From','To','Notes']);
        foreach ($rows as $r) {
            fputcsv($out, [
                $r['date'], $r['vehicle'], $r['registration'] ?? '', $r['fuel_type'],
                $r['start_odometer'] ?? '', $r['end_odometer'] ?? '',
                number_format((float)$r['distance'], 1),
                ucfirst($r['trip_type']), $r['purpose'],
                $r['client_name'] ?? '', $r['billable'] ? 'Yes' : 'No',
                $r['start_location'] ?? '', $r['end_location'] ?? '',
                $r['notes'] ?? '',
            ]);
        }
        fclose($out);
        exit;
    }

    jsonResponse(['error' => 'Not found'], 404);
}

jsonResponse(['error' => 'Not found'], 404);
