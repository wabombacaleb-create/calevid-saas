<?php
/**
 * Paystack verification endpoint (Render-safe)
 * No WP sessions, no frontend trust
 */

header('Content-Type: application/json');

// Only POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['status'=>'error','message'=>'Invalid request']);
    exit;
}

// Read JSON body
$data = json_decode(file_get_contents('php://input'), true);

if (empty($data['reference']) || empty($data['user_id'])) {
    echo json_encode(['status'=>'error','message'=>'Missing reference or user']);
    exit;
}

$reference = trim($data['reference']);
$user_id   = intval($data['user_id']);

// Load WordPress safely
require_once(__DIR__ . '/wp-load.php');

if (!$user_id || !get_user_by('ID', $user_id)) {
    echo json_encode(['status'=>'error','message'=>'Invalid user']);
    exit;
}

// Paystack secret
$secretKey = getenv('PAYSTACK_SECRET_KEY');
if (!$secretKey) {
    echo json_encode(['status'=>'error','message'=>'Server misconfigured']);
    exit;
}

// Verify transaction
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

if (!isset($paystack['status']) || $paystack['status'] !== true) {
    echo json_encode(['status'=>'error','message'=>'Verification failed']);
    exit;
}

if ($paystack['data']['status'] !== 'success') {
    echo json_encode(['status'=>'error','message'=>'Payment not successful']);
    exit;
}

// Prevent duplicate crediting
$tx_key = 'calevid_tx_' . $reference;
if (get_user_meta($user_id, $tx_key, true)) {
    echo json_encode(['status'=>'success','message'=>'Already processed']);
    exit;
}

// Get saved intent
$intent = get_user_meta($user_id, 'calevid_pending_purchase', true);

if (!$intent) {
    echo json_encode(['status'=>'error','message'=>'Missing purchase intent']);
    exit;
}

/* ======================
   APPLY PURCHASE
====================== */

if (!empty($intent['credits'])) {
    $current = (int) get_user_meta($user_id, 'calevid_credits', true);
    update_user_meta($user_id, 'calevid_credits', $current + (int)$intent['credits']);
}

if (!empty($intent['plan'])) {
    $plans = [
        'starter'  => 15,
        'standard' => 25,
        'pro'      => 50
    ];

    update_user_meta($user_id, 'calevid_plan', $intent['plan']);
    update_user_meta($user_id, 'calevid_limit', $plans[$intent['plan']]);
    update_user_meta($user_id, 'calevid_used', 0);
    update_user_meta($user_id, 'calevid_plan_start', time());
}

// Mark transaction
update_user_meta($user_id, $tx_key, time());
delete_user_meta($user_id, 'calevid_pending_purchase');

echo json_encode([
    'status'  => 'success',
    'message' => 'Payment applied successfully'
]);
exit;
