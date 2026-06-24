# MileageLog

> **AI-generated project disclaimer:** This application — including its code, documentation, and architecture — was generated and iterated on with the assistance of an AI coding assistant (Claude). It has not undergone independent professional security or accounting review. Treat it as a starting point: review the code yourself, verify IRD rate data and tax calculations with a qualified accountant, and test thoroughly before relying on it for real tax filings or production use.

Vehicle mileage logbook for NZ IRD record-keeping — PWA built with PHP + SQLite.

## Features

- **Designed around IRD logbook record-keeping requirements** — records date, vehicle, odometer, distance, business purpose, and trip type (business/private). Reports show the business-use percentage relevant to the IRD 90-day representative period, and estimate claimable deductions from configurable per-fuel-type IRD km rates (including the 14,000 km tier split). Always verify rates and totals with your accountant before filing.
- **Multi-user, multi-vehicle** — each user manages their own vehicles and trips. The first registered user becomes admin; admins can disable new registrations and manage IRD rates.
- **Start Trip / End Trip** — log the start of a trip (vehicle, purpose, client, start odometer/location) before you leave, then come back later to finish it off with the end odometer/location.
- **Invoice Ninja integration** — connect your own Invoice Ninja account (per user) and send billable trips straight to Invoice Ninja as expenses, pre-filled with the calculated IRD deduction.
- **Progressive Web App** — installable on iPhone/Android, works offline (trips queued in IndexedDB and synced when back online), with on-device caching for instant reloads and Android back-gesture support.
- **CSV export** — download a formatted spreadsheet for your accountant or an IRD audit.
- **Mobile-first** — designed for one-handed use on a phone.

## Requirements

- PHP 8.0+ with `pdo_sqlite` and `gd` extensions
- Apache with `mod_rewrite` (or Nginx — see below)
- Write permission on the `data/` directory

## Installation

1. Upload all files to your web server.
2. Ensure `data/` is writable by the web server:
   ```bash
   chmod 755 data/
   ```
3. Visit the site — the database is created automatically on first load.
4. Register an account and add your first vehicle.
5. On mobile, use **Add to Home Screen** to install as a PWA.

## Nginx config

```nginx
location /api/ {
    rewrite ^/api/(.*)$ /api.php/$1 last;
}
```

## IRD logbook requirements (NZ)

Per IRD guidelines, a vehicle logbook must record:
- Date of each trip
- Reason for travel (business purpose)
- Distance of each trip
- Start and end odometer readings (recommended but distance is sufficient)
- Business vs private distinction

After a **90-day representative period**, you can use the resulting business-use percentage for up to **three years** without keeping a full logbook. The Reports page shows the day count and flags when you've met the 90-day requirement.

## Security notes

- The `data/` directory is protected by `.htaccess` — the SQLite database cannot be downloaded directly.
- Passwords are hashed with `password_hash()` (bcrypt).
- All user input is parameterised via PDO prepared statements.
- For production, serve over HTTPS (required for GPS and PWA install).

## Invoice Ninja setup

Each user can connect their own Invoice Ninja account from the account menu (⚡ Invoice Ninja): enter your Invoice Ninja URL, API token (Settings → API Tokens in Invoice Ninja), and optionally a currency ID. From a billable business trip you can then create an expense in Invoice Ninja in one tap, pre-filled with the IRD-rate-based amount.

## File structure

```
index.php         Main entry point + HTML shell
api.php           REST API (auth, vehicles, trips, reports)
db.php            SQLite schema + PDO helper
sw.js             Service worker (offline caching)
manifest.json     PWA manifest
icon-192.php      PWA icon (192×192, GD-generated)
icon-512.php      PWA icon (512×512, GD-generated)
.htaccess         URL routing + security headers
assets/
  styles.css      Mobile-first CSS
  app.js          SPA frontend (vanilla JS)
data/
  .htaccess       Blocks direct DB access
  mileage.db      SQLite database (auto-created)
```
