jQuery(function ($) {
    function saveIntent(intent, cb) {
        $.post(calevidVars.ajaxUrl, { action: 'calevid_set_intent', intent: JSON.stringify(intent) }).done(cb);
    }

    function pay(amount) {
        PaystackPop.setup({
            key: calevidVars.paystackKey,
            email: calevidVars.email,
            amount: amount * 100,
            currency: "KES",
            callback: function (res) {
                $.post(calevidVars.ajaxUrl, { action: 'calevid_verify_payment', reference: res.reference })
                    .done(function (r) { if (r.success) location.reload(); else alert(r.data || 'Payment processing error'); });
            }
        }).openIframe();
    }

    $('#buy-credits-btn').on('click', function () {
        const qty = parseInt($('#credit-qty').val(), 10);
        saveIntent({ credits: qty }, () => pay(qty * calevidVars.creditPrice));
    });

    $('#calevid-generate-btn').on('click', function () {
        const prompt = $('#calevid-prompt').val().trim();
        if (!prompt) return alert('Enter prompt');

        $.post(calevidVars.ajaxUrl, { action: 'calevid_generate_video', prompt })
            .done(res => { if (res.status === 'success') $('#calevid-video-result').html(`<video src="${res.videoUrl}" controls autoplay></video>`); else alert(res.data || 'Video generation failed'); });
    });
});
