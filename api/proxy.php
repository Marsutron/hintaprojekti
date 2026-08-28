<?php
// Yksinkertainen PHP-proxy, joka hakee hinnat porssisahko.net API:sta
// ja välittää vastauksen sellaisenaan selaimelle.

declare(strict_types=1);

// URL josta data haetaan
$upstreamUrl = 'https://api.porssisahko.net/v1/latest-prices.json';

// Asetetaan perusotsikot
header('Content-Type: application/json; charset=utf-8');
header('Access-Control-Allow-Origin: *');

$ch = curl_init($upstreamUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HEADER, false);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);

$result = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($result === false || $httpCode < 200 || $httpCode >= 300) {
    http_response_code($httpCode > 0 ? $httpCode : 502);
    echo json_encode([
        'error' => 'Upstream request failed',
        'status' => $httpCode,
        'curl_error' => $curlError,
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

http_response_code($httpCode);
echo $result;

