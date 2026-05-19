const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const Stripe = require('stripe');
const fs = require('fs');
 
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
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessages,
  ],
});
const app = express();
 
// ── Sales Tracking ────────────────────────────────────────────
const SALES_FILE = './sales.json';
const CLAIM_EMOJI = '💰';
 
function loadSales() {
  try {
    if (fs.existsSync(SALES_FILE)) {
      return JSON.parse(fs.readFileSync(SALES_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}
 
function saveSales(data) {
  try {
    fs.writeFileSync(SALES_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to save sales data:', err);
  }
}
 
// { userId: { count: 0, username: 'name' } }
let salesData = loadSales();
 
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
  new SlashCommandBuilder()
    .setName('revenue')
    .setDescription('Show total revenue from Stripe')
    .addStringOption(opt =>
      opt.setName('period')
        .setDescription('Time period')
        .setRequired(true)
        .addChoices(
          { name: 'Today', value: 'day' },
          { name: 'This Week', value: 'week' },
          { name: 'This Month', value: 'month' },
        )),
  new SlashCommandBuilder()
    .setName('lastpayment')
    .setDescription('Show the most recent payment received'),
  new SlashCommandBuilder()
    .setName('paymentstats')
    .setDescription('Show total number of payments and revenue for this month'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Show who has claimed the most sales with 💰'),
  new SlashCommandBuilder()
    .setName('mysales')
    .setDescription('Show how many sales you have claimed'),
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
 
// ── Reaction Tracking ─────────────────────────────────────────
client.on('messageReactionAdd', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== CLAIM_EMOJI) return;
  if (reaction.message.channelId !== CONFIG.SALES_CHANNEL_ID) return;
 
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (!message.author.bot) return;
 
  const userId = user.id;
  const username = user.username;
 
  if (!salesData[userId]) salesData[userId] = { count: 0, username };
  salesData[userId].count += 1;
  salesData[userId].username = username;
  saveSales(salesData);
 
  console.log(`💰 ${username} claimed a sale — total: ${salesData[userId].count}`);
});
 
client.on('messageReactionRemove', async (reaction, user) => {
  if (user.bot) return;
  if (reaction.emoji.name !== CLAIM_EMOJI) return;
  if (reaction.message.channelId !== CONFIG.SALES_CHANNEL_ID) return;
 
  const message = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
  if (!message.author.bot) return;
 
  const userId = user.id;
  if (salesData[userId] && salesData[userId].count > 0) {
    salesData[userId].count -= 1;
    saveSales(salesData);
    console.log(`💰 ${user.username} removed a sale claim — total: ${salesData[userId].count}`);
  }
});
 
// ── Slash Command Handler ─────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
 
  // ── /paymenthelp ──────────────────────────────────────────
  if (interaction.commandName === 'paymenthelp') {
    const embed = new EmbedBuilder()
      .setColor(0x635BFF)
      .setTitle('💳 Stripe Payment Bot')
      .setDescription('Automatically posts a notification here every time a payment comes through Stripe.')
      .addFields(
        { name: '🔗 Webhook URL', value: '`https://discord-bot-2-1-4jey.onrender.com/webhook/stripe`' },
        { name: '📋 Commands', value: '`/paymenthelp` — This message\n`/testpayment` — Post a test notification\n`/revenue` — Show revenue by period\n`/lastpayment` — Show most recent payment\n`/paymentstats` — Show this month\'s stats\n`/leaderboard` — Show sales leaderboard\n`/mysales` — Show your claimed sales' },
        { name: '💰 Claiming Sales', value: 'React with 💰 on any payment notification to claim that sale. Your count appears on the leaderboard!' },
      )
      .setFooter({ text: 'Stripe Payment Bot' })
      .setTimestamp();
    await interaction.reply({ embeds: [embed], flags: 64 });
  }
 
  // ── /testpayment ──────────────────────────────────────────
  if (interaction.commandName === 'testpayment') {
    await interaction.reply({ content: '🧪 Posting a test payment...', flags: 64 });
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
 
  // ── /revenue ──────────────────────────────────────────────
  if (interaction.commandName === 'revenue') {
    await interaction.deferReply({ flags: 64 });
    try {
      const period = interaction.options.getString('period');
      const now = Math.floor(Date.now() / 1000);
      let start, label;
      if (period === 'day')       { start = now - 86400;   label = 'Today'; }
      else if (period === 'week') { start = now - 604800;  label = 'This Week'; }
      else                        { start = now - 2592000; label = 'This Month'; }
 
      const paymentIntents = await stripe.paymentIntents.list({ created: { gte: start }, limit: 100 });
      const succeeded = paymentIntents.data.filter(p => p.status === 'succeeded');
      const total = succeeded.reduce((sum, p) => sum + p.amount, 0);
 
      const embed = new EmbedBuilder()
        .setColor(0x635BFF)
        .setTitle(`💰 Revenue — ${label}`)
        .addFields(
          { name: '💵 Total Revenue', value: formatAmount(total, 'usd'), inline: true },
          { name: '🧾 Payments',      value: `${succeeded.length}`,      inline: true },
        )
        .setFooter({ text: 'Stripe Payment Bot' })
        .setTimestamp();
 
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Revenue error:', err);
      await interaction.editReply({ content: '❌ Failed to fetch revenue from Stripe.' });
    }
  }
 
  // ── /lastpayment ──────────────────────────────────────────
  if (interaction.commandName === 'lastpayment') {
    await interaction.deferReply({ flags: 64 });
    try {
      const paymentIntents = await stripe.paymentIntents.list({ limit: 10 });
      const last = paymentIntents.data.find(p => p.status === 'succeeded');
      if (!last) return await interaction.editReply({ content: '❌ No successful payments found.' });
 
      let customerName = 'Unknown', customerEmail = 'Unknown';
      if (last.customer) {
        try {
          const customer = await stripe.customers.retrieve(last.customer);
          customerName  = customer.name  || customerName;
          customerEmail = customer.email || customerEmail;
        } catch (_) {}
      }
      if (last.receipt_email) customerEmail = last.receipt_email;
 
      const embed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('🕐 Last Payment')
        .addFields(
          { name: '👤 Customer', value: customerName,                                          inline: true },
          { name: '📧 Email',    value: customerEmail,                                         inline: true },
          { name: '💵 Amount',   value: formatAmount(last.amount, last.currency),              inline: true },
          { name: '📝 Description', value: last.description || 'N/A',                         inline: true },
          { name: '✅ Status',   value: capitalize(last.status),                               inline: true },
          { name: '📅 Date',     value: new Date(last.created * 1000).toLocaleString('en-US'), inline: true },
        )
        .setFooter({ text: 'Stripe Payment Bot' })
        .setTimestamp();
 
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Last payment error:', err);
      await interaction.editReply({ content: '❌ Failed to fetch last payment from Stripe.' });
    }
  }
 
  // ── /paymentstats ─────────────────────────────────────────
  if (interaction.commandName === 'paymentstats') {
    await interaction.deferReply({ flags: 64 });
    try {
      const now = Math.floor(Date.now() / 1000);
      const paymentIntents = await stripe.paymentIntents.list({ created: { gte: now - 2592000 }, limit: 100 });
      const succeeded = paymentIntents.data.filter(p => p.status === 'succeeded');
      const failed    = paymentIntents.data.filter(p => p.status === 'canceled' || p.status === 'requires_payment_method');
      const total = succeeded.reduce((sum, p) => sum + p.amount, 0);
      const avg   = succeeded.length > 0 ? Math.floor(total / succeeded.length) : 0;
 
      const embed = new EmbedBuilder()
        .setColor(0x635BFF)
        .setTitle('📊 Payment Stats — Last 30 Days')
        .addFields(
          { name: '💵 Total Revenue', value: formatAmount(total, 'usd'), inline: true },
          { name: '✅ Successful',     value: `${succeeded.length}`,     inline: true },
          { name: '❌ Failed',         value: `${failed.length}`,        inline: true },
          { name: '📈 Avg Payment',    value: formatAmount(avg, 'usd'),  inline: true },
        )
        .setFooter({ text: 'Stripe Payment Bot' })
        .setTimestamp();
 
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('Stats error:', err);
      await interaction.editReply({ content: '❌ Failed to fetch stats from Stripe.' });
    }
  }
 
  // ── /leaderboard ──────────────────────────────────────────
  if (interaction.commandName === 'leaderboard') {
    const sorted = Object.entries(salesData)
      .filter(([, v]) => v.count > 0)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);
 
    if (sorted.length === 0) {
      return await interaction.reply({ content: '💰 No sales claimed yet! React with 💰 on a payment notification to claim a sale.', flags: 64 });
    }
 
    const medals = ['🥇', '🥈', '🥉'];
    const board = sorted.map(([, v], i) => {
      const medal = medals[i] || `${i + 1}.`;
      return `${medal} **${v.username}** — ${v.count} sale${v.count !== 1 ? 's' : ''}`;
    }).join('\n');
 
    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('💰 Sales Leaderboard')
      .setDescription(board)
      .setFooter({ text: 'React with 💰 on payment notifications to claim sales!' })
      .setTimestamp();
 
    await interaction.reply({ embeds: [embed], flags: 64 });
  }
 
  // ── /mysales ──────────────────────────────────────────────
  if (interaction.commandName === 'mysales') {
    const userId = interaction.user.id;
    const count  = salesData[userId]?.count || 0;
 
    const embed = new EmbedBuilder()
      .setColor(0x635BFF)
      .setTitle('💰 Your Sales')
      .setDescription(`You have claimed **${count} sale${count !== 1 ? 's' : ''}**!`)
      .setFooter({ text: 'React with 💰 on payment notifications to claim sales!' })
      .setTimestamp();
 
    await interaction.reply({ embeds: [embed], flags: 64 });
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
 
  if (event.type === 'payment_intent.succeeded')    await handlePaymentIntent(event.data.object);
  if (event.type === 'invoice.payment_succeeded')   await handleInvoice(event.data.object);
  if (event.type === 'checkout.session.completed')  await handleCheckoutSession(event.data.object);
 
  res.json({ received: true });
});
 
// ── Payment Handlers ──────────────────────────────────────────
async function handleCheckoutSession(session) {
  await postPaymentEmbed({
    customerName:  session.customer_details?.name  || 'Unknown',
    customerEmail: session.customer_details?.email || 'Unknown',
    amount:        session.amount_total,
    currency:      session.currency,
    description:   session.metadata?.product_name || 'Purchase',
    paymentType:   session.mode === 'subscription' ? 'Subscription' : 'Digital Product / Service',
    status:        session.payment_status,
    receiptUrl:    null,
    isTest:        session.livemode === false,
  });
}
 
async function handlePaymentIntent(pi) {
  let customerName = 'Unknown', customerEmail = 'Unknown';
  if (pi.customer) {
    try {
      const customer = await stripe.customers.retrieve(pi.customer);
      customerName  = customer.name  || customerName;
      customerEmail = customer.email || customerEmail;
    } catch (_) {}
  }
  if (pi.receipt_email) customerEmail = pi.receipt_email;
 
  await postPaymentEmbed({
    customerName,
    customerEmail,
    amount:      pi.amount,
    currency:    pi.currency,
    description: pi.description || pi.metadata?.product_name || 'Payment',
    paymentType: 'Service / Invoice',
    status:      pi.status,
    receiptUrl:  pi.charges?.data?.[0]?.receipt_url || null,
    isTest:      pi.livemode === false,
  });
}
 
async function handleInvoice(invoice) {
  await postPaymentEmbed({
    customerName:  invoice.customer_name  || 'Unknown',
    customerEmail: invoice.customer_email || 'Unknown',
    amount:        invoice.amount_paid,
    currency:      invoice.currency,
    description:   invoice.lines?.data?.[0]?.description || invoice.metadata?.product_name || 'Invoice Payment',
    paymentType:   invoice.subscription ? 'Subscription' : 'Invoice',
    status:        'succeeded',
    receiptUrl:    invoice.hosted_invoice_url || null,
    isTest:        invoice.livemode === false,
  });
}
 
// ── Build & Post Embed ────────────────────────────────────────
async function postPaymentEmbed(data) {
  const channel = await client.channels.fetch(CONFIG.SALES_CHANNEL_ID);
  if (!channel) throw new Error('Sales channel not found');
 
  const amount = formatAmount(data.amount, data.currency);
  const embed = new EmbedBuilder()
    .setColor(data.status === 'succeeded' ? 0x57F287 : 0xFEE75C)
    .setTitle(data.isTest ? '🧪 Test Payment Received' : '💰 Payment Received!')
    .addFields(
      { name: '👤 Customer',        value: data.customerName,       inline: true },
      { name: '📧 Email',           value: data.customerEmail,      inline: true },
      { name: '💵 Amount',          value: amount,                  inline: true },
      { name: '🛒 Product/Service', value: data.description,        inline: true },
      { name: '📦 Type',            value: data.paymentType,        inline: true },
      { name: '✅ Status',          value: capitalize(data.status), inline: true },
    )
    .setFooter({ text: data.isTest ? '⚠️ TEST MODE — This is not a real payment' : 'React with 💰 to claim this sale!' })
    .setTimestamp();
 
  if (data.receiptUrl) {
    embed.addFields({ name: '🧾 Receipt', value: `[View Receipt](${data.receiptUrl})`, inline: false });
  }
 
  const message = await channel.send({ embeds: [embed] });
  await message.react('💰');
  console.log(`✅ Payment posted: ${data.customerName} — ${amount}`);
}
 
// ── Helpers ───────────────────────────────────────────────────
function formatAmount(amount, currency = 'usd') {
  if (!amount) return 'N/A';
  return (amount / 100).toLocaleString('en-US', { style: 'currency', currency: currency.toUpperCase() });
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
 
