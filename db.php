<?php
define('DB_PATH', __DIR__ . '/data/mileage.db');

function getDb(): PDO {
    static $db = null;
    if ($db !== null) return $db;

    if (!in_array('sqlite', PDO::getAvailableDrivers())) {
        $avail = implode(', ', PDO::getAvailableDrivers()) ?: 'none';
        throw new RuntimeException(
            "SQLite PDO driver not available. Enable 'extension=pdo_sqlite' in php.ini. Available drivers: {$avail}"
        );
    }

    if (!is_dir(__DIR__ . '/data')) {
        mkdir(__DIR__ . '/data', 0755, true);
    }

    $db = new PDO('sqlite:' . DB_PATH);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA foreign_keys=ON');
    initSchema($db);
    return $db;
}

function columnExists(PDO $db, string $table, string $col): bool {
    foreach ($db->query("PRAGMA table_info({$table})")->fetchAll() as $row) {
        if ($row['name'] === $col) return true;
    }
    return false;
}

function initSchema(PDO $db): void {
    // ── Base tables ──────────────────────────────────────────────────────────
    $db->exec("
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    UNIQUE NOT NULL COLLATE NOCASE,
            email         TEXT,
            password_hash TEXT    NOT NULL,
            is_admin      INTEGER DEFAULT 0,
            created_at    TEXT    DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS vehicles (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL,
            name         TEXT    NOT NULL,
            registration TEXT,
            make         TEXT,
            model        TEXT,
            year         INTEGER,
            fuel_type    TEXT    DEFAULT 'petrol',
            is_active    INTEGER DEFAULT 1,
            created_at   TEXT    DEFAULT (datetime('now')),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS trips (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            vehicle_id      INTEGER NOT NULL,
            user_id         INTEGER NOT NULL,
            date            TEXT    NOT NULL,
            start_odometer  REAL,
            end_odometer    REAL,
            distance        REAL    NOT NULL,
            purpose         TEXT    NOT NULL,
            trip_type       TEXT    NOT NULL DEFAULT 'business',
            client_name     TEXT,
            billable        INTEGER DEFAULT 0,
            start_location  TEXT,
            end_location    TEXT,
            notes           TEXT,
            gps_track       TEXT,
            created_at      TEXT    DEFAULT (datetime('now')),
            updated_at      TEXT    DEFAULT (datetime('now')),
            FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS settings (
            key        TEXT PRIMARY KEY,
            value      TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS ird_rates (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            tax_year      INTEGER NOT NULL,
            fuel_type     TEXT    NOT NULL,
            rate_standard REAL    NOT NULL,
            rate_over14k  REAL    NOT NULL,
            notes         TEXT,
            UNIQUE(tax_year, fuel_type)
        );

        CREATE TABLE IF NOT EXISTS user_settings (
            user_id INTEGER NOT NULL,
            key     TEXT    NOT NULL,
            value   TEXT,
            PRIMARY KEY (user_id, key),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_trips_user_date ON trips(user_id, date);
        CREATE INDEX IF NOT EXISTS idx_trips_vehicle   ON trips(vehicle_id);
    ");

    // ── Incremental column migrations (safe to run on existing DBs) ──────────
    $colMigrations = [
        ['users',    'is_admin',       "ALTER TABLE users    ADD COLUMN is_admin      INTEGER DEFAULT 0"],
        ['vehicles', 'fuel_type',      "ALTER TABLE vehicles ADD COLUMN fuel_type     TEXT DEFAULT 'petrol'"],
        ['trips',    'client_name',    "ALTER TABLE trips    ADD COLUMN client_name   TEXT"],
        ['trips',    'billable',       "ALTER TABLE trips    ADD COLUMN billable       INTEGER DEFAULT 0"],
        ['trips',    'start_location', "ALTER TABLE trips    ADD COLUMN start_location TEXT"],
        ['trips',    'end_location',   "ALTER TABLE trips    ADD COLUMN end_location   TEXT"],
        ['trips',    'status',         "ALTER TABLE trips    ADD COLUMN status         TEXT DEFAULT 'completed'"],
    ];
    foreach ($colMigrations as [$table, $col, $sql]) {
        if (!columnExists($db, $table, $col)) {
            $db->exec($sql);
        }
    }

    // ── Promote first-ever user to admin if no admin exists ──────────────────
    $db->exec("
        UPDATE users SET is_admin = 1
        WHERE id = (SELECT MIN(id) FROM users)
          AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = 1)
    ");

    // ── Default settings ─────────────────────────────────────────────────────
    $db->exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('registrations_open', '1')");

    // ── Seed NZ IRD mileage rates if table is empty ──────────────────────────
    $count = (int)$db->query("SELECT COUNT(*) FROM ird_rates")->fetchColumn();
    if ($count === 0) {
        seedIrdRates($db);
    }
}

function seedIrdRates(PDO $db): void {
    // NZ tax year = April 1 (year-1) to March 31 (year)
    // Rates: https://www.ird.govt.nz/income-tax/income-tax-for-businesses-and-organisations/types-of-business-income/vehicle-expenses/kilometre-rates
    // Admin should verify and update these each year.
    $defaults = [
        // tax_year, fuel_type, rate_standard, rate_over14k
        [2024, 'petrol',  0.83, 0.31],
        [2024, 'diesel',  0.83, 0.31],
        [2024, 'hybrid',  0.83, 0.31],
        [2024, 'ev',      0.09, 0.09],
        [2025, 'petrol',  0.88, 0.31],
        [2025, 'diesel',  0.88, 0.31],
        [2025, 'hybrid',  0.88, 0.31],
        [2025, 'ev',      0.09, 0.09],
    ];
    $stmt = $db->prepare("INSERT OR IGNORE INTO ird_rates (tax_year, fuel_type, rate_standard, rate_over14k, notes) VALUES (?,?,?,?,?)");
    foreach ($defaults as [$y, $f, $r1, $r2]) {
        $stmt->execute([$y, $f, $r1, $r2, 'Default — verify at ird.govt.nz before use']);
    }
}

/** NZ tax year ending March: April–Dec of (year-1) → year; Jan–Mar of year → year */
function nzTaxYear(string $date): int {
    [$y, $m] = explode('-', $date);
    return (int)$m >= 4 ? (int)$y + 1 : (int)$y;
}
