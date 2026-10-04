'use strict';

// Deploy marker: 2026-10-03 — bumped to force a real redeploy and rebind secret versions.
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const crypto = require('crypto');
const admin = require('firebase-admin');
const Stripe = require('stripe');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1' });

const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = defineSecret('STRIPE_WEBHOOK_SECRET');

// Single one-time "Pro" unlock — price lives here, not on the client, so it can't be tampered with.
const PRO_PRICE_PLN_GROSZE = 5000; // 50,00 zł
// Allowed one-time "tip" amounts — fixed list so the client can never send an arbitrary amount.
const TIP_AMOUNTS_PLN_GROSZE = [500, 1000, 2000, 5000];
const SITE_URL = 'https://robienierobie.web.app';

exports.createCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    // Fix 2026-10-03: Checkout Sessions don't support automatic_payment_methods (removed).
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
      client_reference_id: uid,
      metadata: { uid },
      payment_intent_data: {
        statement_descriptor: 'NAWYKI PRO',
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'pln',
          unit_amount: PRO_PRICE_PLN_GROSZE,
          product_data: {
            name: 'Nawyki Pro — odblokowanie na zawsze',
            description: 'Synchronizacja w chmurze między urządzeniami dla aplikacji Nawyki',
          },
        },
      }],
      success_url: `${SITE_URL}/?pro=success`,
      cancel_url: `${SITE_URL}/?pro=cancel`,
    });

    return { url: session.url };
  }
);

// "Postaw kawę" — no login required, fixed set of amounts so the client can't tamper with price.
exports.createTipCheckoutSession = onCall(
  { secrets: [STRIPE_SECRET_KEY] },
  async (request) => {
    const amount = Number(request.data && request.data.amountGrosze);
    if (!TIP_AMOUNTS_PLN_GROSZE.includes(amount)) {
      throw new HttpsError('invalid-argument', 'Nieprawidłowa kwota napiwku.');
    }
    const stripe = Stripe(STRIPE_SECRET_KEY.value());

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      metadata: { type: 'tip' },
      payment_intent_data: {
        statement_descriptor: 'NAWYKI WSPARCIE',
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'pln',
          unit_amount: amount,
          product_data: {
            name: 'Napiwek dla aplikacji Nawyki ☕',
            description: 'Dobrowolne wsparcie rozwoju aplikacji — dziękujemy!',
          },
        },
      }],
      success_url: `${SITE_URL}/?tip=success`,
      cancel_url: `${SITE_URL}/?tip=cancel`,
    });

    return { url: session.url };
  }
);

// Alphabet avoids visually ambiguous characters (0/O, 1/I/L) — 32 symbols, evenly
// distributed over a byte (256 / 32), so `byte % 32` introduces no bias.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode() {
  const bytes = crypto.randomBytes(12); // ~60 bits of entropy — infeasible to brute-force
  let raw = '';
  for (const b of bytes) raw += CODE_ALPHABET[b % 32];
  return raw.match(/.{1,4}/g).join('-');
}

// Lets a signed-in user (including anonymous accounts) mint a bearer code that can later
// be redeemed on another device to sign back into the *same* account — no email/password needed.
exports.generateSyncCode = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Musisz być zalogowany, aby wygenerować kod.');
  }
  const uid = request.auth.uid;

  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateCode();
    const existing = await admin.firestore().doc(`syncCodes/${code}`).get();
    if (!existing.exists) break;
  }

  await admin.firestore().doc(`syncCodes/${code}`).set({
    uid,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { code };
});

// Exchanges a sync code for a custom auth token for the matching uid — this is how a new
// device "logs in" without any account, just by knowing the code.
exports.redeemSyncCode = onCall(async (request) => {
  const code = String((request.data && request.data.code) || '').trim().toUpperCase();
  if (!code) {
    throw new HttpsError('invalid-argument', 'Podaj kod.');
  }

  const snap = await admin.firestore().doc(`syncCodes/${code}`).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'Nieprawidłowy kod.');
  }

  const token = await admin.auth().createCustomToken(snap.data().uid);
  return { token };
});

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

      if (session.metadata && session.metadata.type === 'tip') {
        console.log('Tip received', session.id, session.amount_total);
      } else {
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
    }

    res.status(200).send('ok');
  }
);
