<?php
// Route /api/* requests to api.php
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#/api\.php#', $uri) || preg_match('#/api/#', $uri)) {
    require __DIR__ . '/api.php';
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1a7f4b">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="MileageLog">
<meta name="description" content="Vehicle mileage logbook for NZ IRD record-keeping">
<title>MileageLog</title>
<link rel="manifest" href="manifest.json">
<link rel="apple-touch-icon" href="icon-192.php">
<link rel="stylesheet" href="assets/styles.css">
</head>
<body>
<div id="app">
  <div id="loading-screen">
    <div class="loading-logo">
      <svg viewBox="0 0 64 64" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#1a7f4b"/><path d="M20 38 L32 18 L44 38 Z" fill="white" opacity=".9"/><rect x="28" y="32" width="8" height="10" rx="1" fill="white" opacity=".7"/></svg>
      <p>MileageLog</p>
    </div>
  </div>
</div>

<script src="assets/app.js"></script>
<script>
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(console.warn);
}
</script>
</body>
</html>
