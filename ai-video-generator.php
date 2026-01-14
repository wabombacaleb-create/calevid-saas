<?php
/*
Plugin Name: Calevid AI Video SaaS
Description: Production-ready integration with Node.js Paystack webhook
Version: 6.3.2
Author: Calevid
*/

if (!defined('ABSPATH')) exit;

/* =======================
   CONFIG (original layout restored)
======================= */
define('CALEVID_BACKEND', 'https://calevid-saas-8.onrender.com');
define('CALEVID_PAYSTACK_PUBLIC', getenv('PAYSTACK_PUBLIC_KEY') ?: 'pk_live_933395bd795d5fe25a99b8674a830422a68c959f');
define('CALEVID_CREDIT_PRICE', 150);

/* =======================
   ENQUEUE ASSETS
======================= */
add_action('wp_enqueue_scripts', function () {

    wp_enqueue_style(
        'calevid-css',
        plugin_dir_url(__FILE__) . 'assets/calevid.css',
        [],
        '6.3.2'
    );

    wp_enqueue_script(
        'paystack',
        'https://js.paystack.co/v1/inline.js',
        [],
        null,
        true
    );

    wp_enqueue_script(
        'calevid-js',
        plugin_dir_url(__FILE__) . 'assets/calevid.js',
        ['jquery', 'paystack'],
        '6.3.2',
        true
    );

    wp_localize_script('calevid-js', 'calevidVars', [
        'ajaxUrl'    => admin_url('admin-ajax.php'),
        'backendUrl' => CALEVID_BACKEND,
        'paystackKey'=> CALEVID_PAYSTACK_PUBLIC,
        'email'      => is_user_logged_in() ? wp_get_current_user()->user_email : '',
        'userId'     => is_user_logged_in() ? get_current_user_id() : 0,
        'creditPrice'=> CALEVID_CREDIT_PRICE
    ]);
});

/* =======================
   DASHBOARD SHORTCODE
======================= */
add_shortcode('calevid_dashboard', function () {

    if (!is_user_logged_in()) {
        return '
        <div class="calevid-auth-box">
            <h2>Welcome to Calevid AI 🎬</h2>
            <a class="calevid-btn" href="'.wp_login_url().'">Login</a>
            <a class="calevid-btn outline" href="'.wp_registration_url().'">Create Account</a>
            <a class="calevid-link" href="'.wp_lostpassword_url().'">Forgot password?</a>
        </div>';
    }

    $uid = get_current_user_id();
    $user = wp_get_current_user();
    $credits = (int) get_user_meta($uid, 'calevid_credits', true);

    ob_start(); ?>

<div class="calevid-dashboard">
<h2>Welcome, <?php echo esc_html($user->first_name ?: $user->user_login); ?> 👋</h2>

<p><strong>Credits:</strong> <?php echo $credits; ?></p>
<p><span style="color:#FF5722;"><strong>Note:</strong> 1 credit = 1 AI video generated</span></p>

<textarea id="calevid-prompt" rows="6" placeholder="Example: A 10-second cinematic animation of Nairobi at sunset"></textarea>
<button id="calevid-generate-btn">Generate Video</button>
<div id="calevid-video-result"></div>

<hr>

<h3>Buy Credits</h3>
<select id="credit-qty">
<?php for ($i=1; $i<=20; $i++): ?>
<option value="<?php echo $i; ?>">
<?php echo $i; ?> credit(s) – KSh <?php echo $i * CALEVID_CREDIT_PRICE; ?>
</option>
<?php endfor; ?>
</select>
<button id="buy-credits-btn">Buy Credits</button>

</div>

<?php
    return ob_get_clean();
});

/* =======================
   SAVE PURCHASE INTENT
======================= */
add_action('wp_ajax_calevid_set_intent', function () {

    if (!is_user_logged_in()) wp_send_json_error('Login required');

    $intent = json_decode(stripslashes($_POST['intent'] ?? ''), true);
    if (!$intent || !is_array($intent)) wp_send_json_error('Invalid intent');

    update_user_meta(get_current_user_id(), 'calevid_pending_purchase', $intent);
    wp_send_json_success();
});

/* =======================
   VERIFY PAYMENT
======================= */
add_action('wp_ajax_calevid_verify_payment', function () {

    if (!is_user_logged_in()) wp_send_json_error('Login required');

    $uid = get_current_user_id();
    $reference = sanitize_text_field($_POST['reference'] ?? '');
    if (!$reference) wp_send_json_error('Missing reference');

    $tx_key = 'calevid_tx_' . $reference;

    // Prevent duplicate processing
    if (get_user_meta($uid, $tx_key, true)) {
        wp_send_json_success('Payment already processed');
    } else {
        update_user_meta($uid, $tx_key, time());
    }

    wp_send_json_success('Payment pending credit application');
});

/* =======================
   GENERATE VIDEO
======================= */
add_action('wp_ajax_calevid_generate_video', function () {

    if (!is_user_logged_in()) wp_send_json_error('Login required');

    $prompt = sanitize_textarea_field($_POST['prompt'] ?? '');
    if (!$prompt) wp_send_json_error('Prompt required');

    $res = wp_remote_post(CALEVID_BACKEND . '/generate-video', [
        'headers' => ['Content-Type'=>'application/json'],
        'body' => json_encode(['prompt'=>$prompt]),
        'timeout' => 60
    ]);

    if (is_wp_error($res)) wp_send_json_error('Video generation failed');

    wp_send_json(json_decode(wp_remote_retrieve_body($res), true));
});
