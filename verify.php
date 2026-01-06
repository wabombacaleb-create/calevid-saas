<?php
/**
 * Paystack payment verification endpoint
 * Secure version – NO hardcoded secrets
 */

// Load WordPress
require_once('../../../wp-load.php');

header('Content-Type: application/json');

// Only allow POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode([
        'status' => 'error',
        'message' => 'Invalid request method'
    ]);
    exit;
}

// Read JSON body
$rawInput = file_get_contents('php://input');
$data = json_decode($rawInput, true);

if (!is_array($data)) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Invalid JSON payload'
    ]);
    exit;
}

// Validate required fields
if (empty($data['reference']) || empty($data['credits'])) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Missing reference or credits'
    ]);
    exit;
}

$reference    = sanitize_text_field($data['reference']);
$creditsToAdd = intval($data['credits']);

if ($creditsToAdd <= 0) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Invalid credit amount'
    ]);
    exit;
}

// Get Paystack secret key from ENV (SECURE)
$secretKey = getenv('PAYSTACK_SECRET_KEY');

if (!$secretKey) {
    error_log('PAYSTACK_SECRET_KEY not set');
    echo json_encode([
        'status' => 'error',
        'message' => 'Server configuration error'
    ]);
    exit;
}

// Verify transaction with Paystack
$ch = curl_init();
curl_setopt_array($ch, [
    CURLOPT_URL            => "https://api.paystack.co/transaction/verify/" . urlencode($reference),
    CURLOPT_HTTPHEADER     => [
        "Authorization: Bearer {$secretKey}",
        "Content-Type: application/json"
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
]);

$response = curl_exec($ch);

if ($response === false) {
    $curlError = curl_error($ch);
    curl_close($ch);

    echo json_encode([
        'status' => 'error',
        'message' => 'Connection error',
        'details' => $curlError
    ]);
    exit;
}

curl_close($ch);

$paystackData = json_decode($response, true);

if (!isset($paystackData['status']) || $paystackData['status'] !== true) {
    echo json_encode([
        'status' => 'error',
        'message' => 'Transaction verification failed'
    ]);
    exit;
}

// Ensure payment was successful
if ($paystackData['data']['status'] !== 'success') {
    echo json_encode([
        'status' => 'error',
        'message' => 'Payment not successful'
    ]);
    exit;
}

// Ensure WordPress user is logged in
$current_user = wp_get_current_user();

if (!$current_user || $current_user->ID === 0) {
    echo json_encode([
        'status' => 'error',
        'message' => 'User not logged in'
    ]);
    exit;
}

// Prevent double crediting (VERY IMPORTANT)
$transactionRefKey = 'paystack_tx_' . $reference;
$alreadyProcessed  = get_user_meta($current_user->ID, $transactionRefKey, true);

if ($alreadyProcessed) {
    echo json_encode([
        'status'  => 'success',
        'message' => 'Transaction already processed'
    ]);
    exit;
}

// Update credits
$existingCredits = intval(get_user_meta($current_user->ID, 'video_credits', true));
$newCredits      = $existingCredits + $creditsToAdd;

update_user_meta($current_user->ID, 'video_credits', $newCredits);

// Mark transaction as processed
update_user_meta($current_user->ID, $transactionRefKey, time());

echo json_encode([
    'status'  => 'success',
    'message' => 'Payment verified and credits added',
    'credits' => $newCredits
]);

exit;
