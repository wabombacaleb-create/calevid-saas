<?php
/**
 * Calevid Paystack Verification Endpoint
 * Runs on Render
 * Single source of truth for payments
 */

header('Content-Type: application/json');

// Allow only POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode([
        'status' => 'error',
        'message' => 'Invalid request method'
    ]);
    exit;
}

// Read JSON body
$input = json_decode(file_get_contents('php://input'), true);

if (
    empty($input['reference']) ||
    empty($input['user_id'])
) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Missing payment reference or user'
    ]);
    exit;
}

$reference = trim($input['reference']);
$user_id   = (int) $input['user_id'];

// Load WordPress (adjust path if needed)
require_once __DIR__ . '/wp-load.php';

// Validate user
$user = get_user_by('ID', $user_id);
if (!$user) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Invalid user'
    ]);
    exit;
}

// Get Paystack secret key (LIVE)
$secretKey = getenv('PAYSTACK_SECRET_KEY');
if (!$secretKey) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Paystack secret key not configured'
    ]);
    exit;
}

// Verify transaction with Paystack
$ch = curl_init("https://api.paystack.co/transaction/verify/" . urlencode($reference));
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer {$secretKey}",
        "Content-Type: application/json"
    ],
]);

$response = curl_exec($ch);
curl_close($ch);

$paystack = json_decode($response, true);

if (
    !isset($paystack['status']) ||
    $paystack['status'] !== true ||
    $paystack['data']['status'] !== 'success'
) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Payment verification failed'
    ]);
    exit;
}

// Prevent duplicate processing
$tx_key = 'calevid_tx_' . $reference;
if (get_user_meta($user_id, $tx_key, true)) {
    echo json_encode([
        'status' => 'success',
        'message' => 'Transaction already processed'
    ]);
    exit;
}

// Retrieve saved purchase intent
$intent = get_user_meta($user_id, 'calevid_pending_purchase', true);
if (!$intent || !is_array($intent)) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Purchase intent missing'
    ]);
    exit;
}

/* ==========================
   APPLY PURCHASE
========================== */

// CREDIT PURCHASE
if (!empty($intent['credits'])) {
    $current = (int) get_user_meta($user_id, 'calevid_credits', true);
    update_user_meta(
        $user_id,
        'calevid_credits',
        $current + (int) $intent['credits']
    );
}

// PLAN PURCHASE
if (!empty($intent['plan'])) {

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

// Mark transaction as processed
update_user_meta($user_id, $tx_key, time());
delete_user_meta($user_id, 'calevid_pending_purchase');

// Success response
echo json_encode([
    'status'  => 'success',
    'message' => 'Payment verified and applied successfully'
]);
exit;
