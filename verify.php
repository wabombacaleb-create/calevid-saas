<?php
/**
 * CALEVID – PAYSTACK PAYMENT VERIFICATION
 * FINAL PRODUCTION VERSION
 * 1 Credit = KSh 150
 */

declare(strict_types=1);
header('Content-Type: application/json');

/* =========================
   BASIC REQUEST VALIDATION
   ========================= */

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['status' => 'error', 'message' => 'Invalid request method']);
    exit;
}

$rawInput = file_get_contents('php://input');
$input = json_decode($rawInput, true);

if (!is_array($input)) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Invalid JSON payload']);
    exit;
}

if (empty($input['reference']) || empty($input['user_id'])) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Missing reference or user']);
    exit;
}

$reference = trim((string)$input['reference']);
$user_id   = (int)$input['user_id'];

/* =========================
   LOAD WORDPRESS
   ========================= */

require_once __DIR__ . '/wp-load.php';

/* =========================
   USER VALIDATION
   ========================= */

$user = get_user_by('ID', $user_id);
if (!$user) {
    http_response_code(404);
    echo json_encode(['status' => 'error', 'message' => 'Invalid user']);
    exit;
}

/* =========================
   PAYSTACK CONFIG
   ========================= */

$secretKey = getenv('PAYSTACK_SECRET_KEY');
if (!$secretKey) {
    error_log('PAYSTACK_SECRET_KEY missing');
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'Server misconfigured']);
    exit;
}

/* =========================
   VERIFY WITH PAYSTACK
   ========================= */

$ch = curl_init("https://api.paystack.co/transaction/verify/" . urlencode($reference));
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer {$secretKey}",
        "Content-Type: application/json"
    ],
]);

$response = curl_exec($ch);

if ($response === false) {
    error_log('Paystack cURL error: ' . curl_error($ch));
    curl_close($ch);
    http_response_code(502);
    echo json_encode(['status' => 'error', 'message' => 'Payment gateway unreachable']);
    exit;
}

curl_close($ch);

$paystack = json_decode($response, true);

/* Log raw response (safe & invaluable) */
file_put_contents(
    __DIR__ . '/paystack_verify.log',
    date('c') . PHP_EOL . json_encode($paystack, JSON_PRETTY_PRINT) . PHP_EOL . PHP_EOL,
    FILE_APPEND
);

/* =========================
   PAYSTACK RESPONSE VALIDATION
   ========================= */

if (
    empty($paystack['status']) ||
    $paystack['status'] !== true ||
    empty($paystack['data']) ||
    $paystack['data']['status'] !== 'success'
) {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Payment verification failed']);
    exit;
}

/* =========================
   DUPLICATE TRANSACTION GUARD
   ========================= */

$tx_key = 'calevid_tx_' . $reference;
if (get_user_meta($user_id, $tx_key, true)) {
    echo json_encode([
        'status' => 'success',
        'message' => 'Payment already processed'
    ]);
    exit;
}

/* =========================
   PAYMENT TRUTH (PAYSTACK)
   ========================= */

$amountKobo = (int)$paystack['data']['amount']; // Paystack uses kobo
$amountKes  = $amountKobo / 100;

/* BUSINESS RULE */
define('CREDIT_PRICE_KES', 150);

/* Calculate credits */
$creditsToAdd = (int)floor($amountKes / CREDIT_PRICE_KES);

if ($creditsToAdd <= 0) {
    error_log("Payment too low: {$amountKes} KSh for user {$user_id}");
    http_response_code(400);
    echo json_encode([
        'status' => 'error',
        'message' => 'Payment amount insufficient for credits'
    ]);
    exit;
}

/* =========================
   APPLY CREDITS (ATOMIC)
   ========================= */

$currentCredits = (int)get_user_meta($user_id, 'calevid_credits', true);
$newBalance = $currentCredits + $creditsToAdd;

update_user_meta($user_id, 'calevid_credits', $newBalance);

/* =========================
   OPTIONAL PLAN HANDLING
   ========================= */

$intent = get_user_meta($user_id, 'calevid_pending_purchase', true);

if (is_array($intent) && !empty($intent['plan'])) {
    $plans = [
        'starter'  => 15,
        'standard' => 25,
        'pro'      => 50
    ];

    if (isset($plans[$intent['plan']])) {
        update_user_meta($user_id, 'calevid_plan', $intent['plan']);
        update_user_meta($user_id, 'calevid_limit', $plans[$intent['plan']]);
        update_user_meta($user_id, 'calevid_used', 0);
        update_user_meta($user_id, 'calevid_plan_start', time());
    }
}

/* =========================
   LOCK TRANSACTION
   ========================= */

update_user_meta($user_id, $tx_key, [
    'time' => time(),
    'amount_kes' => $amountKes,
    'credits_added' => $creditsToAdd
]);

delete_user_meta($user_id, 'calevid_pending_purchase');

/* =========================
   SUCCESS RESPONSE
   ========================= */

echo json_encode([
    'status' => 'success',
    'message' => 'Payment verified and credits applied',
    'credits_added' => $creditsToAdd,
    'new_balance' => $newBalance
]);
exit;
