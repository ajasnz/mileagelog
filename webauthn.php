<?php
/**
 * Passkey (WebAuthn) support — built on web-auth/webauthn-lib.
 *
 * SETUP REQUIRED before this works:
 *   1. `composer install` in the project root (adds vendor/, needed for every
 *      function below — api.php degrades gracefully with a clear error until
 *      this has been run, it does not fatal-error the rest of the app).
 *   2. The app must be served over HTTPS with a stable hostname — WebAuthn's
 *      origin/RP-ID check will reject requests over plain HTTP (localhost is
 *      exempted by browsers for local testing) or from a domain that doesn't
 *      match webauthnRpId() below.
 *
 * IMPORTANT: this integration could not be executed or tested in the
 * environment it was written in (no network-capable PHP/Composer available
 * there), unlike the rest of this codebase's changes. The web-auth/webauthn-lib
 * API has shifted across major versions; treat the exact method calls below as
 * a best-effort scaffold against the documented v4.7+ Server facade, and
 * verify against vendor/web-auth/webauthn-lib/README.md / your IDE's
 * autocomplete once composer install has actually resolved a version, before
 * relying on this for real accounts.
 */

require_once __DIR__ . '/db.php';

function webauthnAvailable(): bool {
    return file_exists(__DIR__ . '/vendor/autoload.php');
}

function webauthnRequireAvailable(): void {
    if (!webauthnAvailable()) {
        jsonResponse(['error' => 'Passkeys aren\'t set up on this server yet. Run `composer install` in the project root.'], 501);
    }
    require_once __DIR__ . '/vendor/autoload.php';
}

/** Relying Party ID must be the bare hostname the app is served from (no scheme/port). */
function webauthnRpId(): string {
    return parse_url('http://' . ($_SERVER['HTTP_HOST'] ?? 'localhost'), PHP_URL_HOST) ?: 'localhost';
}

function webauthnOrigin(): string {
    $scheme = !empty($_SERVER['HTTPS']) ? 'https' : 'http';
    return $scheme . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost');
}

/** SQLite-backed Webauthn\PublicKeyCredentialSourceRepository. */
function webauthnRepository(PDO $db): \Webauthn\PublicKeyCredentialSourceRepository {
    return new class($db) implements \Webauthn\PublicKeyCredentialSourceRepository {
        public function __construct(private PDO $db) {}

        public function findOneByCredentialId(string $publicKeyCredentialId): ?\Webauthn\PublicKeyCredentialSource {
            $stmt = $this->db->prepare('SELECT source_json FROM webauthn_credentials WHERE credential_id = ?');
            $stmt->execute([base64_encode($publicKeyCredentialId)]);
            $json = $stmt->fetchColumn();
            if (!$json) return null;
            return \Webauthn\PublicKeyCredentialSource::createFromArray(json_decode($json, true));
        }

        public function findAllForUserEntity(\Webauthn\PublicKeyCredentialUserEntity $userEntity): array {
            $stmt = $this->db->prepare('SELECT source_json FROM webauthn_credentials WHERE user_id = ?');
            $stmt->execute([(int)$userEntity->id]);
            $out = [];
            foreach ($stmt->fetchAll() as $row) {
                $out[] = \Webauthn\PublicKeyCredentialSource::createFromArray(json_decode($row['source_json'], true));
            }
            return $out;
        }

        public function saveCredentialSource(\Webauthn\PublicKeyCredentialSource $source): void {
            $credId = base64_encode($source->publicKeyCredentialId);
            $userId = (int)$source->userHandle;
            $json   = json_encode($source);
            $this->db->prepare(
                'INSERT INTO webauthn_credentials (user_id, credential_id, source_json, last_used_at)
                 VALUES (?,?,?,datetime(\'now\'))
                 ON CONFLICT(credential_id) DO UPDATE SET source_json = excluded.source_json, last_used_at = datetime(\'now\')'
            )->execute([$userId, $credId, $json]);
        }
    };
}

function webauthnServer(PDO $db): \Webauthn\Server {
    $rpEntity = new \Webauthn\PublicKeyCredentialRpEntity('MileageLog', webauthnRpId());
    return new \Webauthn\Server($rpEntity, webauthnRepository($db));
}

function webauthnUserEntity(array $user): \Webauthn\PublicKeyCredentialUserEntity {
    // `id` here is the WebAuthn user handle — kept as our numeric user id, string-encoded.
    return new \Webauthn\PublicKeyCredentialUserEntity($user['username'], (string)$user['id'], $user['username']);
}

/** Build a PSR-7 ServerRequest from the current request (needed for the library's origin check). */
function webauthnPsrRequest(): \Psr\Http\Message\ServerRequestInterface {
    $request = \GuzzleHttp\Psr7\ServerRequest::fromGlobals();
    $body    = file_get_contents('php://input');
    if ($body !== '' && $body !== false) {
        $request = $request->withBody(\GuzzleHttp\Psr7\Utils::streamFor($body));
    }
    return $request;
}
