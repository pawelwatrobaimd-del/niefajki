'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1' });

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

// Single one-time "Pro" unlock — price lives here, not on the client, so it can't be tampered with.
const PRO_PRICE_PLN_GROSZE = 5000; // 50,00 zł
const SITE_URL = 'https://niefajki.pl';

exports.createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Musisz być zalogowany, aby odblokować Pro.');
    }
    const uid = request.auth.uid;
    const stripe = Stripe(STRIPE_SECRET_KEY.value());

    // Already Pro? Don't let them pay twice.
    const entitlement = await admin.firestore().doc(`users/${uid}`).get();
    if (entitlement.exists && entitlement.data().pro === true) {
      throw new HttpsError('failed-precondition', 'To konto ma już odblokowaną wersję Pro.');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      automatic_payment_methods: { enabled: true },
      client_reference_id: uid,
      metadata: { uid },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'pln',
          unit_amount: PRO_PRICE_PLN_GROSZE,
          product_data: {
            name: 'Nawyki Pro — odblokowanie na zawsze',
            description: 'Synchronizacja w chmurze między urządzeniami dla aplikacji niefajki.pl',
          },
        },
      }],
      success_url: `${SITE_URL}/?pro=success`,
      cancel_url: `${SITE_URL}/?pro=cancel`,
    });

    return { url: session.url };
  }
);

exports.stripeWebhook = onRequest(
  { secrets: [STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET] },
  async (req, res) => {
    const stripe = Stripe(STRIPE_SECRET_KEY.value());
    const signature = req.headers['stripe-signature'];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.rawBody, signature, STRIPE_WEBHOOK_SECRET.value());
    } catch (err) {
      console.error('Webhook signature verification failed', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    const isPaidCheckout =
      event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded';

    if (isPaidCheckout) {
      const session = event.data.object;
      const uid = session.client_reference_id || (session.metadata && session.metadata.uid);
      const paid = session.payment_status === 'paid' || event.type === 'checkout.session.async_payment_succeeded';

      if (uid && paid) {
        await admin.firestore().doc(`users/${uid}`).set(
          {
            pro: true,
            proSince: admin.firestore.FieldValue.serverTimestamp(),
            stripeSessionId: session.id,
          },
          { merge: true }
        );
      } else {
        console.warn('Checkout completed without a resolvable uid or unpaid status', session.id);
      }
    }

    res.status(200).send('ok');
  }
);
