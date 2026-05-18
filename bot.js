const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const Stripe = require('stripe');

// ── Config (set these as environment variables on Render) ─────
const CONFIG = {
  BOT_TOKEN:        process.env.BOT_TOKEN,
  CLIENT_ID:        process.env.CLIENT_ID,
  SALES_CHANNEL_ID: process.env.SALES_CHANNEL_ID,
  STRIPE_SECRET_KEY:       process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET:   process.env.STRIPE_WEBHOOK_SECRET,
  PORT: process.env.PORT || 3000,
};
// ─────────────────────────────────────────────────────────────

const stripe = new Stripe(CONFIG.STRIPE_SECRET_KEY);
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();

// ── Stripe webhook MUST use raw body — set this up before express.json()
app.use('/webhook/stripe', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Slash Commands ────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('paymenthelp')
    .setDescription('Show info about the Payment Bot'),
  new SlashCommandBuilder()
    .setName('testpayment')
    .setDescription('Post a test payment notification to verify the bot is working'),
].map(c => c.toJSON());

// ── Discord Ready ─────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(CONFIG.BOT_TOKEN);
    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
});

// ── Slash Command Handler ─────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'paymenthelp') {
    const embed = new EmbedBuilder()
      .setColor(0x635BFF) // Stripe purple
      .setTitle('💳 Stripe Payment Bot')
      .setDescription('Automatically posts a notification here every time a payment comes through Stripe.')
      .addFields(
        { name: '🔗 Webhook URL', value: `\`https://YOUR-RENDER-URL.onrender.com/webhook/stripe\`` },
        { name: '📋 Commands', value: '`/paymenthelp` — This message\n`/testpayment` — Post a test notification' },
      )
      .setFooter({ text: 'Stripe Payment Bot' })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === 'testpayment') {
    await interaction.reply({ content: '🧪 Posting a test payment...', ephemeral: true });
    await postPaymentEmbed({
      customerName: 'Jane Smith',
      customerEmail: 'jane@example.com',
      amount: 4999,
      currency: 'usd',
      description: 'Premium Digital Download',
      paymentType: 'Digital Product',
      status: 'succeeded',
      receiptUrl: null,
      isTest: true,
    });
  }
});

// ── Stripe Webhook ────────────────────────────────────────────
app.post('/webhook/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, CONFIG.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle successful payments
  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    await handlePaymentIntent(pi);
  }

  // Handle successful invoice payments (subscriptions / invoices)
  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    await handleInvoice(invoice);
  }

  // Handle Stripe Checkout session completed (one-time purchases)
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await handleCheckoutSession(session);
  }

  res.json({ received: true });
});

// ── Payment Handlers ──────────────────────────────────────────

async function handleCheckoutSession(session) {
  // Checkout gives us the most info — prefer this for one-time purchases
  const data = {
    customerName:  session.customer_details?.name  || 'Unknown',
    customerEmail: session.customer_details?.email || 'Unknown',
    amount:        session.amount_total,
    currency:      session.currency,
    description:   session.metadata?.product_name || extractLineItems(session) || 'Purchase',
    paymentType:   session.mode === 'subscription' ? 'Subscription' : 'Digital Product / Service',
    status:        session.payment_status,
    receiptUrl:    null,
    isTest:        session.livemode === false,
  };
  await postPaymentEmbed(data);
}

async function handlePaymentIntent(pi) {
  // Look up customer info if available
  let customerName  = 'Unknown';
  let customerEmail = 'Unknown';

  if (pi.customer) {
    try {
      const customer = await stripe.customers.retrieve(pi.customer);
      customerName  = customer.name  || customerName;
      customerEmail = customer.email || customerEmail;
    } catch (_) {}
  }

  if (pi.receipt_email) customerEmail = pi.receipt_email;

  const data = {
    customerName,
    customerEmail,
    amount:      pi.amount,
    currency:    pi.currency,
    description: pi.description || pi.metadata?.product_name || 'Payment',
    paymentType: 'Service / Invoice',
    status:      pi.status,
    receiptUrl:  pi.charges?.data?.[0]?.receipt_url || null,
    isTest:      pi.livemode === false,
  };
  await postPaymentEmbed(data);
}

async function handleInvoice(invoice) {
  let customerName  = invoice.customer_name  || 'Unknown';
  let customerEmail = invoice.customer_email || 'Unknown';

  const data = {
    customerName,
    customerEmail,
    amount:      invoice.amount_paid,
    currency:    invoice.currency,
    description: invoice.lines?.data?.[0]?.description || invoice.metadata?.product_name || 'Invoice Payment',
    paymentType: invoice.subscription ? 'Subscription' : 'Invoice',
    status:      'succeeded',
    receiptUrl:  invoice.hosted_invoice_url || null,
    isTest:      invoice.livemode === false,
  };
  await postPaymentEmbed(data);
}

function extractLineItems(session) {
  // Checkout sessions don't embed line items inline — return null and let description fallback handle it
  return null;
}

// ── Build & Post Embed ────────────────────────────────────────
async function postPaymentEmbed(data) {
  const channel = await client.channels.fetch(CONFIG.SALES_CHANNEL_ID);
  if (!channel) throw new Error('Sales channel not found');

  const amount = formatAmount(data.amount, data.currency);
  const color  = data.status === 'succeeded' ? 0x57F287 : 0xFEE75C; // green or yellow

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(data.isTest ? '🧪 Test Payment Received' : '💰 Payment Received!')
    .addFields(
      { name: '👤 Customer',       value: data.customerName,  inline: true },
      { name: '📧 Email',          value: data.customerEmail, inline: true },
      { name: '💵 Amount',         value: amount,             inline: true },
      { name: '🛒 Product/Service',value: data.description,   inline: true },
      { name: '📦 Type',           value: data.paymentType,   inline: true },
      { name: '✅ Status',         value: capitalize(data.status), inline: true },
    );

  if (data.receiptUrl) {
    embed.addFields({ name: '🧾 Receipt', value: `[View Receipt](${data.receiptUrl})`, inline: false });
  }

  if (data.isTest) {
    embed.setFooter({ text: '⚠️ TEST MODE — This is not a real payment' });
  } else {
    embed.setFooter({ text: 'Stripe Payment Bot' });
  }

  embed.setTimestamp();

  await channel.send({ embeds: [embed] });
  console.log(`✅ Payment posted: ${data.customerName} — ${amount}`);
}

// ── Helpers ───────────────────────────────────────────────────
function formatAmount(amount, currency = 'usd') {
  if (!amount) return 'N/A';
  // Stripe amounts are in cents
  const dollars = amount / 100;
  return dollars.toLocaleString('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
  });
}

function capitalize(str) {
  if (!str) return 'N/A';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// ── Health Check ──────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// ── Start ─────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => console.log(`🚀 Server running on port ${CONFIG.PORT}`));
client.login(CONFIG.BOT_TOKEN);
