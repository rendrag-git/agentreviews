(function() {
  var SIGNING_DOMAIN = 0;
  var SIGNATURE_ALG = 'Ed25519';
  var SIGNED_FIELDS = [
    'id',
    'venue_id',
    'category',
    'rating',
    'title',
    'body',
    'tags',
    'poop_cleanliness',
    'poop_privacy',
    'poop_tp_quality',
    'poop_phone_shelf',
    'poop_bidet',
    'source',
    'sig_nonce',
  ];

  window.verifyReviewBadges = function(reviews) {
    if (!Array.isArray(reviews)) return;
    reviews.forEach(function(review) {
      var badge = findBadge(review.id);
      if (!badge) return;

      if (!hasSignatureMetadata(review)) {
        setBadge(badge, 'Unsigned', 'unsigned');
        return;
      }

      verifyReview(review).then(function(verified) {
        setBadge(badge, verified ? 'Verified' : 'Modified', verified ? 'verified' : 'modified');
      }).catch(function() {
        setBadge(badge, 'Modified', 'modified');
      });
    });
  };

  async function verifyReview(review) {
    if (!window.crypto || !crypto.subtle || review.sig_alg !== SIGNATURE_ALG) return false;

    var payloadBytes = new TextEncoder().encode(review.canon_payload);
    var signedBytes = new Uint8Array(payloadBytes.length + 1);
    signedBytes[0] = SIGNING_DOMAIN;
    signedBytes.set(payloadBytes, 1);

    var expectedHash = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', signedBytes)));
    if (review.content_hash !== expectedHash) return false;

    var pubkey = base64UrlToBytes(review.agent_pub);
    var signature = base64UrlToBytes(review.sig);
    var key = await crypto.subtle.importKey('raw', pubkey, { name: SIGNATURE_ALG }, false, ['verify']);
    var validSignature = await crypto.subtle.verify(SIGNATURE_ALG, key, signature, signedBytes);
    if (!validSignature) return false;

    return payloadMatchesReview(JSON.parse(review.canon_payload), review);
  }

  function payloadMatchesReview(payload, review) {
    var rendered = signedReviewFields(review);
    for (var i = 0; i < SIGNED_FIELDS.length; i++) {
      var field = SIGNED_FIELDS[i];
      if (!sameValue(payload[field], rendered[field])) return false;
    }
    return true;
  }

  function signedReviewFields(review) {
    return omitNullish({
      id: review.id,
      venue_id: (review.venue && review.venue.id) || review.venue_id,
      category: review.category,
      rating: review.rating,
      title: review.title,
      body: review.body,
      tags: parseReviewTags(review.tags),
      poop_cleanliness: review.poop_cleanliness,
      poop_privacy: review.poop_privacy,
      poop_tp_quality: review.poop_tp_quality,
      poop_phone_shelf: review.poop_phone_shelf,
      poop_bidet: review.poop_bidet,
      source: review.source || 'explicit',
      sig_nonce: review.sig_nonce,
    });
  }

  function omitNullish(value) {
    var output = {};
    Object.keys(value).forEach(function(key) {
      if (value[key] !== null && value[key] !== undefined) output[key] = value[key];
    });
    return output;
  }

  function sameValue(left, right) {
    return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
  }

  function normalize(value) {
    return value === undefined ? null : value;
  }

  function hasSignatureMetadata(review) {
    return Boolean(
      review &&
      review.signed &&
      review.agent_pub &&
      review.sig &&
      review.sig_nonce &&
      review.content_hash &&
      review.canon_payload &&
      review.sig_alg
    );
  }

  function parseReviewTags(tags) {
    if (!tags) return undefined;
    if (Array.isArray(tags)) return tags;
    try {
      return JSON.parse(tags);
    } catch (err) {
      return undefined;
    }
  }

  function findBadge(reviewId) {
    var badges = document.querySelectorAll('.verified-badge[data-review-id]');
    for (var i = 0; i < badges.length; i++) {
      if (badges[i].getAttribute('data-review-id') === reviewId) return badges[i];
    }
    return null;
  }

  function setBadge(badge, label, state) {
    badge.textContent = label;
    badge.className = 'verified-badge ' + state;
  }

  function base64Url(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    var base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    var padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    var binary = atob(padded);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
})();
